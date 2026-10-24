import assert from 'node:assert/strict';

import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import type { Project, SidebarProjectListProps } from '@/shared/types';

/**
 * The Chats list is the sidebar's default view and a page fetched from the
 * server, while new and updated sessions reach the client as `projects`
 * patches. A chat started from "New chat", or an older one written in, has to
 * show up there without the user pressing Refresh.
 */

const recentConversations = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    archivedProjects: () => Promise.resolve({ ok: true, json: async () => ({ data: { projects: [] } }) }),
    getArchivedSessions: () => Promise.resolve({ ok: true, json: async () => ({ data: { sessions: [] } }) }),
    recentConversations: () => recentConversations(),
    migrateLegacyProjectStars: () => Promise.resolve({ ok: true, json: async () => ({}) }),
  },
}));

const { useSidebarController } = await import('@/modules/sidebar/hooks/useSidebarController');

const noop = () => {};
const t = ((key: string) => key) as unknown as SidebarProjectListProps['t'];
const NO_IDS: ReadonlySet<string> = new Set<string>();

const project = (sessions: { id: string; lastActivity: string }[]) => ({
  projectId: 'project-1',
  name: 'project-1',
  displayName: 'project one',
  fullPath: '/repo',
  sessions,
}) as unknown as Project;

const renderController = (projects: Project[]) => renderHook(
  ({ projects: current }: { projects: Project[] }) => useSidebarController({
    projects: current,
    selectedProject: null,
    selectedSession: null,
    activeSessions: NO_IDS,
    backgroundSessionIds: NO_IDS,
    isLoading: false,
    isMobile: false,
    t,
    onRefresh: noop,
    onProjectSelect: noop,
    onSessionSelect: noop,
    onSessionDelete: noop,
    onLoadMoreSessions: noop,
    onProjectDelete: noop,
    setCurrentProject: noop,
    setSidebarVisible: noop,
    sidebarVisible: true,
  }),
  { initialProps: { projects } },
);

beforeEach(() => {
  recentConversations.mockReset();
  recentConversations.mockImplementation(async () => ({
    ok: true,
    json: async () => ({ data: { conversations: [], total: 0, hasMore: false } }),
  }));
});

test('the sidebar opens on the Chats list', async () => {
  const { result } = renderController([project([])]);

  assert.equal(result.current.searchMode, 'conversations');
  await waitFor(() => assert.equal(recentConversations.mock.calls.length, 1));
});

test('a new or updated session re-fetches the Chats list once activity settles', async () => {
  const initial = [project([{ id: 's1', lastActivity: '2026-08-21T09:00:00.000Z' }])];
  const { rerender } = renderController(initial);
  await waitFor(() => assert.equal(recentConversations.mock.calls.length, 1));

  rerender({ projects: [project([
    { id: 's2', lastActivity: '2026-08-21T10:00:00.000Z' },
    { id: 's1', lastActivity: '2026-08-21T09:00:00.000Z' },
  ])] });

  await waitFor(() => assert.equal(recentConversations.mock.calls.length, 2), { timeout: 3000 });
});

test('a projects update that changes no session does not re-fetch', async () => {
  const sessions = [{ id: 's1', lastActivity: '2026-08-21T09:00:00.000Z' }];
  const { rerender } = renderController([project(sessions)]);
  await waitFor(() => assert.equal(recentConversations.mock.calls.length, 1));

  rerender({ projects: [project([...sessions])] });
  await new Promise((resolve) => setTimeout(resolve, 1300));

  assert.equal(recentConversations.mock.calls.length, 1);
});
