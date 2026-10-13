import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { ProjectSession } from '@/shared/types';

const okJson = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });

vi.mock('@/shared/api', () => ({
  api: {
    user: {
      preferences: () => okJson({ success: true, preferences: {} }),
      savePreferences: () => okJson({ success: true, preferences: {} }),
    },
    providers: {
      models: () => okJson({ success: true, data: null }),
      capabilities: () => okJson({ success: true, data: null }),
      sessionActiveModel: () => okJson({ success: true, data: null }),
    },
  },
}));

// resetModules gives every test a fresh preference store, and that store starts from localStorage.
beforeEach(() => { localStorage.clear(); });
afterEach(() => { vi.resetModules(); });

const claudeSession = { id: 'claude-session', __provider: 'claude' } as unknown as ProjectSession;

// The hook and the preference writer must share one module instance, so both load after resetModules.
const loadModules = async () => ({
  ...(await import('@/modules/chat/hooks/useChatProviderState')),
  ...(await import('@/shared/selectedProvider')),
});

test('an agent chosen in the New chat dialog reaches a new-chat composer that is already open', async () => {
  const { useChatProviderState, writeSelectedProvider } = await loadModules();
  const { result } = renderHook(() => useChatProviderState({ selectedSession: null, selectedProject: null }));
  assert.equal(result.current.provider, 'claude');

  act(() => writeSelectedProvider('codex'));

  await waitFor(() => assert.equal(result.current.provider, 'codex'));
});

test('a choice made in the dialog neither switches an open chat nor gets overwritten by it', async () => {
  const { useChatProviderState, writeSelectedProvider, readSelectedProvider } = await loadModules();
  const seen: string[] = [];
  const { result } = renderHook(() => {
    const state = useChatProviderState({ selectedSession: claudeSession, selectedProject: null });
    seen.push(state.provider);
    return state;
  });
  await waitFor(() => assert.equal(result.current.provider, 'claude'));

  act(() => writeSelectedProvider('codex'));

  assert.equal(result.current.provider, 'claude');
  assert.equal(seen.includes('codex'), false);
  assert.equal(readSelectedProvider(), 'codex');
});

test('leaving a chat for a new one picks up the agent chosen while that chat was open', async () => {
  const { useChatProviderState, writeSelectedProvider } = await loadModules();
  const { result, rerender } = renderHook(
    ({ session }: { session: ProjectSession | null }) => useChatProviderState({ selectedSession: session, selectedProject: null }),
    { initialProps: { session: claudeSession as ProjectSession | null } },
  );
  await waitFor(() => assert.equal(result.current.provider, 'claude'));

  act(() => writeSelectedProvider('codex'));
  rerender({ session: null });

  await waitFor(() => assert.equal(result.current.provider, 'codex'));
});
