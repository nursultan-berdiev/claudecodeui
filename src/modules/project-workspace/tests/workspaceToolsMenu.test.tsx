import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';
import type * as ReactI18next from 'react-i18next';

import type { UiPreferences } from '@/shared/types';

/**
 * The header's "…" menu replaced the workspace tab bar. It must offer exactly
 * the views the tab bar offered — Terminal to administrators who keep it on,
 * Files while it is on, Browser and Tasks when enabled, and plugins — and
 * disappear when there is nothing to offer.
 */

let role = 'member';
let preferences: Partial<UiPreferences> = {};
let plugins: { name: string; displayName: string; icon: string; enabled: boolean }[] = [];

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactI18next>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/modules/auth', () => ({ useAuth: () => ({ user: { id: 1, username: 'u', role } }) }));
vi.mock('@/modules/plugins', () => ({ usePlugins: () => ({ plugins }), PluginIcon: () => null }));
vi.mock('@/shared/context/UiPreferencesContext', () => ({
  useUiPreferences: () => ({ showTerminalTab: true, showFilesTab: true, ...preferences }),
}));

const { default: WorkspaceToolsMenu } = await import('@/modules/project-workspace/WorkspaceToolsMenu');

const renderMenu = (options: { tasks?: boolean; browser?: boolean } = {}) => {
  const setActiveTab = vi.fn();
  const view = render(
    <WorkspaceToolsMenu
      activeTab="chat"
      setActiveTab={setActiveTab}
      shouldShowTasksTab={Boolean(options.tasks)}
      shouldShowBrowserTab={Boolean(options.browser)}
    />,
  );
  return { ...view, setActiveTab };
};

const openMenuItems = () => {
  fireEvent.click(screen.getByRole('button', { name: 'tabs.views' }));
  return screen.getAllByRole('menuitemradio').map((item) => item.textContent);
};

beforeEach(() => {
  role = 'member';
  preferences = {};
  plugins = [];
});

test('a member gets Files but never the Terminal', () => {
  renderMenu();

  assert.deepEqual(openMenuItems(), ['tabs.files']);
});

test('an administrator gets the Terminal, Browser, Tasks and enabled plugins, and picking one opens it', () => {
  role = 'admin';
  plugins = [
    { name: 'notes', displayName: 'Notes', icon: 'icon.svg', enabled: true },
    { name: 'off', displayName: 'Disabled', icon: 'icon.svg', enabled: false },
  ];
  const { setActiveTab } = renderMenu({ tasks: true, browser: true });

  assert.deepEqual(openMenuItems(), ['tabs.shell', 'tabs.files', 'tabs.browser', 'tabs.tasks', 'Notes']);
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'tabs.shell' }));
  assert.deepEqual(setActiveTab.mock.calls, [['shell']]);
});

test('with every view turned off there is no menu at all', () => {
  preferences = { showFilesTab: false };
  renderMenu();

  assert.equal(screen.queryByRole('button', { name: 'tabs.views' }), null);
});
