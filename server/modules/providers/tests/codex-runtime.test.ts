import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Codex } from '@openai/codex-sdk';
import type { Thread, ThreadOptions } from '@openai/codex-sdk';

import { codexPlanSandbox } from '@/modules/providers/list/codex/codex-plan-check.js';
import { CODEX_PLAN_PROFILE } from '@/modules/providers/list/codex/codex-plan-profile.js';
import { codexRuntime } from '@/modules/providers/list/codex/codex-runtime.provider.js';
import type { ProviderRuntimeContext } from '@/shared/index.js';

for (const resumed of [false, true]) {
  for (const permissionMode of [undefined, 'default', 'unknown', 'acceptEdits', 'bypassPermissions', 'auto', 'plan']) {
    test(`Codex ${resumed ? 'resumes' : 'starts'} with supported permissions (${permissionMode ?? 'omitted'})`, async (t) => {
      t.mock.method(codexPlanSandbox, 'check', async () => ({ outcome: 'honoured' as const, detail: '' }));
      let capturedOptions: ThreadOptions | undefined;
      let capturedOverrides: string[] | undefined;
      let capturedPrompt: unknown;
      const messages: unknown[] = [];
      const thread = {
        id: 'native-thread',
        async runStreamed(prompt: unknown) {
          capturedPrompt = prompt;
          return { events: (async function* () {
            yield { type: 'thread.started', thread_id: 'native-thread' };
          })() };
        },
      } as unknown as Thread;

      const start = t.mock.method(Codex.prototype, 'startThread', function (this: Codex, options?: ThreadOptions) {
        capturedOptions = options;
        capturedOverrides = (this as unknown as { options?: { configOverrides?: string[] } }).options?.configOverrides;
        return thread;
      });
      const resume = t.mock.method(Codex.prototype, 'resumeThread', function (this: Codex, id: string, options?: ThreadOptions) {
        assert.equal(id, 'native-thread');
        capturedOptions = options;
        capturedOverrides = (this as unknown as { options?: { configOverrides?: string[] } }).options?.configOverrides;
        return thread;
      });
      const context: ProviderRuntimeContext = {
        resolveProviderSessionId: () => resumed ? 'native-thread' : null,
        resolveResumeModel: async () => 'test-model',
        getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'test-model' }),
        normalizeMessage: () => [],
        isProviderInstalled: async () => true,
      };

      await codexRuntime.run('hey there', {
        sessionId: resumed ? 'app-session' : undefined,
        permissionMode,
        cwd: process.cwd(),
      }, { isWebSocketWriter: true, send: (message) => messages.push(message) }, context);

      assert.equal(start.mock.callCount(), resumed ? 0 : 1);
      assert.equal(resume.mock.callCount(), resumed ? 1 : 0);
      assert.equal(capturedPrompt, 'hey there');
      const automatic = permissionMode === 'bypassPermissions' || permissionMode === 'auto';
      // Plan picks the read-everything, write-only-/tmp permissions profile by
      // config; an explicit sandbox mode would override it.
      assert.equal(capturedOptions?.sandboxMode, permissionMode === 'plan' ? undefined : automatic ? 'danger-full-access' : 'workspace-write');
      if (permissionMode === 'plan') {
        assert.ok(capturedOverrides, 'Plan passes its permissions profile as raw overrides');
        assert.ok(capturedOverrides.includes(`default_permissions="${CODEX_PLAN_PROFILE}"`));
        const permissions = capturedOverrides.find((override) => override.startsWith('permissions='));
        assert.ok(permissions, 'the profile reaches --config');
        for (const rule of [`"${CODEX_PLAN_PROFILE}"`, '":root" = "read"', '":slash_tmp" = "write"', `"${path.join(os.homedir(), '.codex', 'auth.json')}" = "deny"`]) {
          assert.ok(permissions.includes(rule), `--config carries ${rule}`);
        }
      } else {
        assert.equal(capturedOverrides, undefined);
      }
      assert.equal(capturedOptions?.approvalPolicy, ['acceptEdits', 'bypassPermissions', 'auto', 'plan'].includes(permissionMode ?? '') ? 'never' : 'on-request');
      assert.ok(messages.some((message: any) => message.kind === 'complete' && message.exitCode === 0));
      assert.ok(!messages.some((message: any) => message.kind === 'error'));
    });
  }
}

for (const command of ['', '  \n\t']) {
  test(`Codex supplies a prompt for an image-only turn (${JSON.stringify(command)})`, async (t) => {
    let capturedPrompt: unknown;
    const imagePath = path.join(process.cwd(), 'public', 'favicon.png');
    const thread = {
      id: 'native-thread',
      async runStreamed(prompt: unknown) {
        capturedPrompt = prompt;
        return { events: (async function* () {
          yield { type: 'thread.started', thread_id: 'native-thread' };
        })() };
      },
    } as unknown as Thread;

    t.mock.method(Codex.prototype, 'startThread', () => thread);
    const context: ProviderRuntimeContext = {
      resolveProviderSessionId: () => null,
      resolveResumeModel: async () => 'test-model',
      getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'test-model' }),
      normalizeMessage: () => [],
      isProviderInstalled: async () => true,
    };

    await codexRuntime.run(command, {
      cwd: process.cwd(),
      images: [{ path: imagePath, mimeType: 'image/png' }],
    }, { isWebSocketWriter: true, send: () => {} }, context);

    assert.deepEqual(capturedPrompt, [
      { type: 'text', text: 'Please analyze the attached image(s).' },
      { type: 'local_image', path: imagePath },
    ]);
  });
}

test('Codex Plan refuses the turn, without starting Codex, when the profile check fails', async (t) => {
  t.mock.method(codexPlanSandbox, 'check', async () => ({ outcome: 'ignored' as const, detail: 'wrong: skill /home/node/.codex' }));
  t.mock.method(console, 'error', () => {});
  const start = t.mock.method(Codex.prototype, 'startThread', () => {
    throw new Error('Codex must not start');
  });
  const messages: any[] = [];
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => 'test-model',
    getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'test-model' }),
    normalizeMessage: () => [],
    isProviderInstalled: async () => true,
  };
  await codexRuntime.run('hi', { permissionMode: 'plan', cwd: process.cwd() }, { isWebSocketWriter: true, send: (message) => messages.push(message) }, context);
  assert.equal(start.mock.callCount(), 0, 'no read-only fallback: Codex does not run at all');
  const error = messages.find((message) => message.kind === 'error');
  assert.match(String(error?.content), /^Plan is unavailable: this Codex does not apply/);
  assert.ok(!String(error?.content).includes('/home/node'), 'the check detail stays out of the chat');
  assert.ok(messages.some((message) => message.kind === 'complete' && message.exitCode === 1));
});
