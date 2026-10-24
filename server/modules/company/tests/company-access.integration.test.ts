import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, companyDb, getConnection, initializeDatabase, resourceAccessDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { companyService } from '../company.service.js';
import { skillExportService } from '../skill-export.service.js';
import { companySkillsService } from '../skills-library.service.js';
import { AppError, withAccessActor, withoutGeneratedSkillContext } from '@/shared/utils.js';
import type { AccessActor, NormalizedMessage } from '@/shared/types.js';
import { broadcastSessionUpserted, chatRunRegistry, connectedClients, handleChatConnection } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import { getAccessActor } from '@/shared/utils.js';

async function fixture(operation: (actors: AccessActor[], workspace: string) => Promise<void> | void) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'company-access-'));
  const previous = process.env.DATABASE_PATH;
  closeConnection(); process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  const actors = ['admin', 'owner', 'colleague', 'other'].map((name, index) => {
    const role = index === 0 ? 'admin' as const : 'member' as const;
    const user = userDb.createUser(name, 'hash', role);
    return { id: Number(user.id), role };
  });
  try { await operation(actors, directory); }
  finally {
    connectedClients.clear(); chatRunRegistry.clearAll();
    closeConnection(); if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

test('new chats are private; department and company sharing grant and revoke every repository read', async () => {
  await fixture(async ([admin, owner, colleague, other], workspace) => {
    const department = withAccessActor(admin, () => companyService.createDepartment({ name: 'Engineering' }).id);
    withAccessActor(admin, () => companyService.updateDepartment(department, { name: 'Engineering', memberIds: [owner.id, colleague.id] }));
    withAccessActor(owner, () => sessionsDb.createAppSession('personal-chat', 'claude', workspace, 'Private title'));
    sessionsDb.assignProviderSessionId('personal-chat', 'native-private');
    withAccessActor(colleague, () => {
      assert.equal(sessionsDb.getSessionById('personal-chat'), null);
      assert.equal(sessionsDb.getSessionByProviderSessionId('native-private'), null);
      assert.equal(sessionsDb.getAllSessions().length, 0);
      assert.equal(sessionsDb.getRecentSessionsPage(20, 0).total, 0);
      assert.equal(sessionsDb.countSessionsByProjectPath(workspace), 0);
      assert.equal(sessionsDb.getSessionsByProjectPathPage(workspace, 20, 0).length, 0);
    });
    withAccessActor(owner, () => companyService.updateChatSharing('personal-chat', { visibility: 'departments', departmentIds: [department] }));
    withAccessActor(colleague, () => {
      assert.equal(sessionsDb.getSessionById('personal-chat')?.owner_user_id, owner.id);
      assert.equal(sessionsDb.getRecentSessionsPage(20, 0).total, 1);
      assert.throws(() => companyService.updateChatSharing('personal-chat', { visibility: 'company' }), (error: unknown) => error instanceof AppError && error.code === 'CHAT_OWNER_REQUIRED');
      assert.throws(() => sessionsDb.updateSessionCustomName('personal-chat', 'Changed by reader'), (error: unknown) => error instanceof AppError && error.statusCode === 403);
    });
    withAccessActor(other, () => assert.equal(sessionsDb.getSessionById('personal-chat'), null));
    withAccessActor(admin, () => companyService.updateDepartment(department, { name: 'Engineering', memberIds: [owner.id] }));
    withAccessActor(colleague, () => assert.equal(sessionsDb.getSessionById('personal-chat'), null));
    withAccessActor(owner, () => companyService.updateChatSharing('personal-chat', { visibility: 'company' }));
    withAccessActor(other, () => assert.ok(sessionsDb.getSessionById('personal-chat')));
    withAccessActor(owner, () => companyService.updateChatSharing('personal-chat', { visibility: 'private' }));
    withAccessActor(other, () => assert.equal(sessionsDb.getSessionById('personal-chat'), null));
    withAccessActor(admin, () => assert.equal(sessionsDb.getSessionById('personal-chat'), null));
  });
});

test('websocket discovery, replay, shared continuation and stream revocation follow chat access', async () => {
  await fixture(async ([admin, owner, colleague, other], workspace) => {
    const sessionId = randomUUID();
    withAccessActor(owner, () => sessionsDb.createAppSession(sessionId, 'claude', workspace, 'PRIVATE_WS_TITLE'));
    const sockets = [owner, colleague, other].map((actor) => {
      const socket = new EventEmitter() as EventEmitter & { readyState: number; frames: Record<string, unknown>[]; send(data: string): void };
      socket.readyState = 1; socket.frames = [];
      socket.send = (data) => socket.frames.push(JSON.parse(data));
      return { socket, actor };
    });
    const runs: number[] = [];
    let writer: Parameters<ProviderRuntimeGateway['run']>[3] | undefined;
    let release: (() => void) | undefined;
    let aborts = 0;
    const runtime = {
      hasRuntime: () => true,
      run: async (_provider: string, _command: string, _options: unknown, output: Parameters<ProviderRuntimeGateway['run']>[3]) => {
        runs.push(getAccessActor()!.id); writer = output;
        await new Promise<void>((resolve) => { release = resolve; });
      },
      abort: async () => { aborts += 1; return true; },
      hasBackgroundWork: () => false,
      getPendingApprovalsForSession: () => [],
    } as unknown as ProviderRuntimeGateway;
    for (const { socket, actor } of sockets) handleChatConnection(socket as never, { user: actor } as never, { runtime });
    await broadcastSessionUpserted(sessionId);
    assert.equal(sockets[0].socket.frames.some((frame) => frame.kind === 'session_upserted'), true);
    assert.equal(sockets[1].socket.frames.length, 0);
    assert.equal(sockets[2].socket.frames.length, 0);
    sockets[1].socket.emit('message', JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId }] }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(sockets[1].socket.frames.at(-1)?.code, 'SESSION_NOT_FOUND');

    const department = withAccessActor(admin, () => companyService.createDepartment({ name: 'Team' }).id);
    withAccessActor(admin, () => companyService.updateDepartment(department, { name: 'Team', memberIds: [owner.id, colleague.id] }));
    withAccessActor(owner, () => companyService.updateChatSharing(sessionId, { visibility: 'departments', departmentIds: [department] }));
    sockets[1].socket.emit('message', JSON.stringify({ type: 'chat.send', sessionId, content: 'Continue shared chat' }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(runs, [colleague.id]);
    assert.equal(sessionsDb.getSessionById(sessionId)?.owner_user_id, owner.id);
    sockets[0].socket.emit('message', JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId }] }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    withAccessActor(owner, () => companyService.updateChatSharing(sessionId, { visibility: 'private' }));
    writer!.send({ kind: 'text', provider: 'claude', role: 'assistant', sessionId, content: 'PRIVATE_STREAM_MARKER' });
    assert.equal(sockets[0].socket.frames.some((frame) => frame.content === 'PRIVATE_STREAM_MARKER'), true);
    assert.equal(sockets[1].socket.frames.some((frame) => frame.content === 'PRIVATE_STREAM_MARKER'), false);
    assert.equal(sockets[2].socket.frames.some((frame) => frame.content === 'PRIVATE_STREAM_MARKER'), false);
    sockets[1].socket.emit('message', JSON.stringify({ type: 'chat.abort', sessionId }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(aborts, 0);
    assert.equal(sockets[1].socket.frames.at(-1)?.code, 'SESSION_NOT_FOUND');
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
});

test('a user can belong to several departments and only share chats with their own departments', async () => {
  await fixture(([admin, owner, colleague], workspace) => {
    const ids = withAccessActor(admin, () => ['Engineering', 'Finance', 'Legal'].map((name) => companyService.createDepartment({ name }).id));
    withAccessActor(admin, () => {
      companyService.updateDepartment(ids[0], { name: 'Engineering', memberIds: [owner.id] });
      companyService.updateDepartment(ids[1], { name: 'Finance', memberIds: [owner.id, colleague.id] });
    });
    assert.deepEqual(companyDb.ownDepartmentIds(owner.id), ids.slice(0, 2));
    withAccessActor(owner, () => {
      sessionsDb.createAppSession('multi-department', 'codex', workspace);
      companyService.updateChatSharing('multi-department', { visibility: 'departments', departmentIds: ids.slice(0, 2) });
      assert.throws(() => companyService.updateChatSharing('multi-department', { visibility: 'departments', departmentIds: [ids[2]] }), (error: unknown) => error instanceof AppError && error.statusCode === 400);
    });
    withAccessActor(colleague, () => assert.ok(sessionsDb.getSessionById('multi-department')));
  });
});

test('skill access controls reading, editing, supporting paths and shared-chat runtime availability', async () => {
  const exportedSkillIds: string[] = [];
  try {
    await fixture(async ([admin, owner, colleague, other], workspace) => {
      const department = withAccessActor(admin, () => companyService.createDepartment({ name: 'Engineering' }).id);
      withAccessActor(admin, () => companyService.updateDepartment(department, { name: 'Engineering', memberIds: [owner.id, colleague.id] }));
      const content = '---\nname: private-helper\ndescription: PRIVATE_SKILL_MARKER\n---\nUse the supporting script.';
      const skill = withAccessActor(owner, () => companySkillsService.save({ content, files: [{ relativePath: 'scripts/helper.py', content: 'print(1)' }] }));
      assert.equal(skill.visibility, 'private');
      withAccessActor(colleague, () => {
        assert.equal(companySkillsService.list().skills.length, 0);
        assert.throws(() => companySkillsService.get(skill.id), (error: unknown) => error instanceof AppError && error.statusCode === 404);
      });
      withAccessActor(owner, () => companySkillsService.save({ content, visibility: 'departments', departmentIds: [department] }, skill.id));
      withAccessActor(colleague, () => {
        assert.equal(companySkillsService.get(skill.id).canManage, false);
        assert.throws(() => companySkillsService.save({ content }, skill.id), (error: unknown) => error instanceof AppError && error.statusCode === 403);
      });
      withAccessActor(other, () => assert.equal(companySkillsService.list().skills.length, 0));
      // Administrators get no exception: a skill shared with a department they are not in stays hidden from them.
      withAccessActor(admin, () => assert.throws(() => companySkillsService.get(skill.id), (error: unknown) => error instanceof AppError && error.statusCode === 404));
      withAccessActor(owner, () => assert.throws(() => companySkillsService.save({ content: content.replace('private-helper', 'invalid-path-helper'), files: [{ relativePath: '../../escape', content: 'x' }] }), (error: unknown) => error instanceof AppError && error.statusCode === 400));
      const chatId = randomUUID();
      withAccessActor(owner, () => { sessionsDb.createAppSession(chatId, 'claude', workspace); companyService.updateChatSharing(chatId, { visibility: 'company' }); });
      await withAccessActor(owner, async () => {
        await assert.rejects(companySkillsService.preparePrompt('claude', '/private-helper work', chatId), (error: unknown) => error instanceof AppError && error.code === 'SKILL_AUDIENCE_MISMATCH');
        assert.equal(await companySkillsService.preparePrompt('claude', 'work', chatId), 'work');
        companyService.updateChatSharing(chatId, { visibility: 'private' });
        const prompt = await companySkillsService.preparePrompt('claude', '/private-helper work', chatId);
        exportedSkillIds.push(skill.id);
        assert.match(prompt, /PRIVATE_SKILL_MARKER/);
        const visible = withoutGeneratedSkillContext({ role: 'user', content: prompt } as NormalizedMessage);
        assert.equal(visible.content, '/private-helper work');
      });
    });
  } finally { for (const skillId of exportedSkillIds) await skillExportService.purge(skillId); }
});

test('attachments follow their owner and shared chat grants', async () => {
  await fixture(([admin, owner, colleague], workspace) => {
    withAccessActor(owner, () => {
      sessionsDb.createAppSession('attachments-chat', 'claude', workspace);
      resourceAccessDb.recordAsset('private-image.png'); resourceAccessDb.bindAsset('attachments-chat', 'private-image.png');
    });
    withAccessActor(colleague, () => assert.equal(resourceAccessDb.canReadAsset('private-image.png'), false));
    withAccessActor(owner, () => companyService.updateChatSharing('attachments-chat', { visibility: 'company' }));
    withAccessActor(colleague, () => assert.equal(resourceAccessDb.canReadAsset('private-image.png'), true));
    withAccessActor(owner, () => companyService.updateChatSharing('attachments-chat', { visibility: 'private' }));
    withAccessActor(colleague, () => assert.equal(resourceAccessDb.canReadAsset('private-image.png'), false));
    withAccessActor(admin, () => assert.equal(resourceAccessDb.canReadAsset('private-image.png'), false));
    assert.equal((getConnection().prepare('SELECT COUNT(*) AS count FROM managed_skills').get() as { count: number }).count, 0);
  });
});

test('legacy shared chats retain company access while new chats default to private', async () => {
  await fixture(async ([admin, owner, colleague], workspace) => {
    sessionsDb.createAppSession('legacy-chat', 'claude', workspace);
    getConnection().exec('ALTER TABLE sessions DROP COLUMN owner_user_id; ALTER TABLE sessions DROP COLUMN visibility;');
    await initializeDatabase();
    withAccessActor(colleague, () => assert.equal(sessionsDb.getSessionById('legacy-chat')?.visibility, 'company'));
    assert.equal(sessionsDb.getSessionById('legacy-chat')?.owner_user_id, admin.id);
    withAccessActor(owner, () => sessionsDb.createAppSession('new-private', 'claude', workspace));
    withAccessActor(colleague, () => assert.equal(sessionsDb.getSessionById('new-private'), null));
  });
});

test('container migration moves a home workspace and the indexer preserves its safe alias', async () => {
  const oldDeployment = process.env.CLOUDCLI_CONTAINER_DEPLOYMENT;
  const oldRoot = process.env.WORKSPACES_ROOT;
  try {
    await fixture(async ([admin], workspace) => {
      sessionsDb.createSession('home-chat', 'claude', os.homedir(), 'Existing chat');
      process.env.CLOUDCLI_CONTAINER_DEPLOYMENT = 'true';
      process.env.WORKSPACES_ROOT = path.join(workspace, 'workspace');
      await initializeDatabase();
      const newPath = path.join(process.env.WORKSPACES_ROOT, 'chats');
      assert.equal(sessionsDb.getSessionById('home-chat')?.project_path, newPath);
      sessionsDb.createSession('home-chat', 'claude', os.homedir(), 'Existing chat');
      assert.equal(sessionsDb.getSessionById('home-chat')?.project_path, newPath);
      assert.equal(sessionsDb.getSessionById('home-chat')?.owner_user_id, admin.id);
    });
  } finally {
    if (oldDeployment === undefined) delete process.env.CLOUDCLI_CONTAINER_DEPLOYMENT; else process.env.CLOUDCLI_CONTAINER_DEPLOYMENT = oldDeployment;
    if (oldRoot === undefined) delete process.env.WORKSPACES_ROOT; else process.env.WORKSPACES_ROOT = oldRoot;
  }
});
