import { Settings, PanelLeftOpen, AlertTriangle, LogOut } from 'lucide-react';
import type { TFunction } from 'i18next';

import { useAuth } from '@/modules/auth';
import { NewChatButton } from '@/modules/company';
import { IS_PLATFORM } from '@/shared/utils';
import type { Project } from '@/shared/types';

type SidebarCollapsedProps = {
  onExpand: () => void;
  onNewSession: (project: Project) => void;
  onShowSettings: () => void;
  restartRequired: boolean;
  t: TFunction;
};

/** Rendered by Sidebar instead of SidebarContent when the panel is collapsed to its icon rail. */
export default function SidebarCollapsed({
  onExpand,
  onNewSession,
  onShowSettings,
  restartRequired,
  t,
}: SidebarCollapsedProps) {
  const { user, logout } = useAuth();
  // Server update notices concern whoever runs the server, as in the expanded footer.
  const isAdmin = user?.role === 'admin';
  return (
    <div className="flex h-full w-12 flex-col items-center gap-1 bg-sidebar py-3">
      {/* Expand button with brand logo */}
      <button
        onClick={onExpand}
        className="group flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-accent/80"
        aria-label={t('common:versionUpdate.ariaLabels.showSidebar')}
        title={t('common:versionUpdate.ariaLabels.showSidebar')}
      >
        <PanelLeftOpen className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-foreground" />
      </button>

      <NewChatButton onOpenChat={onNewSession} compact />

      {/* Settings */}
      <button
        onClick={onShowSettings}
        className="group flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-accent/80"
        aria-label={t('actions.settings')}
        title={t('actions.settings')}
      >
        <Settings className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-foreground" />
      </button>

      {!IS_PLATFORM && (
        <button
          onClick={logout}
          className="group flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-accent/80"
          aria-label={t('common:navigation.logout')}
          title={t('common:navigation.logout')}
        >
          <LogOut className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-foreground" />
        </button>
      )}

      {/* Restart-required indicator */}
      {isAdmin && restartRequired && (
        <div
          className="relative flex h-8 w-8 items-center justify-center rounded-lg"
          aria-label={t('version.restartRequired')}
          title={t('version.restartRequired')}
        >
          <AlertTriangle className="h-4 w-4 text-amber-500" />
          <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
        </div>
      )}
    </div>
  );
}
