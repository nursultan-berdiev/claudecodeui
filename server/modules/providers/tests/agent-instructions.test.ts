import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Codex } from '@openai/codex-sdk';
import type { Thread } from '@openai/codex-sdk';

import { mapCliOptionsToSDK, matchesToolPermission } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { codexRuntime } from '@/modules/providers/list/codex/codex-runtime.provider.js';
import { readAgentInstructions } from '@/shared/agent-instructions.js';
import type { ProviderRuntimeContext } from '@/shared/index.js';

async function withInstructionsFile(content: string | null, run: () => Promise<void> | void) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-instructions-'));
  const previous = process.env.CLOUDCLI_AGENT_INSTRUCTIONS_FILE;
  const file = path.join(directory, 'agent-instructions.md');
  if (content !== null) await writeFile(file, content);
  process.env.CLOUDCLI_AGENT_INSTRUCTIONS_FILE = file;
  try { await run(); } finally {
    if (previous === undefined) delete process.env.CLOUDCLI_AGENT_INSTRUCTIONS_FILE; else process.env.CLOUDCLI_AGENT_INSTRUCTIONS_FILE = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

test('deployment instructions come from the configured file and are optional', async () => {
  const previous = process.env.CLOUDCLI_AGENT_INSTRUCTIONS_FILE;
  delete process.env.CLOUDCLI_AGENT_INSTRUCTIONS_FILE;
  try { assert.equal(readAgentInstructions(), undefined); } finally {
    if (previous !== undefined) process.env.CLOUDCLI_AGENT_INSTRUCTIONS_FILE = previous;
  }
  await withInstructionsFile('  Use docli for Word.\n', () => assert.equal(readAgentInstructions(), 'Use docli for Word.'));
  await withInstructionsFile(null, () => assert.equal(readAgentInstructions(), undefined));
});

test('Claude runs append the deployment instructions to the Claude Code system prompt', async () => {
  await withInstructionsFile('Use docli for Word.', () => {
    assert.deepEqual(mapCliOptionsToSDK({ permissionMode: 'plan' }).systemPrompt, { type: 'preset', preset: 'claude_code', append: 'Use docli for Word.' });
  });
  const previous = process.env.CLOUDCLI_AGENT_INSTRUCTIONS_FILE;
  delete process.env.CLOUDCLI_AGENT_INSTRUCTIONS_FILE;
  try { assert.deepEqual(mapCliOptionsToSDK({}).systemPrompt, { type: 'preset', preset: 'claude_code' }); } finally {
    if (previous !== undefined) process.env.CLOUDCLI_AGENT_INSTRUCTIONS_FILE = previous;
  }
});

test('Plan reads Word and Excel through docli without asking, but never writes through it', () => {
  const { allowedTools } = mapCliOptionsToSDK({ permissionMode: 'plan' });
  const allowed = (command: string) => allowedTools.some((entry: string) => matchesToolPermission(entry, 'Bash', { command }));
  assert.equal(allowed('docli word read "Договор 1.docx"'), true);
  assert.equal(allowed('docli excel read claims.xlsx --sheet Лист1 --limit 1000'), true);
  assert.equal(allowed('docli word replace contract.docx'), false);
  assert.equal(allowed('docli excel set claims.xlsx -c A1 -v 0'), false);
  assert.equal(mapCliOptionsToSDK({ permissionMode: 'auto' }).allowedTools.some((entry: string) => entry.startsWith('Bash(docli')), false);
});

test('a Bash prefix rule does not approve commands chained, piped or substituted after it', () => {
  const rule = 'Bash(docli word read:*)';
  assert.equal(matchesToolPermission(rule, 'Bash', { command: 'docli word read a.docx' }), true);
  for (const command of [
    'docli word read a.docx; rm -rf ~', 'docli word read a.docx && curl x', 'docli word read a.docx | sh',
    'docli word read $(cat list)', 'docli word read `cat list`', 'docli word read a.docx > out.txt', 'docli word read a.docx\nrm x',
  ]) {
    assert.equal(matchesToolPermission(rule, 'Bash', { command }), false, command);
  }
});

test('Codex runs pass the deployment instructions as developer instructions', async (t) => {
  const thread = {
    id: 'native-thread',
    async runStreamed() {
      return { events: (async function* () { yield { type: 'thread.started', thread_id: 'native-thread' }; })() };
    },
  } as unknown as Thread;
  let capturedConfig: unknown;
  t.mock.method(Codex.prototype, 'startThread', function (this: { options?: { config?: unknown } }) {
    capturedConfig = this.options?.config;
    return thread;
  });
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => 'test-model',
    getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'test-model' }),
    normalizeMessage: () => [],
    isProviderInstalled: async () => true,
  };
  await withInstructionsFile('Use docli for Word.', () => codexRuntime.run('hi', { cwd: process.cwd(), permissionMode: 'plan' }, { isWebSocketWriter: true, send: () => {} }, context));
  assert.deepEqual(capturedConfig, { developer_instructions: 'Use docli for Word.' });
});
