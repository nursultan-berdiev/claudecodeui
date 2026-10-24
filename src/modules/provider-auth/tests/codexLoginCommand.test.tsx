import assert from 'node:assert/strict';

import { cleanup, render } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

const { commands } = vi.hoisted(() => ({ commands: [] as string[] }));
vi.mock('@/modules/standalone-shell', () => ({
  StandaloneShell: ({ command }: { command: string }) => { commands.push(command); return null; },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.resetModules(); commands.length = 0; });

const renderCodexLogin = async () => {
  const { default: ProviderLoginModal } = await import('@/modules/provider-auth/ProviderLoginModal');
  render(<ProviderLoginModal isOpen provider="codex" onClose={() => {}} />);
  return commands.at(-1);
};

test('a container build signs Codex in with a device code instead of a localhost callback', async () => {
  vi.stubEnv('VITE_CLOUDCLI_CONTAINER_DEPLOYMENT', 'true');
  assert.equal(await renderCodexLogin(), 'codex login --device-auth');
});

test('a local install keeps the browser sign-in', async () => {
  vi.stubEnv('VITE_CLOUDCLI_CONTAINER_DEPLOYMENT', 'false');
  assert.equal(await renderCodexLogin(), 'codex login');
});
