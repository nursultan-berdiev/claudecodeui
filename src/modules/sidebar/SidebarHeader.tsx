import { Plus, RefreshCw, Search, X, PanelLeftClose } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Button, Input } from '@/shared/ui';
import { CLOUDCLI_WORDMARK_FONT_FAMILY } from '@/shared/constants';
import { IS_PLATFORM } from '@/shared/utils';
import type { Project, SidebarSearchMode } from '@/shared/types';
import { NewChatButton } from '@/modules/company';
import SidebarModeTabs from '@/modules/sidebar/SidebarModeTabs';

type SidebarHeaderProps = {
  isPWA: boolean;
  isMobile: boolean;
  isLoading: boolean;
  runningSessionsCount: number;
  searchFilter: string;
  onSearchFilterChange: (value: string) => void;
  onClearSearchFilter: () => void;
  searchMode: SidebarSearchMode;
  onSearchModeChange: (mode: SidebarSearchMode) => void;
  onRefresh: () => void;
  isRefreshing: boolean;
  onCreateProject: () => void;
  onCollapseSidebar: () => void;
  onNewSession: (project: Project) => void;
  t: TFunction;
};

/** Module-level, not a nested render function, so the wordmark is not remounted on every SidebarHeader render. */
function LogoBlock({ t }: { t: TFunction }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-primary">
        <svg className="h-3.5 w-3.5 text-primary-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </div>
      <h1
        className="truncate text-sm font-semibold tracking-tight text-foreground"
        style={{ fontFamily: CLOUDCLI_WORDMARK_FONT_FAMILY }}
      >
        {t('app.title')}
      </h1>
    </div>
  );
}

/**
 * Rendered by SidebarContent at the top of the panel: the logo, the New chat
 * action, the Chats/Projects switch and the search box. Refresh and New project
 * only matter to the project tree, so they appear in that mode alone.
 */
export default function SidebarHeader({
  isPWA,
  isMobile,
  isLoading,
  runningSessionsCount,
  searchFilter,
  onSearchFilterChange,
  onClearSearchFilter,
  searchMode,
  onSearchModeChange,
  onRefresh,
  isRefreshing,
  onCreateProject,
  onCollapseSidebar,
  onNewSession,
  t,
}: SidebarHeaderProps) {
  const searchPlaceholder = searchMode === 'conversations'
    ? t('search.conversationsPlaceholder')
    : searchMode === 'archived'
      ? t('search.archivedPlaceholder', 'Search archived sessions...')
      : searchMode === 'running'
        ? t('search.runningPlaceholder', 'Search running sessions...')
        : t('projects.searchPlaceholder');
  const iconButtonClassName = 'h-8 w-8 rounded-lg p-0 text-muted-foreground hover:bg-accent hover:text-foreground';

  return (
    <div
      className="flex-shrink-0 px-2 pb-2 pt-2.5"
      style={isPWA && isMobile ? { paddingTop: '16px' } : undefined}
    >
      <div className="flex items-center justify-between gap-2 pl-1.5">
        {IS_PLATFORM ? (
          <a
            href="https://cloudcli.ai/dashboard"
            className="flex min-w-0 items-center gap-2.5 transition-opacity hover:opacity-80"
            title={t('tooltips.viewEnvironments')}
          >
            <LogoBlock t={t} />
          </a>
        ) : (
          <LogoBlock t={t} />
        )}

        <div className="flex flex-shrink-0 items-center gap-0.5">
          {searchMode === 'projects' && (
            <>
              <Button
                variant="ghost"
                size="sm"
                className={iconButtonClassName}
                onClick={onRefresh}
                disabled={isRefreshing}
                title={t('tooltips.refresh')}
                aria-label={t('tooltips.refresh')}
              >
                <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className={iconButtonClassName}
                onClick={onCreateProject}
                title={t('tooltips.createProject')}
                aria-label={t('tooltips.createProject')}
              >
                <Plus className="h-4 w-4" />
              </Button>
            </>
          )}
          {!isMobile && (
            <Button
              variant="ghost"
              size="sm"
              className={iconButtonClassName}
              onClick={onCollapseSidebar}
              title={t('tooltips.hideSidebar')}
              aria-label={t('tooltips.hideSidebar')}
            >
              <PanelLeftClose className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      <div className="mt-3">
        <NewChatButton onOpenChat={onNewSession} />
      </div>

      {!isLoading && (
        <div className="mt-2 space-y-1.5">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="text"
              placeholder={searchPlaceholder}
              value={searchFilter}
              onChange={(event) => onSearchFilterChange(event.target.value)}
              className="h-9 rounded-lg border-0 bg-transparent pl-9 pr-9 text-sm shadow-none placeholder:text-muted-foreground hover:bg-accent focus-visible:bg-accent focus-visible:ring-0 focus-visible:ring-offset-0"
            />
            {searchFilter && (
              <button
                onClick={onClearSearchFilter}
                aria-label={t('tooltips.clearSearch')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md p-0.5 hover:bg-accent"
              >
                <X className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            )}
          </div>
          <SidebarModeTabs
            searchMode={searchMode}
            onSearchModeChange={onSearchModeChange}
            runningSessionsCount={runningSessionsCount}
            t={t}
          />
        </div>
      )}
    </div>
  );
}
