import assert from 'node:assert/strict';

import { beforeEach, test } from 'vitest';

import {
  readStoredUiPreferences,
  uiPreferencesReducer,
} from '@/shared/uiPreferences';
import type { UiPreferences } from '@/shared/types';
import { writeUserPreference, resetUserPreferences } from '@/shared/userSettings';

/**
 * These preferences were previously held by four independent useReducer
 * instances that reconciled through a CustomEvent, then by one localStorage
 * blob, and now by the server-backed preference store. Consolidating them has
 * to preserve the stored shape and the string/boolean coercion, or users lose
 * settings on upgrade.
 */

beforeEach(() => {
  localStorage.clear();
  // The preference store is a module-level singleton, so its in-memory copy
  // outlives localStorage.clear() and would leak one test's writes into the next.
  resetUserPreferences();
});

const storeUiPreferences = (value: unknown) => {
  writeUserPreference('uiPreferences', value);
};

const baseline = (): UiPreferences => readStoredUiPreferences();

test('a fresh install gets the documented defaults', () => {
  assert.deepEqual(readStoredUiPreferences(), {
    showRawParameters: false,
    showReasoning: false,
    sendByCtrlEnter: false,
    sidebarVisible: true,
    voiceEnabled: false,
    showTerminalTab: true,
    showFilesTab: true,
  });
});

test('the stored blob is read back', () => {
  storeUiPreferences({ showReasoning: true, voiceEnabled: true });

  const preferences = readStoredUiPreferences();
  assert.equal(preferences.showReasoning, true);
  assert.equal(preferences.voiceEnabled, true);
  assert.equal(preferences.sidebarVisible, true, 'unlisted keys keep their default');
});

test('values stored as strings are coerced, as older versions wrote them', () => {
  storeUiPreferences({ showReasoning: 'true', voiceEnabled: 'true' });

  const preferences = readStoredUiPreferences();
  assert.equal(preferences.showReasoning, true);
  assert.equal(preferences.voiceEnabled, true);
});

test('a stored value of the wrong type falls back instead of throwing', () => {
  storeUiPreferences('not an object');

  assert.equal(readStoredUiPreferences().showReasoning, false);
});

test('reasoning saved as shown under the old key stays hidden', () => {
  // The old key was written with every toggle, so `showThinking: true` is in
  // almost every stored blob; reading it would cancel the hidden-by-default switch.
  storeUiPreferences({ showThinking: true });

  assert.equal(readStoredUiPreferences().showReasoning, false);
});

test('setting a preference changes only that key', () => {
  const state = baseline();
  const next = uiPreferencesReducer(state, { type: 'set', key: 'showReasoning', value: true });

  assert.equal(next.showReasoning, true);
  assert.equal(next.sidebarVisible, state.sidebarVisible);
});

test('setting a preference to its current value keeps the same object', () => {
  const state = baseline();
  const next = uiPreferencesReducer(state, { type: 'set', key: 'showReasoning', value: false });

  assert.equal(next, state, 'a no-op must not wake consumers');
});

test('an unknown key is ignored', () => {
  const state = baseline();
  const next = uiPreferencesReducer(state, {
    type: 'set',
    key: 'notAPreference' as never,
    value: true,
  });

  assert.equal(next, state);
});

test('a cross-tab update applies every changed key at once', () => {
  const state = baseline();
  const next = uiPreferencesReducer(state, {
    type: 'set_many',
    value: { showReasoning: true, voiceEnabled: true },
  });

  assert.equal(next.showReasoning, true);
  assert.equal(next.voiceEnabled, true);
});

test('a cross-tab update with nothing new keeps the same object', () => {
  const state = baseline();
  const next = uiPreferencesReducer(state, {
    type: 'set_many',
    value: { showReasoning: state.showReasoning },
  });

  assert.equal(next, state);
});
