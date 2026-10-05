import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { test, vi } from 'vitest';

import SidebarCollapsed from '@/modules/sidebar/SidebarCollapsed';
import SidebarFooter from '@/modules/sidebar/SidebarFooter';

const logout = vi.fn();
vi.mock('@/modules/auth', () => ({ useAuth: () => ({ user: { id: 2, username: 'claims1' }, logout }) }));
vi.mock('@/modules/company', () => ({ NewChatButton: () => null }));

const t = ((key: string) => (key === 'common:navigation.logout' ? 'Logout' : key)) as unknown as TFunction;

test('the expanded sidebar names the signed-in user and logs out', () => {
  logout.mockClear();
  render(
    <SidebarFooter updateAvailable={false} restartRequired={false} releaseInfo={null} latestVersion={null}
      currentVersion="1.0.0" onShowVersionModal={() => {}} onShowSettings={() => {}} t={t} />,
  );
  const buttons = screen.getAllByRole('button', { name: 'Logout (claims1)' });
  fireEvent.click(buttons[0]);
  assert.equal(logout.mock.calls.length, 1);
});

test('the collapsed sidebar keeps a logout action', () => {
  logout.mockClear();
  render(
    <SidebarCollapsed onExpand={() => {}} onShowSettings={() => {}} updateAvailable={false} restartRequired={false}
      onShowVersionModal={() => {}} t={t} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Logout' }));
  assert.equal(logout.mock.calls.length, 1);
});
