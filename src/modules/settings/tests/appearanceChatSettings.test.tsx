import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { beforeEach, test, vi } from 'vitest';

import { UiPreferencesProvider, useUiPreferences } from '@/shared/context/UiPreferencesContext';
import { resetUserPreferences } from '@/shared/userSettings';

/**
 * The quick settings drawer is gone; its chat toggles live in Settings →
 * Appearance → Chat. Reasoning is off until the user turns it on, and the raw
 * tool parameters are an administrator's debugging aid.
 */

let role = 'member';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/modules/auth', () => ({ useAuth: () => ({ user: { id: 1, username: 'u', role } }) }));
vi.mock('@/modules/i18n', () => ({ LanguageSelector: () => null }));
vi.mock('@/shared/context/ThemeContext', () => ({ useTheme: () => ({ themeMode: 'system', setThemeMode: () => {} }) }));

const { default: AppearanceSettingsTab } = await import('@/modules/settings/tabs/AppearanceSettingsTab');

const noop = () => {};
const seen: { showReasoning?: boolean } = {};

function PreferenceProbe() {
  const { showReasoning } = useUiPreferences();
  React.useEffect(() => {
    seen.showReasoning = showReasoning;
  }, [showReasoning]);
  return null;
}

const renderTab = () => render(
  <UiPreferencesProvider>
    <AppearanceSettingsTab
      projectSortOrder="name"
      onProjectSortOrderChange={noop}
      codeEditorSettings={{ theme: 'dark', wordWrap: false, showMinimap: true, lineNumbers: true, fontSize: '14' } as never}
      onCodeEditorWordWrapChange={noop}
      onCodeEditorShowMinimapChange={noop}
      onCodeEditorLineNumbersChange={noop}
      onCodeEditorFontSizeChange={noop}
    />
    <PreferenceProbe />
  </UiPreferencesProvider>,
);

beforeEach(() => {
  localStorage.clear();
  resetUserPreferences();
  role = 'member';
});

test('reasoning starts hidden and the Chat section turns it on', () => {
  renderTab();
  const toggle = screen.getByRole('switch', { name: 'quickSettings.showThinking' });

  assert.equal(toggle.getAttribute('aria-checked'), 'false');
  fireEvent.click(toggle);
  assert.equal(seen.showReasoning, true);
});

test('only administrators see the raw tool parameters switch', () => {
  const member = renderTab();
  assert.equal(screen.queryByRole('switch', { name: 'quickSettings.showRawParameters' }), null);
  assert.ok(screen.getByRole('switch', { name: 'quickSettings.sendByCtrlEnter' }));
  member.unmount();

  role = 'admin';
  renderTab();
  assert.ok(screen.getByRole('switch', { name: 'quickSettings.showRawParameters' }));
});
