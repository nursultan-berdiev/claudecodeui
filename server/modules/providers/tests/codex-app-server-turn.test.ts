import assert from 'node:assert/strict';
import test from 'node:test';

import { Codex } from '@openai/codex-sdk';
import type { Thread } from '@openai/codex-sdk';

import { CodexSessionsProvider } from '@/modules/providers/list/codex/codex-sessions.provider.js';
import { startCodexAppServerTurn } from '@/modules/providers/list/codex/codex-app-server-turn.provider.js';
import { codexRuntime } from '@/modules/providers/list/codex/codex-runtime.provider.js';
import type { AnyRecord, CodexAppServerHandlers, NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

/**
 * With CLOUDCLI_CODEX_TRANSPORT=app-server a Codex turn runs over the CLI's
 * JSON-RPC server, which streams the reply as it is written. These drive the
 * runtime against a scripted server: what it asks for, what it streams, and
 * that it falls back to exec when the server cannot start.
 */

const sessions = new CodexSessionsProvider();

type ScriptedServer = {
  requests: Array<{ method: string; params: AnyRecord }>;
  answers: Array<{ method: string; result: unknown }>;
  closed: boolean;
};

/**
 * A fake `codex app-server`: answers thread/turn requests and, once the turn
 * starts, plays `notifications` (and asks `serverRequests`) through the
 * handlers the runtime registered.
 */
function scriptServer(options: {
  notifications?: Array<[string, AnyRecord]>;
  serverRequests?: string[];
  /** Sent while `turn/start` is still unanswered. */
  beforeTurnStarted?: Array<[string, AnyRecord]>;
  /** Ends the process after the notifications, as a crash would. */
  exitAfterNotifications?: string;
  /** Runs while `turn/start` is being answered. */
  duringTurnStart?: () => void;
  /** A server stuck in a tool call: it never answers an interrupt. */
  ignoreInterrupt?: boolean;
}): { server: ScriptedServer; open: NonNullable<ProviderRuntimeContext['openCodexAppServer']> } {
  const server: ScriptedServer = { requests: [], answers: [], closed: false };
  const open = async (handlers: CodexAppServerHandlers) => ({
    request: async (method: string, params: unknown) => {
      server.requests.push({ method, params: params as AnyRecord });
      if (method === 'thread/start' || method === 'thread/resume') {
        return { thread: { id: (params as AnyRecord).threadId ?? 'thread-new' } };
      }
      if (method === 'turn/start') {
        options.duringTurnStart?.();
        for (const [notification, notificationParams] of options.beforeTurnStarted ?? []) {
          handlers.onNotification(notification, notificationParams);
        }
        setTimeout(async () => {
          for (const request of options.serverRequests ?? []) {
            server.answers.push({ method: request, result: await Promise.resolve().then(() => handlers.onServerRequest(request, {})).catch((error: Error) => `error: ${error.message}`) });
          }
          for (const [notification, notificationParams] of options.notifications ?? []) {
            handlers.onNotification(notification, notificationParams);
          }
          if (options.exitAfterNotifications) {
            handlers.onExit(options.exitAfterNotifications);
          }
        }, 5);
        return { turn: { id: 'turn-1', status: 'inProgress' } };
      }
      if (method === 'turn/interrupt') {
        if (!options.ignoreInterrupt) {
          setTimeout(() => handlers.onNotification('turn/completed', { turn: { id: 'turn-1', status: 'interrupted' } }), 5);
        }
        return {};
      }
      return {};
    },
    // Like the real process: ending it reports the exit.
    close: () => {
      if (server.closed) return;
      server.closed = true;
      setTimeout(() => handlers.onExit('codex app-server exited (code null, signal SIGTERM)'), 1);
    },
  });
  return { server, open };
}

const replyNotifications = (text: string): Array<[string, AnyRecord]> => [
  ['item/started', { turnId: 'turn-1', item: { type: 'agentMessage', id: 'msg_1', text: '' } }],
  ...[...text].map((char): [string, AnyRecord] => ['item/agentMessage/delta', { turnId: 'turn-1', itemId: 'msg_1', delta: char }]),
  ['item/completed', { turnId: 'turn-1', item: { type: 'agentMessage', id: 'msg_1', text } }],
  ['thread/tokenUsage/updated', { turnId: 'turn-1', tokenUsage: { last: { totalTokens: 1200, inputTokens: 1000, cachedInputTokens: 0, outputTokens: 200 }, modelContextWindow: 272000 } }],
  ['turn/completed', { turn: { id: 'turn-1', status: 'completed', error: null } }],
];

async function runTurn(options: {
  open: NonNullable<ProviderRuntimeContext['openCodexAppServer']>;
  resumed?: boolean;
  permissionMode?: string;
  effort?: string;
  normalizeMessage?: ProviderRuntimeContext['normalizeMessage'];
}): Promise<NormalizedMessage[]> {
  const sent: NormalizedMessage[] = [];
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => (options.resumed ? 'thread-old' : null),
    resolveResumeModel: async () => 'gpt-test',
    getProviderModels: async () => ({ OPTIONS: [{ value: 'gpt-test', label: 'GPT', effort: { values: [{ value: 'high' }] } }], DEFAULT: 'gpt-test' }) as never,
    normalizeMessage: options.normalizeMessage ?? ((raw, sessionId) => sessions.normalizeMessage(raw, sessionId)),
    isProviderInstalled: async () => true,
    openCodexAppServer: options.open,
  };
  const previous = process.env.CLOUDCLI_CODEX_TRANSPORT;
  process.env.CLOUDCLI_CODEX_TRANSPORT = 'app-server';
  try {
    await codexRuntime.run('hello', {
      sessionId: options.resumed ? 'app-resumed' : undefined,
      cwd: process.cwd(),
      permissionMode: options.permissionMode,
      effort: options.effort,
    }, { isWebSocketWriter: true, send: (message: unknown) => { sent.push(message as NormalizedMessage); } }, context);
  } finally {
    if (previous === undefined) delete process.env.CLOUDCLI_CODEX_TRANSPORT;
    else process.env.CLOUDCLI_CODEX_TRANSPORT = previous;
  }
  return sent;
}

