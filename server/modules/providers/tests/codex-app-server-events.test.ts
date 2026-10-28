import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createCodexAppServerTranslator,
  readCodexTurnErrorMessage,
  toExecThreadItem,
} from '@/modules/providers/list/codex/codex-app-server-events.provider.js';

/**
 * The app-server's items and notifications are translated into the events
 * `codex exec` produces, so the Codex normalizer renders a turn the same way
 * whichever transport ran it. Shapes below are copied from a real 0.156.1 run.
 */

test('each app-server item maps onto the exec item for the same thing', () => {
  assert.deepEqual(
    toExecThreadItem({ type: 'agentMessage', id: 'msg_1', text: 'Done.', phase: 'final_answer', memoryCitation: null }),
    { id: 'msg_1', type: 'agent_message', text: 'Done.' },
  );
  assert.deepEqual(
    toExecThreadItem({
      type: 'commandExecution', id: 'exec-1', command: "/bin/bash -lc 'ls -la'", status: 'completed',
      aggregatedOutput: 'total 8\n', exitCode: 0, cwd: '/w', processId: '1', commandActions: [],
    }),
    { id: 'exec-1', type: 'command_execution', command: "/bin/bash -lc 'ls -la'", aggregated_output: 'total 8\n', exit_code: 0, status: 'completed' },
  );
  assert.deepEqual(
    toExecThreadItem({ type: 'commandExecution', id: 'exec-2', command: 'rm x', status: 'declined', aggregatedOutput: null, exitCode: null }),
    { id: 'exec-2', type: 'command_execution', command: 'rm x', aggregated_output: '', status: 'failed' },
  );
  assert.deepEqual(
    toExecThreadItem({
      type: 'fileChange', id: 'patch-1', status: 'inProgress',
      changes: [{ path: '/w/a.txt', kind: { type: 'add' }, diff: '+a' }, { path: '/w/b.txt', kind: { type: 'update', move_path: null }, diff: '' }],
    }),
    { id: 'patch-1', type: 'file_change', changes: [{ path: '/w/a.txt', kind: 'add' }, { path: '/w/b.txt', kind: 'update' }], status: 'in_progress' },
  );
  assert.deepEqual(
    toExecThreadItem({
      type: 'mcpToolCall', id: 'mcp-1', server: 'docs', tool: 'search', status: 'completed', arguments: { q: 'x' },
      result: { content: [{ type: 'text', text: 'hit' }], structuredContent: null, _meta: null }, error: null,
    }),
    {
      id: 'mcp-1', type: 'mcp_tool_call', server: 'docs', tool: 'search', arguments: { q: 'x' },
      result: { content: [{ type: 'text', text: 'hit' }], structured_content: null }, status: 'completed',
    },
  );
  assert.deepEqual(toExecThreadItem({ type: 'webSearch', id: 'ws-1', query: 'bishkek', action: null, results: null }), { id: 'ws-1', type: 'web_search', query: 'bishkek' });
  assert.deepEqual(toExecThreadItem({ type: 'reasoning', id: 'rs-1', summary: ['Look first.'], content: [] }), { id: 'rs-1', type: 'reasoning', text: 'Look first.' });
});

test('items the live chat never showed map to nothing', () => {
  assert.equal(toExecThreadItem({ type: 'userMessage', id: 'u', content: [] }), null);
  assert.equal(toExecThreadItem({ type: 'reasoning', id: 'rs', summary: [], content: [] }), null);
  assert.equal(toExecThreadItem({ type: 'contextCompaction', id: 'c' }), null);
  assert.equal(toExecThreadItem(null), null);
});

test('a turn error reads as the sentence inside the API envelope', () => {
  const raw = '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The model is not supported.","code":"model_not_found"}}';
  assert.equal(readCodexTurnErrorMessage({ message: raw }), 'The model is not supported.');
  assert.equal(readCodexTurnErrorMessage({ message: 'stream disconnected' }), 'stream disconnected');
  assert.equal(readCodexTurnErrorMessage(null), 'Codex turn failed');
});

test('the translator streams reply text and reports the finished turn with its last usage', () => {
  const translator = createCodexAppServerTranslator(() => 'turn-1');
  const events = [
    ['item/started', { turnId: 'turn-1', item: { type: 'agentMessage', id: 'msg_1', text: '' } }],
    ['item/agentMessage/delta', { turnId: 'turn-1', itemId: 'msg_1', delta: 'Hel' }],
    ['item/agentMessage/delta', { turnId: 'turn-1', itemId: 'msg_1', delta: 'lo' }],
    ['item/completed', { turnId: 'turn-1', item: { type: 'agentMessage', id: 'msg_1', text: 'Hello' } }],
    ['thread/tokenUsage/updated', {
      turnId: 'turn-1',
      tokenUsage: {
        total: { totalTokens: 34507, inputTokens: 34336, cachedInputTokens: 28672, outputTokens: 171 },
        last: { totalTokens: 17323, inputTokens: 17253, cachedInputTokens: 17024, outputTokens: 70 },
        modelContextWindow: 272000,
      },
    }],
    ['turn/completed', { turn: { id: 'turn-1', status: 'completed', error: null } }],
  ] as const;

  const translated = events.flatMap(([method, params]) => translator.translate(method, params as never));

  assert.deepEqual(translated, [
    { type: 'item.started', item: { id: 'msg_1', type: 'agent_message', text: '' } },
    { type: 'agent_message.delta', item_id: 'msg_1', delta: 'Hel' },
    { type: 'agent_message.delta', item_id: 'msg_1', delta: 'lo' },
    { type: 'item.completed', item: { id: 'msg_1', type: 'agent_message', text: 'Hello' } },
    {
      type: 'turn.completed',
      usage: { input_tokens: 17253, cached_input_tokens: 17024, output_tokens: 70, total_tokens: 17323, model_context_window: 272000 },
    },
  ]);
  assert.equal(translator.finished, true);
  assert.deepEqual(translator.translate('item/agentMessage/delta', { itemId: 'msg_2', delta: 'late' }), []);
});

