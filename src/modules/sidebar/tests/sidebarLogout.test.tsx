import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { MemoryRouter } from 'react-router-dom';
import { test, vi } from 'vitest';

import SidebarCollapsed from '@/modules/sidebar/SidebarCollapsed';
import SidebarFooter from '@/modules/sidebar/SidebarFooter';

const logout = vi.fn();
const authUser: { id: number; username: string; role: string } = { id: 2, username: 'claims1', role: 'member' };
vi.mock('@/modules/auth', () => ({ useAuth: () => ({ user: authUser, logout }) }));
vi.mock('@/modules/company', () => ({ NewChatButton: () => null }));

const t = ((key: string) => (key === 'common:navigation.logout' ? 'Logout' : key)) as unknown as TFunction;

const renderFooter = (updates: { restartRequired?: boolean } = {}) => render(
  <MemoryRouter>
    <SidebarFooter restartRequired={updates.restartRequired ?? false} onShowSettings={() => {}} t={t} />
  </MemoryRouter>,
);

test('the expanded sidebar names the signed-in user and logs out from their menu', () => {
  logout.mockClear();
  renderFooter();

  fireEvent.click(screen.getByRole('button', { name: 'claims1' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Logout' }));
  assert.equal(logout.mock.calls.length, 1);
});

test('the restart notice is shown to administrators only', () => {
  authUser.role = 'member';
  const member = renderFooter({ restartRequired: true });
  assert.equal(screen.queryByText('version.restartRequired'), null);
  member.unmount();

  authUser.role = 'admin';
  renderFooter({ restartRequired: true });
  assert.ok(screen.getByText('version.restartRequired'));
  authUser.role = 'member';
});

test('the collapsed sidebar keeps a logout action', () => {
  logout.mockClear();
  render(
    <SidebarCollapsed onExpand={() => {}} onNewSession={() => {}} onShowSettings={() => {}} restartRequired={false} t={t} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Logout' }));
  assert.equal(logout.mock.calls.length, 1);
});