test('a reply streams token by token and its finished row replaces the bubble', async () => {
  const { server, open } = scriptServer({ notifications: replyNotifications('Hi!') });
  const sent = await runTurn({ open });

  const frames = sent
    .filter((message) => message.kind !== 'session_created')
    .map((message) => {
      if (message.kind === 'stream_delta') return `delta ${message.streamId} ${message.content}`;
      if (message.kind === 'stream_end') return `end ${message.streamId}${message.discard ? ' discard' : ''}`;
      if (message.kind === 'text') return `text ${message.content} replaces ${message.replacesStreamId}`;
      if (message.kind === 'status') return `status ${(message.tokenBudget as AnyRecord).used}/${(message.tokenBudget as AnyRecord).total}`;
      return message.kind;
    });
  assert.deepEqual(frames, [
    'delta msg_1 H', 'delta msg_1 i', 'delta msg_1 !',
    'end msg_1',
    'text Hi! replaces msg_1',
    'complete',
    'status 1200/272000',
    'complete',
  ]);
  assert.equal(server.closed, true, 'the process ends with the turn');
});

test('a new thread starts with the run\'s settings, a resumed one resumes', async () => {
  const fresh = scriptServer({ notifications: replyNotifications('a') });
  await runTurn({ open: fresh.open, permissionMode: 'acceptEdits', effort: 'high' });
  const start = fresh.server.requests.find((request) => request.method === 'thread/start');
  assert.deepEqual(
    { cwd: start?.params.cwd, model: start?.params.model, sandbox: start?.params.sandbox, approvalPolicy: start?.params.approvalPolicy, config: start?.params.config },
    { cwd: process.cwd(), model: 'gpt-test', sandbox: 'workspace-write', approvalPolicy: 'never', config: { model_reasoning_effort: 'high' } },
  );
  assert.deepEqual(
    fresh.server.requests.find((request) => request.method === 'turn/start')?.params.input,
    [{ type: 'text', text: 'hello', text_elements: [] }],
  );

  const resumed = scriptServer({ notifications: replyNotifications('a') });
  await runTurn({ open: resumed.open, resumed: true, permissionMode: 'plan' });
  const resume = resumed.server.requests.find((request) => request.method === 'thread/resume');
  assert.equal(resume?.params.threadId, 'thread-old');
  assert.equal(resume?.params.sandbox, 'read-only');
  assert.equal(resumed.server.requests.some((request) => request.method === 'thread/start'), false);
});

