import assert from 'node:assert/strict';
import { renderHook } from '@testing-library/react';
import { test, vi } from 'vitest';
import { useAutoToolApprovals } from '@/modules/chat/hooks/useAutoToolApprovals';
import type { PendingPermissionRequest, PermissionMode } from '@/shared/types';

test('switching a waiting chat to Auto approves its tool once and preserves human questions', () => {
  const onDecision = vi.fn();
  const pendingRequests: PendingPermissionRequest[] = [
    { requestId: 'write', toolName: 'Write', sessionId: 'chat' },
    { requestId: 'question', toolName: 'AskUserQuestion', sessionId: 'chat' },
    { requestId: 'plan', toolName: 'ExitPlanMode', sessionId: 'chat' },
    { requestId: 'connector', toolName: 'mcp__connector__operation', sessionId: 'chat' },
    { requestId: 'other', toolName: 'Bash', sessionId: 'another-chat' },
  ];
  const { rerender } = renderHook(({ mode }: { mode: PermissionMode }) => useAutoToolApprovals({
    permissionMode: mode, sessionId: 'chat', pendingRequests, onDecision,
  }), { initialProps: { mode: 'plan' as PermissionMode } });
  assert.equal(onDecision.mock.calls.length, 0);
  rerender({ mode: 'auto' });
  assert.deepEqual(onDecision.mock.calls, [['write', { allow: true }]]);
  rerender({ mode: 'auto' });
  assert.equal(onDecision.mock.calls.length, 1);
});
