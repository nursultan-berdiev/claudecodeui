import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { NormalizedMessage } from '@/shared/types';

/**
 * A sent message's optimistic echo is stamped by the browser's clock, the
 * reply streaming under it by the server's. When the browser ran ahead, the
 * reply sorted above the question until the turn ended and the persisted rows
 * replaced both. Live rows must keep the order they arrived in.
 */

const sessionMessages = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    providers: {
      sessionMessages: (...args: unknown[]) => sessionMessages(...args),
    },
  },
}));

const HISTORY: NormalizedMessage[] = [
  { id: 'h1', kind: 'text', role: 'user', provider: 'claude', sessionId: 's', content: 'earlier question', timestamp: '2026-10-28T06:00:00.000Z', transcriptAnchorId: 'u1' },
  { id: 'h2', kind: 'text', role: 'assistant', provider: 'claude', sessionId: 's', content: 'earlier answer', timestamp: '2026-10-28T06:00:05.000Z' },
] as NormalizedMessage[];

beforeEach(() => {
  sessionMessages.mockReset();
  sessionMessages.mockResolvedValue({
    ok: true,
    json: async () => ({ data: { messages: HISTORY, total: HISTORY.length, hasMore: false } }),
  });
});

afterEach(() => {
  vi.resetModules();
});

test('a reply streaming under a question stays under it when the browser clock runs ahead', async () => {
  const { useSessionStore } = await import('@/modules/chat/hooks/useSessionStore');
  const { result } = renderHook(() => useSessionStore());
  await act(async () => {
    await result.current.fetchFromServer('s', { limit: 20, offset: 0 });
  });

  act(() => {
    // Sent at 06:10:03 by a browser three seconds ahead of the server...
    result.current.appendRealtime('s', {
      id: 'local_1', kind: 'text', role: 'user', provider: 'claude', sessionId: 's',
      content: 'new question', timestamp: '2026-10-28T06:10:03.000Z',
    } as NormalizedMessage);
    // ...answered from 06:10:01 server time.
    result.current.updateStreaming('s', 'The answer so far', 'claude', { streamId: 'msg_1:0', timestamp: '2026-10-28T06:10:01.000Z' });
  });

  assert.deepEqual(
    result.current.getMessages('s').map((message) => message.content),
    ['earlier question', 'earlier answer', 'new question', 'The answer so far'],
  );

  act(() => {
    result.current.finalizeStreaming('s');
    result.current.appendRealtime('s', {
      id: 'tool-1', kind: 'tool_use', provider: 'claude', sessionId: 's', toolName: 'Read', toolId: 'toolu_1',
      timestamp: '2026-10-28T06:10:02.000Z',
    } as NormalizedMessage);
  });

  assert.deepEqual(
    result.current.getMessages('s').map((message) => message.content ?? message.toolName),
    ['earlier question', 'earlier answer', 'new question', 'The answer so far', 'Read'],
  );
});
