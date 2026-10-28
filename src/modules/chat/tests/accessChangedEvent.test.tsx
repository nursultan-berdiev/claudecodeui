import assert from 'node:assert/strict';

import { renderHook } from '@testing-library/react';
import { test } from 'vitest';

import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import type { ServerEvent, ProjectSession } from '@/shared/types';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';

/**
 * The server broadcasts `company_access_changed` without a session id whenever
 * sharing, departments or skills change. It must not land in the viewed chat
 * as a message: it has no id, and the store's merge crashed on it.
 */
test('an access change broadcast is not stored as a message of the viewed chat', () => {
  let listener: ((event: ServerEvent) => void) | null = null;
  const appended: unknown[] = [];
  renderHook(() => useChatRealtimeHandlers({
    isActive: true,
    subscribe: (fn) => {
      listener = fn;
      return () => { listener = null; };
    },
    provider: 'claude',
    selectedSession: { id: 'viewed-session' } as ProjectSession,
    currentSessionId: 'viewed-session',
    setTokenBudget: () => {},
    pendingPermissionRequests: [],
    setPendingPermissionRequests: () => {},
    streamBuffersRef: { current: new Map() },
    lastSeqRef: { current: new Map() },
    statusCheckSentAtRef: { current: new Map() },
    requestLatestMessages: async () => {},
    sessionStore: { appendRealtime: (_sid: string, message: unknown) => appended.push(message) } as unknown as SessionStore,
  }));

  listener!({ kind: 'company_access_changed' } as unknown as ServerEvent);

  assert.deepEqual(appended, []);
});