test('a reply that normalizes to something other than prose drops its bubble', async () => {
  const { open } = scriptServer({ notifications: replyNotifications('# Plan') });
  // Whatever the normalizer makes of the finished message — here a plan card —
  // the streamed bubble must not stay behind as a second copy of it.
  const sent = await runTurn({
    open,
    normalizeMessage: (raw, sessionId) => ((raw as AnyRecord).itemType === 'agent_message'
      ? [{ id: 'plan', kind: 'tool_use', toolName: 'ExitPlanMode', toolId: 'plan', sessionId: sessionId ?? '', provider: 'codex', timestamp: '' } as NormalizedMessage]
      : sessions.normalizeMessage(raw, sessionId)),
  });

  assert.ok(sent.some((message) => message.kind === 'stream_end' && message.streamId === 'msg_1' && message.discard === true));
  assert.ok(sent.some((message) => message.kind === 'tool_use' && message.toolName === 'ExitPlanMode'));
});

test('every request the server makes is answered, so the turn cannot hang', async () => {
  const { server, open } = scriptServer({
    serverRequests: ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'execCommandApproval', 'item/tool/requestUserInput', 'something/new'],
    notifications: replyNotifications('ok'),
  });
  await runTurn({ open });

  assert.deepEqual(server.answers, [
    { method: 'item/commandExecution/requestApproval', result: { decision: 'decline' } },
    { method: 'item/fileChange/requestApproval', result: { decision: 'decline' } },
    { method: 'execCommandApproval', result: { decision: { denied: { rejection: 'CloudCLI runs Codex without interactive approvals.' } } } },
    { method: 'item/tool/requestUserInput', result: { answers: {} } },
    { method: 'something/new', result: 'error: CloudCLI does not handle "something/new".' },
  ]);
});

test('a failed turn shows the API\'s own sentence once', async () => {
  const error = { message: '{"type":"error","status":400,"error":{"message":"The model is not supported."}}' };
  const { open } = scriptServer({
    notifications: [
      ['error', { turnId: 'turn-1', error, willRetry: false }],
      ['turn/completed', { turn: { id: 'turn-1', status: 'failed', error } }],
    ],
  });
  const sent = await runTurn({ open });

  assert.deepEqual(sent.filter((message) => message.kind === 'error').map((message) => message.content), ['The model is not supported.']);
  assert.ok(sent.some((message) => message.kind === 'complete' && message.exitCode === 1));
});

test('aborting interrupts the turn and sends no completion of its own', async () => {
  const { server, open } = scriptServer({
    notifications: [
      ['item/started', { turnId: 'turn-1', item: { type: 'agentMessage', id: 'msg_1', text: '' } }],
      ['item/agentMessage/delta', { turnId: 'turn-1', itemId: 'msg_1', delta: 'Half' }],
    ],
  });
  const run = runTurn({ open, resumed: true });
  await new Promise((resolve) => { setTimeout(resolve, 40); });
  assert.equal(codexRuntime.abort('app-resumed'), true);
  const sent = await run;

  assert.ok(server.requests.some((request) => request.method === 'turn/interrupt' && request.params.turnId === 'turn-1'));
  assert.equal(server.requests.filter((request) => request.method === 'turn/interrupt').length, 1, 'interrupted once');
  assert.ok(sent.some((message) => message.kind === 'stream_end' && message.streamId === 'msg_1'), 'the open reply is closed');
  assert.equal(sent.some((message) => message.kind === 'complete'), false);
  assert.equal(server.closed, true);
});

test('an abort that lands while the turn is starting still stops it', async () => {
  const { server, open } = scriptServer({
    duringTurnStart: () => { codexRuntime.abort('app-resumed'); },
    notifications: partialReply,
  });
  const sent = await runTurn({ open, resumed: true });

  assert.ok(server.requests.some((request) => request.method === 'turn/interrupt'));
  assert.equal(server.closed, true);
  assert.equal(sent.some((message) => message.kind === 'complete'), false);
});

test('an abort ends the run even when the server never answers the interrupt', async () => {
  const { server, open } = scriptServer({ notifications: partialReply, ignoreInterrupt: true });
  const run = runTurn({ open, resumed: true });
  await new Promise((resolve) => { setTimeout(resolve, 40); });
  const abortedAt = Date.now();
  codexRuntime.abort('app-resumed');
  const sent = await run;

  assert.equal(server.closed, true);
  assert.ok(Date.now() - abortedAt < 3000, 'the grace bounds the wait');
  assert.equal(sent.some((message) => message.kind === 'error'), false, 'a stop is not reported as a failure');
  // The run ends through the failed events (the closed process), so this is
  // the `catch` path's own `stream_end`.
  assert.ok(sent.some((message) => message.kind === 'stream_end' && message.streamId === 'msg_1'), 'the open reply is closed');
});

