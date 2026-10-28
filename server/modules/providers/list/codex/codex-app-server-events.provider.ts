import type { AnyRecord } from '@/shared/types.js';
import { readObjectRecord } from '@/shared/utils.js';

/**
 * How often a running command's output is re-sent while it streams. Each
 * update carries the whole output so far, so a chatty command would otherwise
 * resend kilobytes per line.
 */
const COMMAND_OUTPUT_UPDATE_MS = 300;

/**
 * How much of a running command's output an update carries. A build log or a
 * `cat` of a large file would otherwise be held whole in memory and resent
 * whole three times a second. The finished item always carries the full
 * output, so only the live view is cut, from the front.
 */
const COMMAND_OUTPUT_TAIL_CHARS = 64 * 1024;

/** The app-server's camelCase lifecycle statuses, as `codex exec` spells them. */
const EXEC_STATUS: Record<string, string> = {
  inProgress: 'in_progress',
  completed: 'completed',
  failed: 'failed',
  // A declined command or patch never ran; exec has no word for it.
  declined: 'failed',
};

const readString = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * The last `COMMAND_OUTPUT_TAIL_CHARS` of `text`, never starting on the second
 * half of a surrogate pair, with the number of characters cut from the front.
 */
function keepOutputTail(text: string): { tail: string; dropped: number } {
  if (text.length <= COMMAND_OUTPUT_TAIL_CHARS) {
    return { tail: text, dropped: 0 };
  }
  let start = text.length - COMMAND_OUTPUT_TAIL_CHARS;
  const first = text.charCodeAt(start);
  if (first >= 0xdc00 && first <= 0xdfff) {
    start += 1;
  }
  return { tail: text.slice(start), dropped: start };
}

const toExecStatus = (status: unknown): string => EXEC_STATUS[readString(status)] ?? 'in_progress';

/**
 * A turn error's message, readable. The server forwards API failures as the
 * raw JSON body (`{"type":"error","status":400,"error":{"message":"..."}}`);
 * the user wants the sentence inside it, not the envelope.
 */
export function readCodexTurnErrorMessage(error: unknown): string {
  const record = readObjectRecord(error);
  const message = readString(record?.message) || 'Codex turn failed';
  try {
    const parsed = readObjectRecord(JSON.parse(message));
    const inner = readObjectRecord(parsed?.error);
    const innerMessage = readString(inner?.message) || readString(parsed?.message);
    return innerMessage || message;
  } catch {
    return message;
  }
}

/**
 * Maps one app-server `ThreadItem` onto the item `codex exec` reports for the
 * same thing, or `null` for items the live chat has never shown (the user's
 * own message, hook prompts, compaction markers, ...).
 *
 * The exec shape is what `transformCodexEvent` and the Codex normalizer
 * already understand, so the transcript renders the same either way; history
 * is unaffected because both transports write the same rollout file.
 */
export function toExecThreadItem(item: unknown): AnyRecord | null {
  const record = readObjectRecord(item);
  if (!record) {
    return null;
  }
  const id = readString(record.id);

  switch (record.type) {
    case 'agentMessage':
      return { id, type: 'agent_message', text: readString(record.text) };

    case 'reasoning': {
      const summary = Array.isArray(record.summary) ? record.summary.filter((part) => typeof part === 'string') : [];
      const content = Array.isArray(record.content) ? record.content.filter((part) => typeof part === 'string') : [];
      const text = (summary.length > 0 ? summary : content).join('\n\n').trim();
      // Most reasoning items carry nothing readable; exec never sent those.
      return text ? { id, type: 'reasoning', text } : null;
    }

    case 'commandExecution':
      return {
        id,
        type: 'command_execution',
        command: readString(record.command),
        aggregated_output: readString(record.aggregatedOutput),
        ...(typeof record.exitCode === 'number' ? { exit_code: record.exitCode } : {}),
        status: toExecStatus(record.status),
      };

    case 'fileChange':
      return {
        id,
        type: 'file_change',
        changes: (Array.isArray(record.changes) ? record.changes : []).map((change: AnyRecord) => ({
          path: readString(change?.path),
          kind: readString(readObjectRecord(change?.kind)?.type) || 'update',
        })),
        status: toExecStatus(record.status),
      };

    case 'mcpToolCall': {
      const result = readObjectRecord(record.result);
      const error = readObjectRecord(record.error);
      return {
        id,
        type: 'mcp_tool_call',
        server: readString(record.server),
        tool: readString(record.tool),
        arguments: record.arguments,
        ...(result ? { result: { content: result.content, structured_content: result.structuredContent ?? null } } : {}),
        ...(error ? { error: { message: readString(error.message) } } : {}),
        status: toExecStatus(record.status),
      };
    }

    case 'webSearch':
      return { id, type: 'web_search', query: readString(record.query) };

    default:
      return null;
  }
}

/**
 * Turns one `codex app-server` turn's notifications into the events the Codex
 * runtime consumes: the exec SDK's events, plus `agent_message.delta` for each
 * piece of reply text as it is written.
 */
