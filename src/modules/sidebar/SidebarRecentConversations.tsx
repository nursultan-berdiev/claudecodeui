import { Loader2, MessageSquare } from 'lucide-react';
import type { MouseEvent } from 'react';
import type { TFunction } from 'i18next';

import { Button, Tooltip } from '@/shared/ui';
import { cn } from '@/shared/utils';
import type { ProjectSession, RecentConversationListItem, SessionRowActions } from '@/shared/types';
import SessionOptions from '@/modules/sidebar/SessionOptions';

type SidebarRecentConversationsProps = {
  conversations: RecentConversationListItem[];
  hasMore: boolean;
  isLoading: boolean;
  isLoadingMore: boolean;
  hasError: boolean;
  selectedSession: ProjectSession | null;
  currentTime: Date;
  /**
   * The same row state and callbacks the Projects list hands its rows, so a
   * conversation can be renamed, copied, forked or archived from here too.
   */
  sessionActions: SessionRowActions;
  onConversationSelect: (
    projectId: string | null,
    sessionId: string,
    provider: string,
  ) => void;
  onLoadMore: () => void;
  onRetry: () => void;
  t: TFunction;
};

type RecentDateGroup = 'today' | 'yesterday' | 'previous7Days' | 'previous30Days' | 'older';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Which date heading a conversation falls under, counted in calendar days on the user's clock. */
function getRecentDateGroup(lastActivity: string | null | undefined, now: Date): RecentDateGroup {
  const time = lastActivity ? new Date(lastActivity).getTime() : Number.NaN;
  if (Number.isNaN(time)) {
    return 'older';
  }

  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (time >= startOfToday) return 'today';
  if (time >= startOfToday - DAY_MS) return 'yesterday';
  if (time >= startOfToday - 7 * DAY_MS) return 'previous7Days';
  if (time >= startOfToday - 30 * DAY_MS) return 'previous30Days';
  return 'older';
}

/**
 * Splits the list into date sections. The server already orders it by recency,
 * so each section is one contiguous run and the order is kept as is.
 */
function groupConversationsByDate(conversations: RecentConversationListItem[], now: Date) {
  const groups: { key: RecentDateGroup; conversations: RecentConversationListItem[] }[] = [];
  for (const conversation of conversations) {
    const key = getRecentDateGroup(conversation.lastActivity, now);
    const current = groups[groups.length - 1];
    if (current?.key === key) {
      current.conversations.push(conversation);
    } else {
      groups.push({ key, conversations: [conversation] });
    }
  }
  return groups;
}

