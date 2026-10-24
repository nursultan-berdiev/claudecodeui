import assert from 'node:assert/strict';

import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

import { APP_VERSION } from '@/shared/constants';
import { useVersionCheck } from '@/shared/hooks/useVersionCheck';

afterEach(() => vi.unstubAllGlobals());

/**
 * The fork is updated by merging upstream and rebuilding the image, so the UI
 * must not look for GitHub releases or offer an in-app update. Only the local
 * /health request (restart hint) is allowed.
 */
test('the version check never contacts GitHub and exposes no update state', async () => {
  const fetchMock = vi.fn(async (_url: string) => ({ json: async () => ({ version: APP_VERSION }) }));
  vi.stubGlobal('fetch', fetchMock);

  const { result } = renderHook(() => useVersionCheck());
  await waitFor(() => assert.equal(result.current.runningVersion, APP_VERSION));

  assert.deepEqual(fetchMock.mock.calls.map(([url]) => url), ['/health']);
  assert.equal(result.current.currentVersion, APP_VERSION);
  assert.equal(result.current.restartRequired, false);
  assert.equal('updateAvailable' in result.current, false);
});
