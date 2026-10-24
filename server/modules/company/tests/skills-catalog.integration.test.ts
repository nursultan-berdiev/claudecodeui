import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import { closeConnection, getConnection, initializeDatabase, sessionsDb, userDb } from '@/modules/database/index.js';
import type { AccessActor, NormalizedMessage, ProviderAuthStatus, ProviderSkill } from '@/shared/types.js';
import { AppError, withAccessActor, withoutGeneratedSkillContext } from '@/shared/utils.js';

import { companyService } from '../company.service.js';
import { skillHelperService } from '../skill-helper.service.js';
import { skillExportService } from '../skill-export.service.js';
import { skillImportService } from '../skill-import.service.js';
import { companySkillsService } from '../skills-library.service.js';

type Actors = { admin: AccessActor; owner: AccessActor; colleague: AccessActor; other: AccessActor };

/** Skill exports are read-only; deleting entries needs write access to their folders. */
function makeFoldersWritable(target: string): void {
  if (!existsSync(target)) return;
  chmodSync(target, 0o700);
  for (const entry of readdirSync(target, { withFileTypes: true })) if (entry.isDirectory()) makeFoldersWritable(path.join(target, entry.name));
}

/** Temporary database and HOME, so session exports and synced claude.ai skills never touch the real home. */
async function fixture(operation: (actors: Actors, home: string) => Promise<void> | void) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'skills-catalog-'));
  const previous = { database: process.env.DATABASE_PATH, home: process.env.HOME };
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  const home = path.join(directory, 'home');
  process.env.HOME = home;
  await initializeDatabase();
  const [admin, owner, colleague, other] = ['admin', 'owner', 'colleague', 'other'].map((name, index) => {
    const role = index === 0 ? 'admin' as const : 'member' as const;
    return { id: Number(userDb.createUser(name, 'hash', role).id), role };
  });
  try { await operation({ admin, owner, colleague, other }, home); }
  finally {
    closeConnection();
    makeFoldersWritable(directory);
    for (const [key, value] of [['DATABASE_PATH', previous.database], ['HOME', previous.home]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

const skillMarkdown = (name: string, body = 'Follow the steps.') => `---\nname: ${name}\ndescription: Use for ${name}\n---\n${body}`;
const rejectsWith = (code: string) => (error: unknown) => error instanceof AppError && error.code === code;

test('personal skills stay hidden from everyone else, administrators included, until shared', async () => {
  await fixture(({ admin, owner, colleague, other }) => {
    const department = withAccessActor(admin, () => companyService.createDepartment({ name: 'Sales' }).id);
    const foreign = withAccessActor(admin, () => companyService.createDepartment({ name: 'Legal' }).id);
    withAccessActor(admin, () => companyService.updateDepartment(department, { name: 'Sales', memberIds: [owner.id, colleague.id] }));
    const skill = withAccessActor(owner, () => companySkillsService.save({ content: skillMarkdown('weekly-report'), category: 'Reports', examplePrompt: 'Make the weekly report' }));
    assert.equal(skill.visibility, 'private');
    assert.equal(skill.version, 1);
    for (const actor of [admin, colleague, other]) {
      withAccessActor(actor, () => {
        assert.equal(companySkillsService.list().skills.length, 0);
        assert.equal(companySkillsService.providerSkills('claude').length, 0);
        assert.throws(() => companySkillsService.get(skill.id), rejectsWith('SKILL_NOT_FOUND'));
      });
    }

    withAccessActor(owner, () => companySkillsService.save({ content: skill.content, visibility: 'users', userIds: [other.id] }, skill.id));
    withAccessActor(other, () => assert.equal(companySkillsService.get(skill.id).canManage, false));
    withAccessActor(colleague, () => assert.equal(companySkillsService.list().skills.length, 0));
    withAccessActor(owner, () => {
      assert.throws(() => companySkillsService.save({ content: skill.content, visibility: 'users', userIds: [owner.id] }, skill.id), rejectsWith('INVALID_SKILL_USERS'));
      assert.throws(() => companySkillsService.save({ content: skill.content, visibility: 'departments', departmentIds: [foreign] }, skill.id), rejectsWith('INVALID_DEPARTMENT_SHARES'));
      assert.throws(() => companySkillsService.save({ content: skill.content, visibility: 'company' }, skill.id), rejectsWith('SKILL_COMPANY_ADMIN_ONLY'));
      companySkillsService.save({ content: skill.content, visibility: 'departments', departmentIds: [department] }, skill.id);
    });
    withAccessActor(colleague, () => assert.deepEqual(companySkillsService.list().skills.map((item) => [item.name, item.ownerDepartments]), [['weekly-report', ['Sales']]]));
    withAccessActor(other, () => assert.equal(companySkillsService.list().skills.length, 0));
    withAccessActor(admin, () => assert.throws(() => companySkillsService.publish(skill.id), rejectsWith('SKILL_NOT_FOUND')));

    withAccessActor(owner, () => companySkillsService.save({ content: skill.content, visibility: 'users', userIds: [admin.id] }, skill.id));
    withAccessActor(colleague, () => assert.throws(() => companySkillsService.publish(skill.id), rejectsWith('SKILL_COMPANY_ADMIN_ONLY')));
    const published = withAccessActor(admin, () => companySkillsService.publish(skill.id));
    assert.equal(published.visibility, 'company');
    assert.equal(published.ownerUserId, owner.id);
    assert.equal(published.canManage, true);
    withAccessActor(other, () => assert.equal(companySkillsService.list().skills.length, 1));
    // The owner of a published skill edits its content without being forced to unpublish it.
    const edited = withAccessActor(owner, () => companySkillsService.save({ content: skillMarkdown('weekly-report', 'Shorter steps.') }, skill.id));
    assert.equal(edited.visibility, 'company');
    withAccessActor(owner, () => assert.throws(() => companyService.updateChatSharing('missing', { visibility: 'users' }), rejectsWith('INVALID_VISIBILITY')));
  });
});

test('edits create versions, sharing changes do not, and rollback restores files as a new version', async () => {
  await fixture(({ owner, other }) => withAccessActor(owner, () => {
    const files = [{ relativePath: 'scripts/run.py', content: 'print(1)' }];
    const skill = companySkillsService.save({ content: skillMarkdown('versioned'), files });
    const shared = companySkillsService.save({ content: skill.content, visibility: 'users', userIds: [other.id] }, skill.id);
    assert.equal(shared.version, 1);
    const changed = companySkillsService.save({ content: skillMarkdown('versioned', 'Second edition.'), files: [] }, skill.id);
    assert.equal(changed.version, 2);
    assert.deepEqual(companySkillsService.versions(skill.id).map((version) => [version.version, version.isCurrent]), [[2, true], [1, false]]);
    const restored = companySkillsService.rollback(skill.id, 1);
    assert.equal(restored.version, 3);
    assert.equal(restored.content, skill.content);
    assert.deepEqual(restored.files.map((file) => file.relativePath), ['scripts/run.py']);
    assert.equal(restored.visibility, 'users');
    assert.equal(companySkillsService.versions(skill.id)[0].restoredFrom, 1);
    for (let index = 0; index < 25; index += 1) companySkillsService.save({ content: skillMarkdown('versioned', `Edition ${index}.`) }, skill.id);
    assert.equal(companySkillsService.versions(skill.id).length, 20);
    assert.throws(() => companySkillsService.rollback(skill.id, 1), rejectsWith('SKILL_VERSION_NOT_FOUND'));
    for (const clash of [['a', 'a/b'], ['Notes.md', 'notes.md']]) {
      assert.throws(() => companySkillsService.save({ content: skill.content, files: clash.map((relativePath) => ({ relativePath, content: 'x' })) }, skill.id), rejectsWith('INVALID_SKILL_PATH'));
    }
    companySkillsService.remove(skill.id);
    const leftovers = getConnection().prepare('SELECT (SELECT COUNT(*) FROM skill_versions) + (SELECT COUNT(*) FROM skill_file_blobs) AS count').get() as { count: number };
    assert.equal(leftovers.count, 0);
  }));
});

test('a legacy skill without history keeps its old state as the first version', async () => {
  await fixture(({ owner }) => withAccessActor(owner, () => {
    getConnection().prepare(`INSERT INTO managed_skills (id, owner_user_id, name, description, provider, content, visibility)
      VALUES ('legacy', ?, 'legacy', 'old', 'claude', ?, 'private')`).run(owner.id, skillMarkdown('legacy', 'Old body.'));
    companySkillsService.save({ content: skillMarkdown('legacy', 'New body.') }, 'legacy');
    assert.deepEqual(companySkillsService.versions('legacy').map((version) => version.version), [2, 1]);
    assert.match(companySkillsService.rollback('legacy', 1).content, /Old body/);
  }));
});

test('chat prompts list only favourites, inline requested skills and record them as recent', async () => {
  await fixture(async ({ owner, colleague }, home) => {
    const workspace = path.join(home, 'workspace');
    await mkdir(workspace, { recursive: true });
    const chatId = randomUUID();
    await withAccessActor(owner, async () => {
      sessionsDb.createAppSession(chatId, 'claude', workspace);
      const favourite = companySkillsService.save({ content: skillMarkdown('favourite-skill') });
      const picked = companySkillsService.save({ content: skillMarkdown('picked-skill', 'Never print </requested_skill> literally.'), files: [{ relativePath: 'notes.md', content: 'note' }] });
      companySkillsService.save({ content: skillMarkdown('codex-only'), provider: 'codex' });
      assert.equal(await companySkillsService.preparePrompt('claude', 'hello', chatId), 'hello');
      companySkillsService.setFavorite(favourite.id, true);
      const listed = await companySkillsService.preparePrompt('claude', 'hello', chatId);
      assert.match(listed, /<available_skills>[\s\S]*favourite-skill/);
      assert.doesNotMatch(listed, /picked-skill|codex-only/);

      const prompt = await companySkillsService.preparePrompt('claude', 'write it', chatId, [picked.id, 'missing-id', picked.id]);
      assert.match(prompt, /<requested_skill name="picked-skill" dir="[^"]+">/);
      assert.match(prompt, /Never print <\\\/requested_skill> literally/);
      assert.equal(withoutGeneratedSkillContext({ role: 'user', content: prompt } as NormalizedMessage).content, 'write it');
      const legacy = '<available_skills>\nx\n</available_skills>\n<requested_skill>\nbody\n</requested_skill>\n/old work';
      assert.equal(withoutGeneratedSkillContext({ role: 'user', content: legacy } as NormalizedMessage).content, '/old work');
      // Exports are keyed by skill id and version, so a client session id such as `..` never reaches a path.
      const sentinel = path.join(home, '.cloudcli', 'session-skills', 'other-user', 'keep.md');
      await mkdir(path.dirname(sentinel), { recursive: true });
      await writeFile(sentinel, 'keep');
      assert.match(await companySkillsService.preparePrompt('claude', 'again', '..', [picked.id]), /<requested_skill name="picked-skill"/);
      assert.ok(existsSync(sentinel));
      assert.ok(existsSync(path.join(home, '.cloudcli', 'skill-exports', picked.id, 'v1', 'notes.md')));
      // An agent that rewrites an exported SKILL.md does not change what the next chat loads.
      const exportedSkill = path.join(home, '.cloudcli', 'skill-exports', picked.id, 'v1', 'SKILL.md');
      chmodSync(exportedSkill, 0o644);
      writeFileSync(exportedSkill, 'tampered');
      await companySkillsService.preparePrompt('claude', 'again', chatId, [picked.id]);
      assert.match(readFileSync(exportedSkill, 'utf8'), /Never print/);
      for (const edition of ['Second', 'Third', 'Fourth']) {
        companySkillsService.save({ content: skillMarkdown('picked-skill', `${edition} edition.`) }, picked.id);
        await companySkillsService.preparePrompt('claude', 'again', chatId, [picked.id]);
      }
      assert.deepEqual(readdirSync(path.join(home, '.cloudcli', 'skill-exports', picked.id)).sort(), ['v2', 'v3', 'v4']);
      assert.ok(companySkillsService.list().skills.find((skill) => skill.id === picked.id)?.lastUsedAt);
      assert.deepEqual(companySkillsService.providerSkills('claude').map((skill) => skill.name), ['favourite-skill', 'picked-skill']);

      const named = await companySkillsService.preparePrompt('codex', '$codex-only now', chatId);
      assert.match(named, /<requested_skill name="codex-only"/);
      companyService.updateChatSharing(chatId, { visibility: 'company' });
      await assert.rejects(companySkillsService.preparePrompt('claude', 'write it', chatId, [picked.id]), rejectsWith('SKILL_AUDIENCE_MISMATCH'));
    });
    // A pinned id the user can no longer read is skipped instead of failing the message.
    await withAccessActor(colleague, async () => assert.equal(await companySkillsService.preparePrompt('claude', 'hi', randomUUID(), ['unknown']), 'hi'));
  });
});

test('import lists agent, claude.ai and Codex catalog skills and copies only resolved keys', async () => {
  await fixture(async ({ owner, colleague }, home) => {
    const userSkill = path.join(home, '.claude', 'skills', 'meeting-notes', 'SKILL.md');
    const projectSkill = path.join(home, 'project', '.claude', 'skills', 'local-only', 'SKILL.md');
    const syncedSkill = path.join(home, '.claude', 'skills', 'synced', 'bucket-1', 'team-messages', 'SKILL.md');
    for (const [file, name] of [[userSkill, 'meeting-notes'], [projectSkill, 'local-only'], [syncedSkill, 'team-messages']]) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, skillMarkdown(name));
    }
    await writeFile(path.join(path.dirname(userSkill), 'template.md'), 'template');
    // claude.ai accepts this unquoted description; js-yaml does not, so import has to repair it.
    const brokenSkill = path.join(home, '.claude', 'skills', 'synced', 'bucket-1', 'cartoon', 'SKILL.md');
    await mkdir(path.dirname(brokenSkill), { recursive: true });
    await writeFile(brokenSkill, '---\nname: cartoon\ndescription: Делает ролики. Триггеры: "мультик", "ролик"\n---\nBody');
    await writeFile(path.join(home, '.claude', 'skills', 'synced', 'bucket-1', 'manifest.json'), '{"skills":[]}');
    const skill = (scope: ProviderSkill['scope'], sourcePath: string, name: string, provider: ProviderSkill['provider'] = 'claude'): ProviderSkill =>
      ({ provider, name, description: `Use for ${name}`, command: `/${name}`, scope, sourcePath });
    const discover = async (provider: string) => provider === 'claude' ? [skill('user', userSkill, 'meeting-notes'), skill('project', projectSkill, 'local-only')]
      : provider === 'opencode' ? [skill('user', userSkill, 'meeting-notes', 'opencode')] : [];

    await withAccessActor(owner, async () => {
      const { sources } = await skillImportService.listSources(discover);
      assert.deepEqual(sources.map((source) => [source.id, source.items.map((item) => item.name)]),
        [['claude', ['meeting-notes']], ['claude-synced', ['cartoon', 'team-messages']], ['codex', []], ['cursor', []], ['opencode', []]]);
      assert.equal(sources[1].items[0].description, 'Делает ролики. Триггеры: "мультик", "ролик"');
      assert.equal(companySkillsService.list().skills.length, 0);
      const result = await skillImportService.importSelected([`claude:${userSkill}`, 'claude-synced:team-messages', 'claude-synced:cartoon', `claude:${projectSkill}`, 'claude:/etc/passwd'], discover);
      assert.deepEqual(result.imported.map((item) => item.name).sort(), ['cartoon', 'meeting-notes', 'team-messages']);
      assert.throws(() => companySkillsService.save({ content: '---\nname: x\ndescription: a: b: c\n---\n' }), rejectsWith('INVALID_SKILL_FRONTMATTER'));
      assert.deepEqual(result.skipped.map((item) => item.code), ['IMPORT_SOURCE_NOT_FOUND', 'IMPORT_SOURCE_NOT_FOUND']);
      const imported = companySkillsService.list().skills.find((item) => item.name === 'meeting-notes')!;
      assert.equal(imported.visibility, 'private');
      assert.equal(imported.fileCount, 1);
      const again = await skillImportService.importSelected([`opencode:${userSkill}`], discover);
      assert.deepEqual(again.skipped.map((item) => item.code), ['IMPORT_SOURCE_NOT_FOUND']);
      assert.equal((await skillImportService.listSources(discover)).sources[0].items[0].alreadyImported, true);
    });
    await withAccessActor(colleague, async () => {
      const item = (await skillImportService.listSources(discover)).sources[0].items[0];
      assert.deepEqual([item.alreadyImported, item.inLibrary], [false, false]);
      assert.equal((await skillImportService.importSelected([`claude:${userSkill}`], discover)).imported.length, 1);
    });
  });
});

test('the Codex catalog is pinned to one commit, shared by parallel requests, served stale on failure and imported with its files', async () => {
  await fixture(async ({ owner }) => {
    const responses: Record<string, string> = {
      'https://api.github.com/repos/openai/skills/commits/main': JSON.stringify({ sha: 'c0ffee' }),
      'https://api.github.com/repos/openai/skills/git/trees/c0ffee?recursive=1': JSON.stringify({ tree: [
        { path: 'skills/.curated/linear/SKILL.md', type: 'blob', size: 60 }, { path: 'skills/.curated/linear/agents/openai.yaml', type: 'blob', size: 13 },
        { path: 'skills/.curated/no-skill/README.md', type: 'blob', size: 5 }, { path: 'skills/.system/imagegen/SKILL.md', type: 'blob', size: 5 },
        { path: 'skills/.curated/huge/SKILL.md', type: 'blob', size: 60 }, { path: 'skills/.curated/huge/model.bin', type: 'blob', size: 40 * 1024 * 1024 }] }),
      'https://raw.githubusercontent.com/openai/skills/c0ffee/skills/.curated/huge/SKILL.md': skillMarkdown('huge'),
      'https://raw.githubusercontent.com/openai/skills/c0ffee/skills/.curated/linear/SKILL.md': skillMarkdown('linear'),
      'https://raw.githubusercontent.com/openai/skills/c0ffee/skills/.curated/linear/agents/openai.yaml': 'interface: {}',
    };
    let online = false;
    const fetchMock = mock.method(globalThis, 'fetch', async (url: string) => !online || responses[url] === undefined
      ? new Response('unavailable', { status: 503 }) : new Response(responses[url]));
    const apiCalls = () => fetchMock.mock.calls.filter((call) => String(call.arguments[0]).startsWith('https://api.github.com')).length;
    mock.timers.enable({ apis: ['Date'], now: Date.now() });
    try {
      await withAccessActor(owner, async () => {
        await assert.rejects(skillImportService.listCurated(), rejectsWith('CURATED_UNAVAILABLE'));
        // Right after a failure GitHub is not asked again; the import reports the outage per skill.
        assert.deepEqual((await skillImportService.importSelected(['codex-curated:linear'], async () => [])).skipped, [{ key: 'codex-curated:linear', code: 'CURATED_UNAVAILABLE' }]);
        assert.equal(apiCalls(), 1);
        mock.timers.tick(3 * 60 * 1000);
        online = true;
        const [first, second] = await Promise.all([skillImportService.listCurated(), skillImportService.listCurated()]);
        assert.equal(apiCalls(), 3);
        assert.deepEqual(first, second);
        assert.deepEqual(first.items.map((item) => [item.key, item.description]), [['codex-curated:huge', 'Use for huge'], ['codex-curated:linear', 'Use for linear']]);
        // Sizes come from the tree, so an oversized skill is refused before any of its files is downloaded.
        assert.deepEqual((await skillImportService.importSelected(['codex-curated:huge', 'codex-curated:missing'], async () => [])).skipped.map((item) => item.code),
          ['SKILL_TOO_LARGE', 'IMPORT_SOURCE_NOT_FOUND']);
        assert.equal(fetchMock.mock.calls.some((call) => String(call.arguments[0]).endsWith('model.bin')), false);
        const result = await skillImportService.importSelected(['codex-curated:linear'], async () => []);
        assert.equal(result.imported[0]?.name, 'linear');
        assert.deepEqual(companySkillsService.get(result.imported[0].id).files.map((file) => file.relativePath), ['agents/openai.yaml']);
        assert.equal(apiCalls(), 3);
        // After the hour a failed refresh keeps serving the last snapshot and backs off.
        mock.timers.tick(61 * 60 * 1000);
        online = false;
        const keys = async () => (await skillImportService.listCurated()).items.map((item) => item.key);
        assert.deepEqual(await keys(), ['codex-curated:huge', 'codex-curated:linear']);
        assert.deepEqual(await keys(), ['codex-curated:huge', 'codex-curated:linear']);
        assert.equal(apiCalls(), 4);
      });
    } finally { mock.timers.reset(); fetchMock.mock.restore(); }
  });
});

test('skill exports are read-only, kept while unchanged, cleaned of crashed staging and purged with the skill', async () => {
  await fixture(async ({ owner }, home) => withAccessActor(owner, async () => {
    const skill = companySkillsService.save({ content: skillMarkdown('exported'), files: [{ relativePath: 'scripts/run.py', content: 'print(1)' }] });
    const root = path.join(home, '.cloudcli', 'skill-exports', skill.id);
    await mkdir(path.join(root, '.staging-crashed'), { recursive: true });
    utimesSync(path.join(root, '.staging-crashed'), new Date(0), new Date(0));
    const directory = await skillExportService.directory(skill.id);
    assert.equal(directory, path.join(root, 'v1'));
    assert.equal(statSync(path.join(directory, 'scripts', 'run.py')).mode & 0o777, 0o444);
    assert.equal(statSync(directory).mode & 0o777, 0o555);
    assert.equal(statSync(path.join(home, '.cloudcli', 'skill-exports')).mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(root), ['v1']);
    const written = statSync(path.join(directory, 'SKILL.md')).ino;
    assert.equal(await skillExportService.directory(skill.id), directory);
    assert.equal(statSync(path.join(directory, 'SKILL.md')).ino, written);
    await skillExportService.purge(skill.id);
    assert.equal(existsSync(root), false);
  }));
});

test('the helper needs a signed-in agent, runs one draft per employee and sanitises the result', async () => {
  await fixture(async ({ owner, colleague }) => {
    const signedIn = async (provider: string) => ({ provider, installed: true, authenticated: true, email: null, method: 'credentials_file' }) as ProviderAuthStatus;
    const signedOut = async (provider: string) => ({ provider, installed: true, authenticated: false, email: null, method: null }) as ProviderAuthStatus;
    const input = { provider: 'codex' as const, mode: 'draft' as const, request: 'Отвечать клиентам по просрочке', current: '' };
    await withAccessActor(owner, () => assert.rejects(skillHelperService.draft(input, { authStatus: signedOut }), rejectsWith('HELPER_PROVIDER_UNAVAILABLE')));

    let release!: () => void;
    const prompts: string[] = [];
    const slowRun = async (_provider: string, prompt: string) => {
      prompts.push(prompt);
      await new Promise<void>((resolve) => { release = resolve; });
      return { name: ' Ответы Клиентам_по просрочке!', description: 'Use when a client is overdue', category: 'Collections', examplePrompt: 'Draft a reply', body: '# Steps' };
    };
    await withAccessActor(owner, async () => {
      const running = skillHelperService.draft(input, { authStatus: signedIn, runAgent: slowRun });
      await new Promise((resolve) => setTimeout(resolve, 10));
      await assert.rejects(skillHelperService.draft(input, { authStatus: signedIn, runAgent: slowRun }), rejectsWith('HELPER_BUSY'));
      release();
      const draft = await running;
      assert.equal(draft.name, 'ответы-клиентам-по-просрочке');
      assert.equal(draft.body, '# Steps');
      assert.match(prompts[0], /<request>\nОтвечать клиентам по просрочке\n<\/request>/);
    });
    await withAccessActor(colleague, () => assert.rejects(
      skillHelperService.draft(input, { authStatus: signedIn, runAgent: async () => ({ name: 'x', body: '' }) }), rejectsWith('HELPER_FAILED')));
  });
});
