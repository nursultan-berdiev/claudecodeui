import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import { test, vi } from 'vitest';
import type * as ReactI18next from 'react-i18next';

import type { PendingPermissionRequest } from '@/shared/types';

/**
 * The permission card is how a member lets the agent run a command. It was
 * restyled and its labels moved to translations; the decisions each button
 * sends must stay exactly what they were.
 */

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactI18next>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

const { default: PermissionRequestsBanner } = await import('@/modules/chat/composer/PermissionRequestsBanner');

const request: PendingPermissionRequest = {
  requestId: 'req-1',
  toolName: 'Bash',
  input: { command: 'docli word read report.docx' },
};

const renderBanner = (requests: PendingPermissionRequest[]) => {
  const handlePermissionDecision = vi.fn();
  const handleGrantToolPermission = vi.fn(() => ({ success: true }));
  render(
    <PermissionRequestsBanner
      pendingPermissionRequests={requests}
      handlePermissionDecision={handlePermissionDecision}
      handleGrantToolPermission={handleGrantToolPermission}
    />,
  );
  return { handlePermissionDecision, handleGrantToolPermission };
};

test('the card is labelled through translations, not hardcoded English', () => {
  renderBanner([request]);

  assert.ok(screen.getByText('chat:permissions.request.title'));
  assert.ok(screen.getByRole('button', { name: 'chat:permissions.request.allowOnce' }));
  assert.ok(screen.getByRole('button', { name: 'chat:permissions.request.deny' }));
  assert.equal(screen.queryByText('Allow once'), null);
});

test('Allow once approves only this request', () => {
  const { handlePermissionDecision } = renderBanner([request]);

  fireEvent.click(screen.getByRole('button', { name: 'chat:permissions.request.allowOnce' }));

  assert.deepEqual(handlePermissionDecision.mock.calls, [['req-1', { allow: true }]]);
});

test('Deny refuses the request with the denial message', () => {
  const { handlePermissionDecision } = renderBanner([request]);

  fireEvent.click(screen.getByRole('button', { name: 'chat:permissions.request.deny' }));

  assert.deepEqual(handlePermissionDecision.mock.calls, [['req-1', { allow: false, message: 'chat:misc.userDeniedTool' }]]);
});

test('a plan approval stays out of the banner, it belongs to the plan card', () => {
  renderBanner([{ requestId: 'req-2', toolName: 'ExitPlanMode', input: {} }]);

  assert.equal(screen.queryByRole('alert'), null);
});
