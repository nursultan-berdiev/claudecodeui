import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import { getIntrinsicMessageKey } from '@/modules/chat/utils/messageKeys';
import type { LiveStreamBuffer, ProjectSession, ServerEvent } from '@/shared/types';

/**
 * Each session's streaming reply has its own buffer, and a streamed bubble is
 * swapped in place for the finished row the provider sends for its block —
 * one bubble per reply, never two, whichever session is on screen.
 */

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const renderLiveChat = (viewedSessionId = 'viewed') => {
  const store = renderHook(() => useSessionStore());
  let listener: ((event: ServerEvent) => void) | null = null;
  const streamBuffersRef = { current: new Map<string, LiveStreamBuffer>() };

  renderHook(() => useChatRealtimeHandlers({
    isActive: true,
    subscribe: (fn) => {
      listener = fn;
      return () => { listener = null; };
    },
    provider: 'claude',
    selectedSession: { id: viewedSessionId } as ProjectSession,
    currentSessionId: viewedSessionId,
    setTokenBudget: () => {},
    pendingPermissionRequests: [],
    setPendingPermissionRequests: () => {},
    streamBuffersRef,
    lastSeqRef: { current: new Map() },
    statusCheckSentAtRef: { current: new Map() },
    requestLatestMessages: async () => {},
    sessionStore: store.result.current,
  }));

  const dispatch = (event: Record<string, unknown>) => {
    act(() => { listener?.({ provider: 'claude', timestamp: '2026-10-28T10:00:00.000Z', ...event } as ServerEvent); });
  };
  const publish = () => { act(() => { vi.advanceTimersByTime(150); }); };
  const rows = (sessionId: string) => store.result.current.getMessages(sessionId);
  return { dispatch, publish, rows, streamBuffersRef };
};

const delta = (sessionId: string, streamId: string | null, content: string) => ({
  kind: 'stream_delta', sessionId, content, ...(streamId ? { streamId } : {}),
});

test('two sessions streaming at once keep their own text', () => {
  const { dispatch, publish, rows } = renderLiveChat();

  dispatch(delta('viewed', 'a:0', 'Viewed '));
  dispatch(delta('background', 'b:0', 'Background '));
  dispatch(delta('viewed', 'a:0', 'reply'));
  dispatch(delta('background', 'b:0', 'reply'));
  publish();

  assert.deepEqual(rows('viewed').map((row) => row.content), ['Viewed reply']);
  assert.deepEqual(rows('background').map((row) => row.content), ['Background reply']);
});

test('the finished row takes the streamed bubble\'s place and key', () => {
  const { dispatch, publish, rows } = renderLiveChat();

  dispatch(delta('viewed', 'msg_1:0', 'Hel'));
  publish();
  const streamingKey = getIntrinsicMessageKey(normalizedToChatMessages(rows('viewed'))[0]);
  dispatch(delta('viewed', 'msg_1:0', 'lo'));
  dispatch({ kind: 'stream_end', sessionId: 'viewed', streamId: 'msg_1:0' });
  dispatch({
    kind: 'text', role: 'assistant', id: 'uuid-1_0', sessionId: 'viewed', content: 'Hello',
    model: 'claude-opus-5', replacesStreamId: 'msg_1:0', timestamp: '2026-10-28T10:00:05.000Z',
  });

  const live = rows('viewed');
  assert.equal(live.length, 1);
  assert.equal(live[0].id, 'uuid-1_0');
  assert.equal(live[0].content, 'Hello');
  assert.equal(live[0].model, 'claude-opus-5');
  assert.equal(live[0].timestamp, '2026-10-28T10:00:00.000Z', 'the bubble does not move');
  const finishedKey = getIntrinsicMessageKey(normalizedToChatMessages(live)[0]);
  assert.equal(finishedKey, streamingKey);
});

test('a discarded block takes its bubble with it', () => {
  const { dispatch, publish, rows } = renderLiveChat();

  dispatch(delta('viewed', 'msg_1:0', 'Half a rep'));
  publish();
  dispatch({ kind: 'stream_end', sessionId: 'viewed', streamId: 'msg_1:0', discard: true });
  dispatch(delta('viewed', 'msg_2:0', 'Whole reply'));
  dispatch({ kind: 'stream_end', sessionId: 'viewed', streamId: 'msg_2:0' });

  assert.deepEqual(rows('viewed').map((row) => row.content), ['Whole reply']);
});

test('prose after a tool call starts a new bubble below it', () => {
  const { dispatch, publish, rows } = renderLiveChat();

  dispatch(delta('viewed', null, 'Looking at the file. '));
  publish();
  dispatch({ kind: 'tool_use', sessionId: 'viewed', id: 'tool-row', toolName: 'Read', toolId: 'toolu_1', toolInput: {} });
  dispatch(delta('viewed', null, 'It says hello.'));
  publish();

  assert.deepEqual(
    rows('viewed').map((row) => `${row.kind}:${row.content ?? row.toolName}`),
    ['text:Looking at the file. ', 'tool_use:Read', 'stream_delta:It says hello.'],
  );
});

test('a delta for a new block finishes the previous bubble', () => {
  const { dispatch, rows } = renderLiveChat();

  dispatch(delta('viewed', 'msg_1:0', 'First'));
  dispatch(delta('viewed', 'msg_2:0', 'Second'));
  dispatch({ kind: 'complete', sessionId: 'viewed', exitCode: 0, success: true });

  assert.deepEqual(rows('viewed').map((row) => `${row.kind}:${row.content}`), ['text:First', 'text:Second']);
});

test('complete publishes what is still buffered', () => {
  const { dispatch, rows, streamBuffersRef } = renderLiveChat();

  dispatch(delta('viewed', null, 'Cursor never sends stream_end'));
  dispatch({ kind: 'complete', sessionId: 'viewed', exitCode: 0, success: true });

  assert.deepEqual(rows('viewed').map((row) => `${row.kind}:${row.content}`), ['text:Cursor never sends stream_end']);
  assert.equal(streamBuffersRef.current.size, 0);
});