export type CodexAppServerTranslator = {
  /** Exec-shaped events for one notification; usually zero or one. */
  translate: (method: string, params: AnyRecord) => AnyRecord[];
  /** Set once the turn this translator follows has completed, failed or been interrupted. */
  readonly finished: boolean;
};

/**
 * Used by the Codex runtime for each app-server turn.
 *
 * Only the turn named by `turnId` is followed (a thread can carry an earlier
 * turn's late notifications); the caller holds turn-scoped notifications back
 * until the id is known. Token usage is remembered from
 * `thread/tokenUsage/updated` and reported on the turn's completion the way
 * exec does, but from the last request rather than the turn's sum: the
 * composer counter shows how full the context is, not what the turn cost.
 */
export function createCodexAppServerTranslator(turnId: () => string | null): CodexAppServerTranslator {
  let finished = false;
  let lastUsage: AnyRecord | null = null;
  let modelContextWindow: number | null = null;
  // Running commands, keyed by item id, so output deltas can be folded into
  // the item and re-sent on a throttle. Only the output's tail is kept;
  // `droppedChars` counts what was cut from the front.
  const runningCommands = new Map<string, { item: AnyRecord; output: string; droppedChars: number; lastSentAt: number }>();

  const isForThisTurn = (params: AnyRecord) => {
    const current = turnId();
    // Item notifications name the turn on `turnId`, `turn/*` ones on `turn.id`.
    const notificationTurnId = params.turnId ?? readObjectRecord(params.turn)?.id;
    return !current || !notificationTurnId || notificationTurnId === current;
  };

  const translateItem = (type: 'item.started' | 'item.completed', params: AnyRecord): AnyRecord[] => {
    const item = toExecThreadItem(params.item);
    if (!item) {
      return [];
    }
    if (item.type === 'command_execution') {
      if (type === 'item.started') {
        const { tail, dropped } = keepOutputTail(String(item.aggregated_output ?? ''));
        runningCommands.set(item.id, { item, output: tail, droppedChars: dropped, lastSentAt: Date.now() });
      } else {
        runningCommands.delete(item.id);
      }
    }
    return [{ type, item }];
  };

  return {
    get finished() {
      return finished;
    },

    translate(method, params) {
      if (finished || !isForThisTurn(params)) {
        return [];
      }

      switch (method) {
        case 'item/started':
          return translateItem('item.started', params);

        case 'item/completed':
          return translateItem('item.completed', params);

        case 'item/agentMessage/delta': {
          const delta = readString(params.delta);
          const itemId = readString(params.itemId);
          return delta && itemId ? [{ type: 'agent_message.delta', item_id: itemId, delta }] : [];
        }

        case 'item/commandExecution/outputDelta': {
          const running = runningCommands.get(readString(params.itemId));
          if (!running) {
            return [];
          }
          const { tail, dropped } = keepOutputTail(running.output + readString(params.delta));
          running.output = tail;
          running.droppedChars += dropped;
          const now = Date.now();
          if (now - running.lastSentAt < COMMAND_OUTPUT_UPDATE_MS) {
            return [];
          }
          running.lastSentAt = now;
          const notice = running.droppedChars > 0
            ? `[${Math.ceil(running.droppedChars / 1024)} KB of earlier output not shown while the command runs]\n`
            : '';
          return [{ type: 'item.updated', item: { ...running.item, aggregated_output: `${notice}${running.output}` } }];
        }

        case 'turn/plan/updated': {
          const plan = Array.isArray(params.plan) ? params.plan : [];
          return [{
            type: 'item.updated',
            item: {
              id: `plan_${readString(params.turnId)}`,
              type: 'todo_list',
              items: plan.map((step: AnyRecord) => ({
                text: readString(step?.step),
                completed: step?.status === 'completed',
              })),
            },
          }];
        }

        case 'thread/tokenUsage/updated': {
          const tokenUsage = readObjectRecord(params.tokenUsage);
          lastUsage = readObjectRecord(tokenUsage?.last);
          if (typeof tokenUsage?.modelContextWindow === 'number') {
            modelContextWindow = tokenUsage.modelContextWindow;
          }
          return [];
        }

        case 'error':
          // A retried failure is noise; the final one also fails the turn,
          // which is what reports it (as exec's `error` + `turn.failed`).
          return params.willRetry ? [] : [{ type: 'error', message: readCodexTurnErrorMessage(params.error) }];

        case 'turn/completed': {
          finished = true;
          const turn = readObjectRecord(params.turn);
          if (turn?.status === 'failed') {
            return [{ type: 'turn.failed', error: { message: readCodexTurnErrorMessage(turn.error) } }];
          }
          if (turn?.status === 'interrupted') {
            return [];
          }
          return [{
            type: 'turn.completed',
            usage: lastUsage
              ? {
                input_tokens: lastUsage.inputTokens,
                cached_input_tokens: lastUsage.cachedInputTokens,
                output_tokens: lastUsage.outputTokens,
                total_tokens: lastUsage.totalTokens,
                ...(modelContextWindow ? { model_context_window: modelContextWindow } : {}),
              }
              : null,
          }];
        }

        default:
          return [];
      }
    },
  };
}
