import type { ChatMessage, ToolGroupItem } from '@/shared/types';
import { getToolConfig } from '@/modules/chat/tools/configs/toolConfigs';

// Even a single action folds into a summary line: a threshold of 2 rendered the
// first call as a full card and remounted it collapsed when the second arrived.
export const TOOL_GROUP_THRESHOLD = 1;

/** How many of a group's tool inputs the collapsed summary line spells out. */
const PREVIEWED_TOOL_COUNT = 2;

/**
 * Tools that stay visible as their own rows. The plan card carries the only
 * Build/Revise buttons for a pending plan, the question card records the user's
 * answer, and the checklist title says what the agent is doing right now.
 */
const UNGROUPED_TOOL_NAMES = new Set(['Workflow', 'ExitPlanMode', 'exit_plan_mode', 'AskUserQuestion', 'TodoWrite']);


export type MessageListItem = ChatMessage | ToolGroupItem;

/** A run of consecutive tool rows, already narrowed to the ones that can group. */
type GroupableToolRun = (ChatMessage & { toolName: string })[];

type CachedToolGroup = {
  /** The exact run the group was built from; reused only while every row keeps its identity. */
  run: GroupableToolRun;
  /** Hidden reasoning both joins runs and changes what the preview names, so it is part of the key. */
  showThinking: boolean;
  group: ToolGroupItem;
};

// Chat rows keep their identity across a stream tick (useChatMessages' own
// projection cache), but grouping re-runs on every tick over a fresh array.
// Without this cache each collapsed run gets a brand-new group object, so
// `memo(ToolGroupContainer)` cannot bail and every group on screen re-renders
// ~10 times a second while only the streaming row actually changed. Keyed
// weakly on the run's first row so entries disappear with the rows themselves.
const toolGroupCache = new WeakMap<ChatMessage, CachedToolGroup>();

function isSameRun(cachedRun: GroupableToolRun, run: GroupableToolRun): boolean {
  return cachedRun.length === run.length
    && cachedRun.every((message, index) => message === run[index]);
}

/** The group object for a run, reused unchanged while the run's rows are unchanged. */
function getToolGroup(run: GroupableToolRun, showThinking: boolean): ToolGroupItem {
  const first = run[0];
  const cached = toolGroupCache.get(first);
  if (cached && cached.showThinking === showThinking && isSameRun(cached.run, run)) {
    return cached.group;
  }

  const group: ToolGroupItem = {
    _isGroup: true,
    messages: run,
    timestamp: first.timestamp,
    ...buildGroupPreview(run),
    runningCount: run.filter(isRunningTool).length,
    failedCount: run.filter(isFailedTool).length,
  };
  toolGroupCache.set(first, { run, showThinking, group });
  return group;
}

export function isToolGroupItem(item: MessageListItem): item is ToolGroupItem {
  return '_isGroup' in item && (item as ToolGroupItem)._isGroup === true;
}

// An agent's or a workflow's row is its whole card — status, timeline, result —
// so it never folds into a collapsed run with its neighbours.
function isGroupableToolMessage(message: ChatMessage): message is ChatMessage & { toolName: string } {
  return Boolean(
    message.isToolUse
    && message.toolName
    && !message.isSubagentContainer
    && !UNGROUPED_TOOL_NAMES.has(message.toolName),
  );
}

// Same reading as ToolRenderer's row status: no result yet means still running,
// unless the provider already reported the call as finished or failed.
function isRunningTool(message: ChatMessage): boolean {
  if (message.toolStatus === 'in_progress') {
    return true;
  }
  return !message.toolResult && message.toolStatus !== 'failed' && message.toolStatus !== 'completed';
}

function isFailedTool(message: ChatMessage): boolean {
  return message.toolStatus === 'failed' || Boolean(message.toolResult?.isError);
}

// Messages that render nothing (e.g. reasoning hidden when showThinking is off)
// shouldn't split an otherwise-continuous run of the same tool — providers like
// Codex interleave hidden reasoning between consecutive tool calls.
function rendersNothing(message: ChatMessage, showThinking: boolean): boolean {
  return Boolean(message.isThinking && !showThinking);
}

function parseToolInput(toolInput: unknown): unknown {
  if (typeof toolInput !== 'string') {
    return toolInput;
  }

  try {
    return JSON.parse(toolInput);
  } catch {
    return toolInput;
  }
}

function getToolInputPreview(message: ChatMessage): string {
  const config = getToolConfig(message.toolName || 'UnknownTool').input;
  const parsedInput = parseToolInput(message.toolInput);
  const title = typeof config.title === 'function' ? config.title(parsedInput) : config.title;
  const value = config.getValue?.(parsedInput);

  return String(value || title || message.displayText || message.content || '').trim();
}

/**
 * Builds the collapsed group's summary: the first inputs it names and how many
 * actions it leaves unnamed. The component words it, so the text can be translated.
 *
 * Computed here rather than in the component so it happens once per grouping
 * pass instead of once per group render, and skipped entirely for runs the tool
 * group cache above can reuse — a run's preview depends on the whole run, which
 * is exactly what that cache compares.
 */
function buildGroupPreview(messages: ChatMessage[]): Pick<ToolGroupItem, 'previewNames' | 'previewExtraCount'> {
  const previewNames = messages
    .slice(0, PREVIEWED_TOOL_COUNT)
    .map(getToolInputPreview)
    .filter(Boolean);

  // Subtracted from the previews actually printed, not from the two slots the
  // line reserves, so that named + extraCount === messages.length for every
  // input. A tool whose input yields no text — a Read with no file_path, an
  // input still arriving as partial JSON — is genuinely not named, so it
  // belongs in the remainder.
  return { previewNames, previewExtraCount: messages.length - previewNames.length };
}

export function groupConsecutiveTools(
  messages: ChatMessage[],
  showThinking: boolean = true,
): MessageListItem[] {
  const items: MessageListItem[] = [];
  let index = 0;

  while (index < messages.length) {
    const message = messages[index];

    if (!isGroupableToolMessage(message)) {
      items.push(message);
      index += 1;
      continue;
    }

    const run: GroupableToolRun = [message];
    let nextIndex = index + 1;

    while (nextIndex < messages.length) {
      const candidate = messages[nextIndex];

      // Skip invisible interleaved messages so they don't break the run.
      if (rendersNothing(candidate, showThinking)) {
        nextIndex += 1;
        continue;
      }

      if (isGroupableToolMessage(candidate)) {
        run.push(candidate);
        nextIndex += 1;
        continue;
      }

      break;
    }

    if (run.length >= TOOL_GROUP_THRESHOLD) {
      items.push(getToolGroup(run, showThinking));
    } else {
      items.push(...run);
    }

    index = nextIndex;
  }

  return items;
}