function RecentConversationSkeleton() {
  return (
    <div className="space-y-1 px-1" aria-label="Loading recent conversations">
      {Array.from({ length: 8 }).map((_, index) => (
        <div key={index} className="flex items-center gap-2 rounded-lg px-2 py-2.5">
          <div className="h-7 w-7 animate-pulse rounded-md bg-muted" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="h-3 animate-pulse rounded bg-muted" style={{ width: `${72 - index * 3}%` }} />
            <div className="h-2.5 w-1/2 animate-pulse rounded bg-muted/70" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Rendered by SidebarContent in the Chats mode to list recently active sessions
 * across all projects, ChatGPT-style: one line per chat under date headings.
 */
export default function SidebarRecentConversations({
  conversations,
  hasMore,
  isLoading,
  isLoadingMore,
  hasError,
  selectedSession,
  currentTime,
  sessionActions,
  onConversationSelect,
  onLoadMore,
  onRetry,
  t,
}: SidebarRecentConversationsProps) {
  if (isLoading && conversations.length === 0) {
    return <RecentConversationSkeleton />;
  }

  if (hasError && conversations.length === 0) {
    return (
      <div className="px-4 py-10 text-center">
        <MessageSquare className="mx-auto mb-3 h-6 w-6 text-muted-foreground" />
        <p className="text-sm font-medium text-foreground">
          {t('recent.loadFailed', 'Could not load recent conversations')}
        </p>
        <Button variant="ghost" size="sm" className="mt-2" onClick={onRetry}>
          {t('buttons.retry', { ns: 'common', defaultValue: 'Try again' })}
        </Button>
      </div>
    );
  }

  if (conversations.length === 0) {
    return (
      <div className="px-4 py-10 text-center">
        <MessageSquare className="mx-auto mb-3 h-6 w-6 text-muted-foreground" />
        <p className="text-sm font-medium text-foreground">
          {t('recent.emptyTitle', 'No conversations yet')}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {t('recent.emptyDescription', 'Your most recently updated conversations will appear here.')}
        </p>
      </div>
    );
  }

  const renderConversation = (conversation: RecentConversationListItem) => {
    const isSelected = String(selectedSession?.id ?? '') === conversation.sessionId;
    const hasBackgroundWork = sessionActions.backgroundSessionIds.has(conversation.sessionId);
    const isProcessing = sessionActions.activeSessions.has(conversation.sessionId) && !hasBackgroundWork;
    const showAttentionIndicator =
      sessionActions.attentionSessionIds.has(conversation.sessionId) && !isSelected;
    // Resolved per row so a keystroke in one rename does not redraw the rest.
    const rename = sessionActions.activeRename;
    const sessionRename =
      rename?.target === 'session' && rename.id === conversation.sessionId ? rename : null;

    const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      event.preventDefault();
      onConversationSelect(
        conversation.projectId,
        conversation.sessionId,
        conversation.provider,
      );
    };

    return (
      <div key={conversation.sessionId} className="group relative">
        {/*
          * Only the amber "needs attention" dot, and the spinner below. The
          * Projects row also has a green dot for a session touched recently,
          * which carries no information in a list ordered by recency.
          */}
        {showAttentionIndicator && (
          <div className="absolute left-0 top-1/2 -translate-x-1 -translate-y-1/2 transform">
            <Tooltip
              content={t('tooltips.attentionRequiredIndicator', { defaultValue: 'Session needs attention' })}
              position="right"
            >
              <div
                role="status"
                aria-label={t('tooltips.attentionRequiredIndicator', { defaultValue: 'Session needs attention' })}
                className="h-2 w-2 animate-pulse rounded-full bg-amber-500"
              />
            </Tooltip>
          </div>
        )}

        <a
          href={`/session/${conversation.sessionId}`}
          onClick={handleClick}
          data-testid="recent-conversation-row"
          title={conversation.projectDisplayName ? `${conversation.sessionTitle} · ${conversation.projectDisplayName}` : conversation.sessionTitle}
          className={cn(
            'flex min-w-0 items-center gap-2 rounded-lg px-2.5 py-2 pr-9 text-left text-sm transition-colors',
            isSelected
              ? 'bg-accent text-foreground'
              : 'text-foreground hover:bg-accent/70',
          )}
        >
          <span className="min-w-0 flex-1 truncate">{conversation.sessionTitle}</span>
          {isProcessing ? (
            <Tooltip content={t('tooltips.processingSessionIndicator', 'Processing session')} position="top">
              <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin text-muted-foreground" />
            </Tooltip>
          ) : hasBackgroundWork && (
            // No spinner: nothing is responding. The purple of the
            // workflow and agent cards says what is still running.
            <Tooltip content={t('tooltips.backgroundWorkIndicator', 'Background work running')} position="top">
              <span
                role="status"
                aria-label={t('tooltips.backgroundWorkIndicator', 'Background work running')}
                className="h-2 w-2 flex-shrink-0 animate-pulse rounded-full bg-purple-500 dark:bg-purple-400"
              />
            </Tooltip>
          )}
        </a>

        <SessionOptions
          className={cn(
            'absolute right-1 top-1/2 -translate-y-1/2 transform transition-opacity',
            sessionRename === null && 'opacity-0 focus-within:opacity-100 group-hover:opacity-100',
          )}
          sessionId={conversation.sessionId}
          sessionName={conversation.sessionTitle}
          provider={conversation.provider}
          projectId={conversation.projectId}
          isProcessing={isProcessing}
          isEditing={sessionRename !== null}
          renameDraft={sessionRename?.draft ?? ''}
          onRenameDraftChange={sessionActions.onRenameDraftChange}
          onStartEditingSession={sessionActions.onStartEditingSession}
          onCancelEditingSession={sessionActions.onCancelEditingSession}
          onSaveEditingSession={sessionActions.onSaveEditingSession}
          onDeleteSession={sessionActions.onDeleteSession}
          // The fork path reads only the id, provider and owning project,
          // which is all a recents row knows about the session.
          onFork={sessionActions.onForkSession
            ? () => sessionActions.onForkSession?.({
              id: conversation.sessionId,
              summary: conversation.sessionTitle,
              __provider: conversation.provider,
              __projectId: conversation.projectId ?? undefined,
            })
            : undefined}
          t={t}
        />
      </div>
    );
  };

  return (
    <div className="px-1" data-testid="recent-conversations-list">
      {groupConversationsByDate(conversations, currentTime).map((group, index) => (
        // A list out of recency order can repeat a heading, so the key carries the position.
        <section key={`${group.key}-${index}`} className="mb-3">
          <h3 className="px-2.5 pb-1 pt-2 text-xs font-medium text-muted-foreground">
            {t(`recent.groups.${group.key}`)}
          </h3>
          <div className="space-y-px">
            {group.conversations.map(renderConversation)}
          </div>
        </section>
      ))}

      {hasMore && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-1 h-8 w-full text-xs text-muted-foreground"
          onClick={onLoadMore}
          disabled={isLoadingMore}
        >
          {isLoadingMore
            ? t('recent.loadingMore', 'Loading more...')
            : t('recent.loadMore', 'Load older conversations')}
        </Button>
      )}
    </div>
  );
}
