import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import { createClaudeLiveStream } from '@/modules/providers/list/claude/claude-live-stream.provider.js';
import { mapCliOptionsToSDK, queryClaudeSDK } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import type { NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

/**
 * The Claude runtime asks the SDK for partial messages and turns the main
 * thread's text deltas into `stream_delta`/`stream_end` frames; the finished
 * assistant row that follows each block names the bubble it replaces.
 */

const NATIVE_ID = 'native-stream-session';
const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });

const partial = (event: Record<string, unknown>, parentToolUseId: string | null = null) => ({
  type: 'stream_event', session_id: NATIVE_ID, parent_tool_use_id: parentToolUseId, uuid: 'u', event,
});
const messageStart = (id: string) => partial({ type: 'message_start', message: { id, role: 'assistant', content: [] } });
const blockStart = (index: number, type: string) => partial({ type: 'content_block_start', index, content_block: { type } });
const textDelta = (index: number, text: string) => partial({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } });
const blockStop = (index: number) => partial({ type: 'content_block_stop', index });
const assistant = (id: string, content: Array<Record<string, unknown>>, parentToolUseId: string | null = null) => ({
  type: 'assistant', session_id: NATIVE_ID, parent_tool_use_id: parentToolUseId, uuid: `uuid-${id}`,
  message: { id, role: 'assistant', model: 'claude-opus-5', content },
});

/** Feeds SDK messages through a live stream the way the runtime loop does. */
function drive(messages: Array<Record<string, unknown>>): NormalizedMessage[] {
  const sent: NormalizedMessage[] = [];
  const stream = createClaudeLiveStream((message) => { sent.push(message); }, () => NATIVE_ID);
  for (const message of messages) {
    if (stream.handlePartial(message)) continue;
    const rows = sessions.normalizeMessage(message, NATIVE_ID);
    stream.claimFinishedRows(message, rows);
    sent.push(...rows);
  }
  return sent;
}

const summarize = (sent: NormalizedMessage[]) => sent.map((message) => {
  if (message.kind === 'stream_delta') return `delta ${message.streamId} ${message.content}`;
  if (message.kind === 'stream_end') return `end ${message.streamId}${message.discard ? ' discard' : ''}`;
  if (message.kind === 'text') return `text ${message.content}${message.replacesStreamId ? ` replaces ${message.replacesStreamId}` : ''}`;
  return message.kind;
});

test('Claude runs ask the SDK for partial messages', () => {
  assert.equal(mapCliOptionsToSDK({}).includePartialMessages, true);
});

test('a text block streams, ends, and is replaced by its finished row', () => {
  const sent = drive([
    messageStart('msg_1'),
    blockStart(0, 'text'),
    textDelta(0, 'Hel'),
    textDelta(0, 'lo'),
    blockStop(0),
    assistant('msg_1', [{ type: 'text', text: 'Hello' }]),
  ]);

  assert.deepEqual(summarize(sent), [
    'delta msg_1:0 Hel',
    'delta msg_1:0 lo',
    'end msg_1:0',
    'text Hello replaces msg_1:0',
  ]);
  const finished = sent.at(-1);
  assert.equal(finished?.model, 'claude-opus-5', 'the finished row keeps what the stream cannot know');
});

test('the finished row the CLI sends before the block stops still replaces the bubble', () => {
  // The order the CLI actually yields: the block's finished message, then its stop.
  const sent = drive([
    messageStart('msg_1'),
    blockStart(0, 'thinking'),
    blockStop(0),
    blockStart(1, 'text'),
    textDelta(1, 'Hel'),
    textDelta(1, 'lo'),
    assistant('msg_1', [{ type: 'text', text: 'Hello' }]),
    blockStop(1),
    partial({ type: 'message_stop' }),
  ]);

  assert.deepEqual(summarize(sent), [
    'delta msg_1:1 Hel',
    'delta msg_1:1 lo',
    'end msg_1:1',
    'text Hello replaces msg_1:1',
  ]);
});

test('thinking, tool input and subagent partials send nothing', () => {
  const sent = drive([
    messageStart('msg_1'),
    blockStart(0, 'thinking'),
    partial({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } }),
    blockStop(0),
    blockStart(1, 'tool_use'),
    partial({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"a"' } }),
    blockStop(1),
    partial({ type: 'message_start', message: { id: 'msg_sub' } }, 'toolu_agent'),
    partial({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }, 'toolu_agent'),
    partial({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'subagent prose' } }, 'toolu_agent'),
  ]);

  assert.deepEqual(sent, []);
});

