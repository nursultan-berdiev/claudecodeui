import assert from 'node:assert/strict';

import { cleanup, render, screen } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { afterEach, test, vi } from 'vitest';

import SidebarProjectItem from '@/modules/sidebar/SidebarProjectItem';
import type { Project } from '@/shared/types';

const { auth } = vi.hoisted(() => ({ auth: { role: 'member' } }));
vi.mock('@/modules/auth', () => ({ useAuth: () => ({ user: { id: 2, username: 'claims1', role: auth.role } }) }));

afterEach(cleanup);

const noop = () => {};
const renderProject = () => render(
  <SidebarProjectItem
    project={{ projectId: 'chats', displayName: 'Чаты', fullPath: '/workspace/chats', sessionMeta: { total: 0 } } as unknown as Project}
    selectedProject={null} selectedSession={null} isExpanded={false} isDeleting={false} isStarred={false} isEditing={false}
    renameDraft="" sessions={[]} initialSessionsLoaded isLoadingMoreSessions={false} currentTime={new Date()}
    sessionRenameId={null} sessionRenameDraft="" tasksEnabled={false} mcpServerStatus={null}
    onRenameDraftChange={noop} onToggleProject={noop} onProjectSelect={noop} onToggleStarProject={noop}
    onStartEditingProject={noop} onCancelEditingProject={noop} onSaveProjectName={noop} onDeleteProject={noop}
    onSessionSelect={noop} onDeleteSession={noop} onLoadMoreSessions={noop}
    activeSessions={new Set()} backgroundSessionIds={new Set()} attentionSessionIds={new Set()}
    onNewSession={noop} onStartEditingSession={noop} onCancelEditingSession={noop} onSaveEditingSession={noop}
    selectedSessionIds={null} onSetSessionSelection={noop} onToggleSessionSelected={noop}
    onCancelSessionSelection={noop} onDeleteSelectedSessions={noop}
    t={((key: string) => key) as unknown as TFunction}
  />,
);

test('members do not get rename or remove controls for shared projects', () => {
  auth.role = 'member';
  renderProject();
  assert.equal(screen.queryByTitle('tooltips.renameProject') === null, true);
  assert.equal(screen.queryByTitle('tooltips.deleteProject') === null, true);
});

test('administrators keep rename and remove controls', () => {
  auth.role = 'admin';
  renderProject();
  assert.equal(screen.queryByTitle('tooltips.renameProject') !== null, true);
  assert.equal(screen.queryByTitle('tooltips.deleteProject') !== null, true);
});