test('a failed turn is reported once as exec reports it, and retries are not', () => {
  const translator = createCodexAppServerTranslator(() => 'turn-1');
  const error = { message: '{"error":{"message":"Rate limited."}}' };
  assert.deepEqual(translator.translate('error', { turnId: 'turn-1', error, willRetry: true }), []);
  assert.deepEqual(translator.translate('error', { turnId: 'turn-1', error, willRetry: false }), [{ type: 'error', message: 'Rate limited.' }]);
  assert.deepEqual(
    translator.translate('turn/completed', { turn: { id: 'turn-1', status: 'failed', error } }),
    [{ type: 'turn.failed', error: { message: 'Rate limited.' } }],
  );
});

test('an interrupted turn ends without events, and other turns are ignored', () => {
  const translator = createCodexAppServerTranslator(() => 'turn-2');
  assert.deepEqual(translator.translate('item/agentMessage/delta', { turnId: 'turn-1', itemId: 'old', delta: 'x' }), []);
  assert.deepEqual(translator.translate('turn/completed', { turn: { id: 'turn-2', status: 'interrupted' } }), []);
  assert.equal(translator.finished, true);
});

test('the plan becomes a todo list and command output streams into its item', () => {
  const translator = createCodexAppServerTranslator(() => 'turn-1');
  assert.deepEqual(
    translator.translate('turn/plan/updated', {
      turnId: 'turn-1', explanation: null,
      plan: [{ step: 'Read', status: 'completed' }, { step: 'Write', status: 'inProgress' }],
    }),
    [{ type: 'item.updated', item: { id: 'plan_turn-1', type: 'todo_list', items: [{ text: 'Read', completed: true }, { text: 'Write', completed: false }] } }],
  );

  translator.translate('item/started', { turnId: 'turn-1', item: { type: 'commandExecution', id: 'exec-1', command: 'make', status: 'inProgress', aggregatedOutput: null } });
  // Within the throttle window nothing is re-sent; the output still accumulates.
  assert.deepEqual(translator.translate('item/commandExecution/outputDelta', { turnId: 'turn-1', itemId: 'exec-1', delta: 'a\n' }), []);
  const realNow = Date.now;
  Date.now = () => realNow() + 1000;
  try {
    assert.deepEqual(
      translator.translate('item/commandExecution/outputDelta', { turnId: 'turn-1', itemId: 'exec-1', delta: 'b\n' }),
      [{ type: 'item.updated', item: { id: 'exec-1', type: 'command_execution', command: 'make', aggregated_output: 'a\nb\n', status: 'in_progress' } }],
    );
  } finally {
    Date.now = realNow;
  }
});

test('a running command\'s live output keeps only its tail', () => {
  const translator = createCodexAppServerTranslator(() => 'turn-1');
  translator.translate('item/started', { turnId: 'turn-1', item: { type: 'commandExecution', id: 'exec-1', command: 'cat big.log', status: 'inProgress', aggregatedOutput: null } });
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    let last: Array<Record<string, any>> = [];
    for (let chunk = 0; chunk < 100; chunk += 1) {
      now += 1000;
      last = translator.translate('item/commandExecution/outputDelta', { turnId: 'turn-1', itemId: 'exec-1', delta: `${String(chunk).padStart(3, '0')}${'x'.repeat(1021)}` });
    }
    const output = String(last[0]?.item.aggregated_output);
    assert.ok(output.startsWith('[36 KB of earlier output not shown while the command runs]\n'), output.slice(0, 80));
    assert.ok(output.endsWith('x'.repeat(1021)));
    assert.ok(output.length < 64 * 1024 + 100, `live output is capped, got ${output.length}`);
  } finally {
    Date.now = realNow;
  }

  // The finished item carries the full output, uncut.
  const completed = translator.translate('item/completed', { turnId: 'turn-1', item: { type: 'commandExecution', id: 'exec-1', command: 'cat big.log', status: 'completed', aggregatedOutput: 'full', exitCode: 0 } });
  assert.equal(completed[0]?.item.aggregated_output, 'full');
});

test('the live tail never starts on half a character, and a long initial output is cut too', () => {
  const translator = createCodexAppServerTranslator(() => 'turn-1');
  const emoji = '\u{1F600}';
  // 64 KB + 1 code unit, so the cut would land on the emoji's second half.
  const initial = `${emoji}${'y'.repeat(64 * 1024 - 1)}`;
  translator.translate('item/started', { turnId: 'turn-1', item: { type: 'commandExecution', id: 'exec-2', command: 'run', status: 'inProgress', aggregatedOutput: initial } });
  const realNow = Date.now;
  Date.now = () => realNow() + 1000;
  try {
    const [update] = translator.translate('item/commandExecution/outputDelta', { turnId: 'turn-1', itemId: 'exec-2', delta: '' });
    const output = String(update?.item.aggregated_output);
    const body = output.slice(output.indexOf('\n') + 1);
    const firstCode = body.charCodeAt(0);
    assert.ok(!(firstCode >= 0xdc00 && firstCode <= 0xdfff), 'no lone low surrogate at the start');
    assert.ok(output.startsWith('[1 KB of earlier output not shown'), output.slice(0, 60));
    assert.ok(body.length <= 64 * 1024);
  } finally {
    Date.now = realNow;
  }
});

