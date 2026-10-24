import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { AuthProvider } from '@/modules/auth/context/AuthContext';
import ProtectedRoute from '@/modules/auth/ProtectedRoute';
import { i18n } from '@/modules/i18n';

type PasswordRequest = { currentPassword: string; newPassword: string };

let passwordRequests: PasswordRequest[] = [];
let requestedPaths: string[] = [];
let currentPassword = 'temporary1';
let passwordChanged = false;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// Mirrors the server gate: until the change, everything but the session endpoints is refused.
const stubServer = () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    requestedPaths.push(url);
    if (url === '/api/auth/status') return json({ needsSetup: false });
    if (url === '/api/auth/user') {
      return json({ user: { id: 5, username: 'bob', role: 'member', must_change_password: passwordChanged ? 0 : 1 } });
    }
    if (url === '/api/auth/password') {
      const body = JSON.parse(String(init?.body)) as PasswordRequest;
      passwordRequests.push(body);
      if (body.currentPassword !== currentPassword) {
        return json({ success: false, error: { code: 'AUTH_INVALID_CURRENT_PASSWORD', message: 'Current password is incorrect' } }, 400);
      }
      passwordChanged = true;
      return json({ success: true, token: 'new.session.token', user: { id: 5, username: 'bob', role: 'member', must_change_password: 0 } });
    }
    if (!passwordChanged) return json({ error: 'Password change required', code: 'AUTH_PASSWORD_CHANGE_REQUIRED' }, 403);
    if (url === '/api/user/onboarding-status') return json({ hasCompletedOnboarding: true });
    return json({});
  }));
};

const preferenceRequests = () => requestedPaths.filter((path) => path.startsWith('/api/user/preferences'));

const fill = (label: string, value: string) => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};

const renderApp = () => render(
  <AuthProvider>
    <ProtectedRoute>
      <p>workspace</p>
    </ProtectedRoute>
  </AuthProvider>,
);

beforeEach(async () => {
  passwordRequests = [];
  requestedPaths = [];
  currentPassword = 'temporary1';
  passwordChanged = false;
  localStorage.setItem('auth-token', 'temporary-session-token');
  await i18n.changeLanguage('en');
  stubServer();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

test('a temporary password shows the change screen instead of the workspace', async () => {
  renderApp();

  await screen.findByRole('heading', { name: 'Change your password' });
  assert.equal(screen.queryByText('workspace'), null);
  assert.deepEqual(preferenceRequests(), []);
});

test('a successful change stores the new session and opens the workspace', async () => {
  renderApp();
  await screen.findByRole('heading', { name: 'Change your password' });

  fill('Current password', 'temporary1');
  fill('New password', 'my-own-password');
  fill('Confirm new password', 'my-own-password');
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
  });

  await screen.findByText('workspace');
  assert.deepEqual(passwordRequests, [{ currentPassword: 'temporary1', newPassword: 'my-own-password' }]);
  assert.equal(localStorage.getItem('auth-token'), 'new.session.token');
  // Preferences were withheld while gated and are loaded once the session is usable.
  await waitFor(() => assert.ok(preferenceRequests().length > 0));
});

test('a wrong current password keeps the user on the change screen with the server message', async () => {
  renderApp();
  await screen.findByRole('heading', { name: 'Change your password' });

  fill('Current password', 'not-the-temporary');
  fill('New password', 'my-own-password');
  fill('Confirm new password', 'my-own-password');
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
  });

  await waitFor(() => assert.ok(screen.getByText('Current password is incorrect')));
  assert.equal(screen.queryByText('workspace'), null);
  assert.equal(localStorage.getItem('auth-token'), 'temporary-session-token');
});

test('mismatched or unchanged passwords are rejected before reaching the server', async () => {
  renderApp();
  await screen.findByRole('heading', { name: 'Change your password' });

  fill('Current password', 'temporary1');
  fill('New password', 'my-own-password');
  fill('Confirm new password', 'my-other-password');
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
  });
  assert.ok(screen.getByText('The new passwords do not match.'));

  fill('New password', 'temporary1');
  fill('Confirm new password', 'temporary1');
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
  });
  assert.ok(screen.getByText('The new password must differ from the current one.'));
  assert.deepEqual(passwordRequests, []);
});
