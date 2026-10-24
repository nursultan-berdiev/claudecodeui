import { memo, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Loader2 } from 'lucide-react';

import type { ChatMessage, ClaudePermissionSuggestion, PermissionGrantResult, LLMProvider,DiffLine,DiffStats,Project,ToolGroupItem,TranscriptRevealRequest } from '@/shared/types';
import { getToolConfig } from '@/modules/chat/tools';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import { useIsExportingTranscript } from '@/modules/chat/context/TranscriptRenderContext';
import { useRevealRequest } from '@/modules/chat/context/TranscriptRevealContext';
import { DiffStatsBadge } from '@/modules/chat/tools/DiffStatsBadge';
import { parseToolPayload, summarizeDiff } from '@/modules/chat/utils/messageTransforms';

type ToolGroupContainerProps = {
  group: ToolGroupItem;
  prevMessage: ChatMessage | null;
  createDiff: (oldStr: string, newStr: string) => DiffLine[];
  getMessageKey: (message: ChatMessage) => string;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  onGrantToolPermission?: (suggestion: ClaudePermissionSuggestion) => PermissionGrantResult | null | undefined;
  showRawParameters?: boolean;
  showThinking?: boolean;
  selectedProject?: Project | null;
  provider: LLMProvider | string;
  /**
   * True only for the transcript's last row while the session works. A call
   * left without a result in history (an interrupted turn) is not running.
   */
  canStillRun?: boolean;
};

/**
 * Totals the lines a run of file edits added and removed.
 *
 * A collapsed group hides every individual diff, so without this the one thing
 * the row could usefully say about a batch of edits — how big it is — is the
 * one thing it did not. Each call is read through its own tool's config, since a
 * group mixes tools. Returns null when no call in the group renders a diff.
 */
function useGroupDiffStats(
  messages: ChatMessage[],
  createDiff: (oldStr: string, newStr: string) => DiffLine[],
): DiffStats | null {
  return useMemo(() => {
    let added = 0;
    let removed = 0;
    let counted = 0;

    for (const message of messages) {
      const config = getToolConfig(message.toolName || 'UnknownTool').input;
      if (config.contentType !== 'diff' || !config.getContentProps) {
        continue;
      }

      const contentProps = config.getContentProps(parseToolPayload(message.toolInput) ?? {});
      if (typeof contentProps?.oldContent !== 'string' || typeof contentProps?.newContent !== 'string') {
        continue;
      }

      const stats = summarizeDiff(createDiff(contentProps.oldContent, contentProps.newContent));
      added += stats.added;
      removed += stats.removed;
      counted += 1;
    }

    return counted > 0 ? { added, removed } : null;
  }, [createDiff, messages]);
}

/**
 * Rendered by chat's ChatMessagesPane to fold a run of consecutive tool calls
 * into one quiet summary line ("Ran 3 actions") that expands to the calls.
 */
function ToolGroupContainer({
  group,
  prevMessage,
  createDiff,
  getMessageKey,
  onFileOpen,
  onShowSettings,
  onGrantToolPermission,
  showRawParameters,
  showThinking,
  selectedProject,
  provider,
  canStillRun = false,
}: ToolGroupContainerProps) {
  const { t } = useTranslation('chat');
  const isExporting = useIsExportingTranscript();
  // Collapsed on screen, always open in an export: the whole point of the
  // group row is to hide detail the reader can ask for, and an exported file
  // has no way to ask.
  const [isExpanded, setIsExpanded] = useState(false);
  // A reveal (search hit, background-task chip) aimed at one of these calls
  // opens the group until the user closes it; a later reveal opens it again.
  const revealRequest = useRevealRequest();
  const [closedReveal, setClosedReveal] = useState<TranscriptRevealRequest | null>(null);
  const isOpenForReveal = revealRequest !== null
    && revealRequest !== closedReveal
    && group.messages.includes(revealRequest.message);
  const isOpen = isExpanded || isOpenForReveal;
  const showChildren = isOpen || isExporting;
  const groupDiffStats = useGroupDiffStats(group.messages, createDiff);

  const toggleOpen = () => {
    if (isOpenForReveal) {
      setClosedReveal(revealRequest);
    }
    setIsExpanded(!isOpen);
  };

  const isRunning = canStillRun && group.runningCount > 0;
  const summary = isRunning
    ? t('toolGroup.running', { defaultValue: 'Working…' })
    : t('toolGroup.done', { count: group.messages.length, defaultValue: 'Ran {{count}} actions' });
  const previewParts = [...group.previewNames];
  if (group.previewExtraCount > 0) {
    previewParts.push(t('toolGroup.more', { count: group.previewExtraCount, defaultValue: '+{{count}} more' }));
  }
  const preview = previewParts.join(', ');

  // Keys only have to be unique among this group's own rows, so repeats of the
  // same key are disambiguated here by occurrence.
  const messageKeys = useMemo(() => {
    const occurrences = new Map<string, number>();
    return group.messages.map((message) => {
      const key = getMessageKey(message);
      const seen = occurrences.get(key) ?? 0;
      occurrences.set(key, seen + 1);
      return seen === 0 ? key : `${key}__${seen}`;
    });
  }, [group.messages, getMessageKey]);

  return (
    <div className="chat-message tool px-3 sm:px-0" data-message-timestamp={group.timestamp || undefined}>
      <button
        type="button"
        className="group flex w-full min-w-0 items-center gap-1.5 rounded-lg py-1 text-left text-sm text-muted-foreground transition-colors hover:text-foreground"
        onClick={toggleOpen}
        aria-expanded={isOpen}
      >
        {isRunning && <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin" aria-hidden />}
        <span className="flex-shrink-0">{summary}</span>
        {group.failedCount > 0 && (
          <span className="flex-shrink-0 text-red-600 dark:text-red-400">
            · {t('toolGroup.failed', { count: group.failedCount, defaultValue: '{{count}} failed' })}
          </span>
        )}
        {preview && (
          <span className="min-w-0 truncate text-xs text-muted-foreground/70">{preview}</span>
        )}
        {groupDiffStats && <DiffStatsBadge stats={groupDiffStats} className="flex-shrink-0 pl-1" />}
        <ChevronRight
          className={`h-3.5 w-3.5 flex-shrink-0 transition-transform ${isOpen ? 'rotate-90' : ''}`}
          aria-hidden
        />
      </button>

      {showChildren && (
        <div className="ml-1.5 mt-2 space-y-3 border-l border-border pl-4">
          {group.messages.map((message, index) => (
            <MessageComponent
              key={messageKeys[index]}
              message={message}
              prevMessage={index > 0 ? group.messages[index - 1] : prevMessage}
              createDiff={createDiff}
              onFileOpen={onFileOpen}
              onShowSettings={onShowSettings}
              onGrantToolPermission={onGrantToolPermission}
              showRawParameters={showRawParameters}
              showThinking={showThinking}
              selectedProject={selectedProject}
              provider={provider}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Memoized for the transcript re-renders that are not message changes — the
 * pane re-renders when isProcessing or the activity indicator flips, and on
 * every 100ms stream tick, and the group is unchanged then.
 *
 * Bailing out depends on two identities the pane keeps stable on its side:
 * `group`, which groupConsecutiveTools reuses while the run's rows are
 * unchanged, and `getMessageKey`, a module-level function. Adding a prop
 * rebuilt per render here would cost every group on screen a render per tick.
 */
export default memo(ToolGroupContainer);
