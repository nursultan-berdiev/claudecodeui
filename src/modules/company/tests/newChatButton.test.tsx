import assert from 'node:assert/strict';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

import { NewChatButton } from '@/modules/company/NewChatButton';

const { handleNewSession, writeSelectedProvider, createSession, projects } = vi.hoisted(() => ({
  handleNewSession: vi.fn(),
  writeSelectedProvider: vi.fn(),
  createSession: vi.fn(),
  projects: [
    { projectId: 'chats', fullPath: '/workspace/chats', displayName: 'Чаты' },
    { projectId: 'lesson', fullPath: '/workspace/lesson', displayName: 'lesson' },
  ],
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/shared/selectedProvider', () => ({ writeSelectedProvider }));
vi.mock('@/shared/api', () => ({
  api: { projects: async () => new Response(JSON.stringify(projects)), createProject: vi.fn(), providers: { createSession } },
  readApiJson: async (response: Response) => response.json(),
}));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

test('New chat opens the chosen project composer instead of creating a placeholder-named chat', async () => {
  render(<NewChatButton onOpenChat={handleNewSession} />);
  fireEvent.click(screen.getByRole('button', { name: 'company.newChat' }));
  await waitFor(() => assert.equal(screen.getAllByRole('option').length, 3));
  fireEvent.change(screen.getByRole('combobox', { name: 'company.provider' }), { target: { value: 'codex' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'company.project' }), { target: { value: '/workspace/lesson' } });
  fireEvent.click(screen.getByRole('button', { name: 'company.create' }));
  await waitFor(() => assert.equal(handleNewSession.mock.calls.length, 1));
  assert.equal(handleNewSession.mock.calls[0][0].projectId, 'lesson');
  assert.deepEqual(writeSelectedProvider.mock.calls, [['codex']]);
  assert.equal(createSession.mock.calls.length, 0);
  assert.equal(screen.queryByRole('dialog'), null);
});