test('a late turn/completed of an earlier turn cannot end this one', async () => {
  const { open } = scriptServer({
    beforeTurnStarted: [['turn/completed', { turn: { id: 'turn-0', status: 'completed', error: null } }]],
    notifications: replyNotifications('Still here'),
  });
  const sent = await runTurn({ open });

  assert.ok(sent.some((message) => message.kind === 'text' && message.content === 'Still here'));
});

test('when the app-server cannot start, the turn runs over exec instead', async (t) => {
  let execPrompt: unknown;
  const thread = {
    id: 'exec-thread',
    async runStreamed(prompt: unknown) {
      execPrompt = prompt;
      return { events: (async function* () {
        yield { type: 'thread.started', thread_id: 'exec-thread' };
        yield { type: 'item.completed', item: { id: 'm', type: 'agent_message', text: 'from exec' } };
      })() };
    },
  } as unknown as Thread;
  t.mock.method(Codex.prototype, 'startThread', () => thread);
  const warn = t.mock.method(console, 'warn', () => {});

  const sent = await runTurn({ open: async () => { throw new Error('spawn codex ENOENT'); } });

  assert.equal(execPrompt, 'hello');
  assert.ok(sent.some((message) => message.kind === 'text' && message.content === 'from exec'));
  assert.ok(warn.mock.calls.some((call) => String(call.arguments[0]).includes('falling back to exec')));
});

const partialReply: Array<[string, AnyRecord]> = [
  ['item/started', { turnId: 'turn-1', item: { type: 'agentMessage', id: 'msg_1', text: '' } }],
  ['item/agentMessage/delta', { turnId: 'turn-1', itemId: 'msg_1', delta: 'Half a rep' }],
];

const kinds = (sent: NormalizedMessage[]) => sent
  .filter((message) => message.kind !== 'session_created')
  .map((message) => (message.kind === 'stream_end' ? `stream_end ${message.streamId}` : message.kind));

test('a turn that fails mid-reply ends its stream before it completes', async () => {
  const error = { message: 'stream disconnected' };
  const { open } = scriptServer({
    notifications: [...partialReply, ['turn/completed', { turn: { id: 'turn-1', status: 'failed', error } }]],
  });
  const sent = await runTurn({ open });

  assert.deepEqual(kinds(sent), ['stream_delta', 'error', 'stream_end msg_1', 'complete']);
});

test('a process that dies mid-reply ends its stream and reports the failure', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { server, open } = scriptServer({ notifications: partialReply, exitAfterNotifications: 'codex app-server exited (code 1, signal null)' });
  const sent = await runTurn({ open });

  assert.deepEqual(kinds(sent), ['stream_delta', 'stream_end msg_1', 'error', 'complete']);
  assert.equal(sent.find((message) => message.kind === 'error')?.content, 'codex app-server exited (code 1, signal null)');
  assert.ok(sent.some((message) => message.kind === 'complete' && message.exitCode === 1));
  assert.equal(server.closed, true);
});

test('notifications that beat the turn/start reply are kept for this turn and dropped for another', async () => {
  const { open } = scriptServer({
    beforeTurnStarted: [
      ['item/agentMessage/delta', { turnId: 'turn-0', itemId: 'old', delta: 'late from an earlier turn' }],
      ['item/started', { turnId: 'turn-1', item: { type: 'agentMessage', id: 'msg_1', text: '' } }],
      ['item/agentMessage/delta', { turnId: 'turn-1', itemId: 'msg_1', delta: 'Early ' }],
    ],
    notifications: [
      ['item/agentMessage/delta', { turnId: 'turn-1', itemId: 'msg_1', delta: 'bird' }],
      ['item/completed', { turnId: 'turn-1', item: { type: 'agentMessage', id: 'msg_1', text: 'Early bird' } }],
      ['turn/completed', { turn: { id: 'turn-1', status: 'completed', error: null } }],
    ],
  });
  const sent = await runTurn({ open });

  assert.deepEqual(
    sent.filter((message) => message.kind === 'stream_delta').map((message) => message.content),
    ['Early ', 'bird'],
  );
});

test('dispose ends the process even when the events were never read', async () => {
  const { server, open } = scriptServer({ notifications: partialReply });
  const turn = await startCodexAppServerTurn({
    providerSessionId: null,
    workingDirectory: process.cwd(),
    sandboxMode: 'read-only',
    approvalPolicy: 'never',
    developerInstructions: null,
    input: 'hello',
    signal: new AbortController().signal,
    open,
  });

  await turn.dispose();
  await turn.dispose();

  assert.equal(server.closed, true);
  assert.equal(server.requests.filter((request) => request.method === 'turn/interrupt').length, 1, 'an unfinished turn is interrupted once');
});

