import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { completeComposerSkillSend, readComposerSkillIds, useComposerSkillSelection } from '@/modules/chat/hooks/useComposerSkillSelection';
import type { PermissionMode, Project, ProjectSession } from '@/shared/types';
import { resetUserPreferences } from '@/shared/userSettings';

const PROJECT: Project = { projectId: 'project-1', displayName: 'Project One', fullPath: '/tmp/project-one' };
const SESSION: ProjectSession = { id: 'session-1' };

/** Sends one message through the real composer and returns the options of its `chat.send`. */
const submit = async () => {
  const sent: { type: string; options?: Record<string, unknown> }[] = [];
  const view = renderHook(() => useChatComposerState({
    selectedProject: PROJECT, selectedSession: SESSION, currentSessionId: SESSION.id, provider: 'claude', permissionMode: 'default',
    cyclePermissionMode: () => undefined, resolvePermissionModeForProvider: () => 'default' as PermissionMode,
    currentProviderModel: 'test-model', currentProviderEffort: 'medium', isLoading: false, canAbortSession: false, tokenBudget: null,
    sendMessage: (message) => { sent.push(message as never); }, scrollToBottom: () => undefined, addMessage: () => undefined,
    setIsUserScrolledUp: () => undefined, setPendingPermissionRequests: () => undefined,
  }));
  await act(async () => { view.result.current.setInput('hello'); });
  await act(async () => { await view.result.current.handleSubmit({ preventDefault: () => undefined } as never); });
  view.unmount();
  return sent.find((message) => message.type === 'chat.send')?.options ?? {};
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })));
  resetUserPreferences();
  localStorage.clear();
});

afterEach(() => {
  resetUserPreferences();
  vi.unstubAllGlobals();
  localStorage.clear();
});

test('a picked skill goes with one message while a pinned skill stays for the whole chat', async () => {
  assert.equal('skillIds' in await submit(), false);
  const selection = renderHook(() => useComposerSkillSelection(SESSION.id));
  act(() => {
    selection.result.current.chooseOnce({ id: 'once', name: 'weekly-report' });
    selection.result.current.togglePin({ id: 'pinned', name: 'house-style' });
  });
  assert.deepEqual((await submit()).skillIds, ['once', 'pinned']);
  assert.equal(selection.result.current.oneTime, null);
  assert.deepEqual((await submit()).skillIds, ['pinned']);
  act(() => selection.result.current.togglePin({ id: 'pinned', name: 'house-style' }));
  assert.equal('skillIds' in await submit(), false);
});

test('pinning the one-message skill keeps it once, and a new chat hands its pins to the created session', () => {
  const selection = renderHook(() => useComposerSkillSelection('project:project-1'));
  act(() => {
    selection.result.current.chooseOnce({ id: 'draft-skill', name: 'draft' });
    selection.result.current.togglePin({ id: 'draft-skill', name: 'draft' });
  });
  assert.deepEqual(readComposerSkillIds('project:project-1'), ['draft-skill']);
  act(() => completeComposerSkillSend('project:project-1', 'new-session'));
  assert.deepEqual(readComposerSkillIds('project:project-1'), []);
  assert.deepEqual(readComposerSkillIds('new-session'), ['draft-skill']);
});