test('every streamed block of one message is claimed in order, whether rows come per block or together', () => {
  const perBlock = drive([
    messageStart('msg_1'),
    blockStart(0, 'text'), textDelta(0, 'First'), blockStop(0),
    assistant('msg_1', [{ type: 'text', text: 'First' }]),
    blockStart(1, 'tool_use'), blockStop(1),
    assistant('msg_1', [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }]),
    blockStart(2, 'text'), textDelta(2, 'Second'), blockStop(2),
    assistant('msg_1', [{ type: 'text', text: 'Second' }]),
  ]);
  const together = drive([
    messageStart('msg_1'),
    blockStart(0, 'text'), textDelta(0, 'First'), blockStop(0),
    blockStart(1, 'tool_use'), blockStop(1),
    blockStart(2, 'text'), textDelta(2, 'Second'), blockStop(2),
    assistant('msg_1', [
      { type: 'text', text: 'First' },
      { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} },
      { type: 'text', text: 'Second' },
    ]),
  ]);

  for (const sent of [perBlock, together]) {
    assert.deepEqual(
      summarize(sent).filter((line) => line.startsWith('text')),
      ['text First replaces msg_1:0', 'text Second replaces msg_1:2'],
    );
  }
});

test('an attempt the CLI retried is discarded instead of left beside the retry', () => {
  const sent = drive([
    messageStart('msg_1'),
    blockStart(0, 'text'), textDelta(0, 'Half a rep'),
    messageStart('msg_2'),
    blockStart(0, 'text'), textDelta(0, 'Whole reply'), blockStop(0),
    assistant('msg_2', [{ type: 'text', text: 'Whole reply' }]),
  ]);

  assert.deepEqual(summarize(sent), [
    'delta msg_1:0 Half a rep',
    'end msg_1:0 discard',
    'delta msg_2:0 Whole reply',
    'end msg_2:0',
    'text Whole reply replaces msg_2:0',
  ]);
});

test('a finished message without a stream of its own supersedes a partial attempt', () => {
  const sent = drive([
    messageStart('msg_1'),
    blockStart(0, 'text'), textDelta(0, 'Half'), blockStop(0),
    assistant('msg_fallback', [{ type: 'text', text: 'Full answer' }]),
  ]);

  assert.deepEqual(summarize(sent), [
    'delta msg_1:0 Half',
    'end msg_1:0',
    'end msg_1:0 discard',
    'text Full answer',
  ]);
});

test('an empty text block is discarded rather than left for a row that never comes', () => {
  const sent = drive([messageStart('msg_1'), blockStart(0, 'text'), blockStop(0)]);
  assert.deepEqual(summarize(sent), ['end msg_1:0 discard']);
});

test('the runtime sends stream frames for partials and the finished row after them', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-live-stream-'));
  const script = [
    { type: 'system', subtype: 'init', session_id: NATIVE_ID },
    messageStart('msg_1'),
    blockStart(0, 'text'),
    textDelta(0, 'Streamed'),
    blockStop(0),
    assistant('msg_1', [{ type: 'text', text: 'Streamed' }]),
    { type: 'result', subtype: 'success', session_id: NATIVE_ID, is_error: false },
  ];
  const seen: { options?: Record<string, unknown> } = {};
  const createQuery: NonNullable<ProviderRuntimeContext['createQuery']> = ({ prompt, options }) => {
    seen.options = options as Record<string, unknown>;
    void (async () => { for await (const _message of prompt) { /* the CLI reads its stdin */ } })();
    const iterator = (async function* () { yield* script; })();
    return Object.assign(iterator, { interrupt: async () => {}, stopTask: async () => {} });
  };
  const sent: NormalizedMessage[] = [];
  const writer = { send: (message: NormalizedMessage) => { sent.push(message); }, userId: null };
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
    createQuery,
  };

  try {
    await queryClaudeSDK('hello', { sessionId: 'app-stream-session', cwd }, writer as never, context);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }

  assert.equal(seen.options?.includePartialMessages, true);
  assert.deepEqual(
    summarize(sent).filter((line) => line !== 'session_created' && line !== 'status'),
    ['delta msg_1:0 Streamed', 'end msg_1:0', 'text Streamed replaces msg_1:0', 'complete'],
  );
});

test('history never turns a recorded partial into a row', () => {
  assert.deepEqual(sessions.normalizeMessage(textDelta(0, 'x'), NATIVE_ID), []);
});
