import assert from 'node:assert/strict';

import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { resetUserPreferences } from '@/shared/userSettings';

const okJson = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });
const codexCatalog = {
  OPTIONS: [{ value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' }, { value: 'gpt-5.4', label: 'GPT-5.4' }],
  DEFAULT: 'gpt-5.6-sol',
};

vi.mock('@/shared/api', () => ({
  api: {
    user: {
      preferences: () => okJson({ success: true, preferences: {} }),
      savePreferences: () => okJson({ success: true, preferences: {} }),
    },
    providers: {
      models: (provider: string) => okJson(provider === 'codex' ? { success: true, data: { models: codexCatalog } } : { success: true, data: null }),
      capabilities: () => okJson({ success: true, data: null }),
      sessionActiveModel: () => okJson({ success: true, data: null }),
    },
  },
}));

beforeEach(() => { localStorage.clear(); resetUserPreferences(); });
afterEach(() => { vi.resetModules(); });

const renderProviderState = async () => {
  const { useChatProviderState } = await import('@/modules/chat/hooks/useChatProviderState');
  return renderHook(() => useChatProviderState({ selectedSession: null, selectedProject: null }));
};

test('without a stored choice the server default replaces the built-in fallback model', async () => {
  const { result } = await renderProviderState();
  await waitFor(() => assert.equal(result.current.providerModels.codex, 'gpt-5.6-sol'));
  assert.equal(localStorage.getItem('codex-model'), 'gpt-5.6-sol');
});

test('a stored choice the server still offers is kept', async () => {
  localStorage.setItem('codex-model', 'gpt-5.4');
  const { result } = await renderProviderState();
  await waitFor(() => assert.equal(result.current.providerModels.codex, 'gpt-5.4'));
});

test('a stored choice the server no longer offers falls back to the server default', async () => {
  localStorage.setItem('codex-model', 'gpt-4-retired');
  const { result } = await renderProviderState();
  await waitFor(() => assert.equal(result.current.providerModels.codex, 'gpt-5.6-sol'));
});
