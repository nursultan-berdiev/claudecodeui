import { useTranslation } from 'react-i18next';

import type { AppTab, ProjectSession } from '@/shared/types';
import { usePlugins } from '@/modules/plugins';
import { getSessionTitle } from '@/shared/utils';
import { useSessionTitleRename } from '@/modules/project-workspace/hooks/useSessionTitleRename';

type WorkspaceTitleProps = {
  activeTab: AppTab;
  selectedSession: ProjectSession | null;
  shouldShowTasksTab: boolean;
  /** Persists a new title for a session; resolves false when the backend refuses it. */
  onRenameSession: (sessionId: string, summary: string) => Promise<boolean>;
};

function getTabTitle(activeTab: AppTab, shouldShowTasksTab: boolean, t: (key: string) => string, pluginDisplayName?: string) {
  if (activeTab.startsWith('plugin:') && pluginDisplayName) {
    return pluginDisplayName;
  }

  if (activeTab === 'shell') {
    return t('tabs.shell');
  }

  if (activeTab === 'files') {
    return t('mainContent.projectFiles');
  }

  if (activeTab === 'git') {
    return t('tabs.git');
  }

  if (activeTab === 'tasks' && shouldShowTasksTab) {
    return 'TaskMaster';
  }

  if (activeTab === 'browser') {
    return t('tabs.browser');
  }

  return t('misc.projectFallback');
}

/**
 * Rendered by WorkspaceHeader to label the workspace with the active session or
 * tab name. On the chat tab the session title can be double-clicked to rename
 * the session in place, as a second way in beside the sidebar's rename. A new
 * chat has no title yet, so nothing is shown.
 */
export default function WorkspaceTitle({
  activeTab,
  selectedSession,
  shouldShowTasksTab,
  onRenameSession,
}: WorkspaceTitleProps) {
  const { t } = useTranslation();
  const { plugins } = usePlugins();

  const pluginDisplayName = activeTab.startsWith('plugin:')
    ? plugins.find((p) => p.name === activeTab.replace('plugin:', ''))?.displayName
    : undefined;

  const showChatNewSession = activeTab === 'chat' && !selectedSession;
  const sessionTitle = selectedSession ? getSessionTitle(selectedSession) : '';

  const {
    isEditing: isRenaming,
    draft: renameDraft,
    isSaving: isSavingRename,
    inputRef: renameInputRef,
    startEditing: startRenaming,
    updateDraft: updateRenameDraft,
    cancelEditing: cancelRenaming,
    handleInputKeyDown: handleRenameKeyDown,
  } = useSessionTitleRename({
    sessionId: selectedSession?.id ?? null,
    currentTitle: sessionTitle,
    onRenameSession,
  });

  if (showChatNewSession) {
    return <div className="min-w-0 flex-1" />;
  }

  return (
    <div className="min-w-0 flex-1">
      {activeTab === 'chat' && selectedSession ? (
        isRenaming ? (
          <input
            ref={renameInputRef}
            type="text"
            value={renameDraft}
            onChange={(event) => updateRenameDraft(event.target.value)}
            onKeyDown={handleRenameKeyDown}
            // Clicking anywhere else cancels, as the sidebar's rename does.
            onBlur={cancelRenaming}
            readOnly={isSavingRename}
            aria-busy={isSavingRename}
            aria-label={t('mainContent.renameSessionLabel')}
            // Blur cancels, so a touch keyboard needs a key that commits.
            enterKeyHint="done"
            className="w-full max-w-md rounded-lg border border-border bg-background px-2 py-1 text-base font-medium leading-tight text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        ) : (
          <h2
            title={t('mainContent.renameSessionHint', { title: sessionTitle })}
            onDoubleClick={startRenaming}
            className="cursor-text truncate px-1 text-base font-medium leading-tight text-foreground"
          >
            {sessionTitle}
          </h2>
        )
      ) : (
        <h2 className="truncate px-1 text-base font-medium leading-tight text-foreground">
          {getTabTitle(activeTab, shouldShowTasksTab, t, pluginDisplayName)}
        </h2>
      )}
    </div>
  );
}
