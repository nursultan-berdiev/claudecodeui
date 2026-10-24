import assert from 'node:assert/strict';

import { act, cleanup, renderHook, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, test, vi } from 'vitest';

import { AuthProvider, useAuth } from '@/modules/auth/context/AuthContext';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

function ErrorText() {
  return <p role="alert">{useAuth().error}</p>;
}

test('a rejected login shows the server message instead of crashing on the error object', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/auth/login') {
      return new Response(JSON.stringify({ success: false, error: { code: 'AUTH_INVALID_CREDENTIALS', message: 'Invalid username or password' } }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify(url === '/api/auth/status' ? { needsSetup: false } : {}), { status: url === '/api/auth/user' ? 401 : 200, headers: { 'Content-Type': 'application/json' } });
  }));
  const wrapper = ({ children }: { children: ReactNode }) => <AuthProvider>{children}<ErrorText /></AuthProvider>;
  const { result } = renderHook(() => useAuth(), { wrapper });
  await waitFor(() => assert.equal(result.current.isLoading, false));
  let outcome: Awaited<ReturnType<typeof result.current.login>> | undefined;
  await act(async () => { outcome = await result.current.login('claims1', 'wrong-password'); });
  assert.equal(outcome && !outcome.success ? outcome.error : undefined, 'Invalid username or password');
  assert.equal(screen.getByRole('alert').textContent, 'Invalid username or password');
});
