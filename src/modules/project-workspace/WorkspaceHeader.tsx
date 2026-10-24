import { ArrowLeft } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import type { AppTab, ProjectSession } from '@/shared/types';
import MobileMenuButton from '@/modules/project-workspace/MobileMenuButton';
import WorkspaceToolsMenu from '@/modules/project-workspace/WorkspaceToolsMenu';
import WorkspaceTitle from '@/modules/project-workspace/WorkspaceTitle';
import { ChatSharing } from '@/modules/company';

type WorkspaceHeaderProps = {
  activeTab: AppTab;
  setActiveTab: Dispatch<SetStateAction<AppTab>>;
  selectedSession: ProjectSession | null;
  shouldShowTasksTab: boolean;
  shouldShowBrowserTab: boolean;
  isMobile: boolean;
  onMenuClick: () => void;
  /** Persists a new title for a session; resolves false when the backend refuses it. */
  onRenameSession: (sessionId: string, summary: string) => Promise<boolean>;
};

/**
 * Rendered by WorkspaceMain as the single quiet row above the chat: the chat
 * title, its sharing state and a "…" menu with the other workspace views.
 */
export default function WorkspaceHeader({
  activeTab,
  setActiveTab,
  selectedSession,
  shouldShowTasksTab,
  shouldShowBrowserTab,
  isMobile,
  onMenuClick,
  onRenameSession,
}: WorkspaceHeaderProps) {
  const { t } = useTranslation();

  return (
    <header className="pwa-header-safe flex min-h-[52px] flex-shrink-0 items-center gap-1 bg-background px-2 py-2 sm:gap-2 sm:px-4">
      {isMobile && <MobileMenuButton onMenuClick={onMenuClick} />}
      {activeTab !== 'chat' && (
        <button
          type="button"
          onClick={() => setActiveTab('chat')}
          className="inline-flex flex-shrink-0 items-center gap-1 rounded-lg px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('tabs.chat')}
        </button>
      )}
      <WorkspaceTitle
        activeTab={activeTab}
        selectedSession={selectedSession}
        shouldShowTasksTab={shouldShowTasksTab}
        onRenameSession={onRenameSession}
      />
      {activeTab === 'chat' && selectedSession && <ChatSharing sessionId={selectedSession.id} />}
      <WorkspaceToolsMenu
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        shouldShowTasksTab={shouldShowTasksTab}
        shouldShowBrowserTab={shouldShowBrowserTab}
      />
    </header>
  );
}
