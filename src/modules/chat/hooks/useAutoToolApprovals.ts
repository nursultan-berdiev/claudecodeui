import { useEffect, useRef } from 'react';
import type { PendingPermissionRequest, PermissionMode } from '@/shared/types';

type AutoToolApprovalsArgs = {
  permissionMode: PermissionMode;
  sessionId: string | null;
  pendingRequests: PendingPermissionRequest[];
  onDecision: (requestId: string, decision: { allow: boolean }) => void;
};

/** Used by ChatInterface to continue ordinary tool requests when the user switches a waiting chat to Auto. */
export function useAutoToolApprovals({ permissionMode, sessionId, pendingRequests, onDecision }: AutoToolApprovalsArgs) {
  // Replayed requests must not send the same approval twice while the server acknowledges it.
  const answeredRequests = useRef(new Set<string>());

  useEffect(() => {
    if (permissionMode !== 'auto' || !sessionId) return;
    for (const request of pendingRequests) {
      if (request.sessionId && request.sessionId !== sessionId) continue;
      if (['AskUserQuestion', 'ExitPlanMode', 'exit_plan_mode'].includes(request.toolName)) continue;
      // MCP callbacks can represent mandatory human input or an organization's approval policy.
      if (request.toolName.startsWith('mcp__') || answeredRequests.current.has(request.requestId)) continue;
      answeredRequests.current.add(request.requestId);
      onDecision(request.requestId, { allow: true });
    }
  }, [permissionMode, sessionId, pendingRequests, onDecision]);
}
