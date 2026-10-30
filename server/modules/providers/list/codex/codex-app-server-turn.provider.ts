import { openCodexAppServer } from '@/modules/providers/list/codex/codex-app-server.client.js';
import { createCodexAppServerTranslator } from '@/modules/providers/list/codex/codex-app-server-events.provider.js';
import type { AnyRecord, CodexAppServerConnection, ProviderRuntimeContext } from '@/shared/types.js';

/** How long an interrupted turn may take to wind down before its process is killed. */
const INTERRUPT_GRACE_MS = 1_500;

/** What CloudCLI answers when Codex asks to run something it has not been cleared for. */
const DECLINED_REASON = 'CloudCLI runs Codex without interactive approvals.';

/** One item of a turn's input, in `codex exec`'s spelling (see buildCodexInputItems). */
type ExecInputItem = { type: string; text?: string; path?: string };

/**
 * One chat turn to run over `codex app-server`, with the settings the exec
 * transport passes as CLI flags.
 */
export type CodexAppServerTurnInput = {
  /** Thread to resume, or null to start a new one. */
  providerSessionId: string | null;
  workingDirectory: string;
  model?: string;
  effort?: string;
  /** Unset when `config` picks a named permissions profile instead (Plan). */
  sandboxMode?: string;
  approvalPolicy: string;
  /** Codex config overrides for the thread, such as Plan's permissions profile. */
  config?: AnyRecord;
  developerInstructions: string | null | undefined;
  /** The prompt, or exec-style input items when the turn carries images. */
  input: string | ExecInputItem[];
  /** Aborting it interrupts the turn and then ends the process. */
  signal: AbortSignal;
  /** Test seam; production spawns the bundled CLI. */
  open?: ProviderRuntimeContext['openCodexAppServer'];
};

/** A started turn: its thread id and the events it produces, in exec's shape. */
export type CodexAppServerTurn = {
  threadId: string;
  events: AsyncGenerator<AnyRecord>;
  /**
   * Ends the turn's process: interrupts the turn if it is still running,
   * waits briefly for it to wind down, then closes. Idempotent, and run by
   * `events` when iteration ends; the caller still calls it in its own
   * `finally`, so a process never outlives a run whose events were never read.
   */
  dispose: () => Promise<void>;
};

/**
 * Answers a request the server sends mid-turn. Nothing may be left pending,
 * or the turn hangs. Exec cannot grant approvals or ask the user anything, so
 * declining keeps the app-server transport exactly as permissive as exec;
 * routing these into the chat's permission prompt is separate work.
 */
function answerServerRequest(method: string): unknown {
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return { decision: 'decline' };
    case 'execCommandApproval':
    case 'applyPatchApproval':
      return { decision: { denied: { rejection: DECLINED_REASON } } };
    case 'item/tool/requestUserInput':
      return { answers: {} };
    case 'mcpServer/elicitation/request':
      return { action: 'decline', content: null, _meta: null };
    default:
      throw new Error(`CloudCLI does not handle "${method}".`);
  }
}

/** The app-server's input items for a turn, from exec's. */
function toAppServerInput(input: string | ExecInputItem[]): AnyRecord[] {
  if (typeof input === 'string') {
    return [{ type: 'text', text: input, text_elements: [] }];
  }
  return input.flatMap((item): AnyRecord[] => {
    if (item.type === 'text') {
      return [{ type: 'text', text: item.text ?? '', text_elements: [] }];
    }
    if (item.type === 'local_image' && item.path) {
      return [{ type: 'localImage', path: item.path }];
    }
    return [];
  });
}

/** Events pushed by notification handlers, pulled by the turn's generator. */
function createEventQueue() {
  const items: AnyRecord[] = [];
  let wake: (() => void) | null = null;
  let failure: Error | null = null;
  let ended = false;
  const notify = () => {
    const resolve = wake;
    wake = null;
    resolve?.();
  };

  return {
    push(event: AnyRecord) {
      items.push(event);
      notify();
    },
    fail(error: Error) {
      failure = error;
      notify();
    },
    end() {
      ended = true;
      notify();
    },
    async *drain(): AsyncGenerator<AnyRecord> {
      for (;;) {
        const next = items.shift();
        if (next) {
          yield next;
          continue;
        }
        if (failure) {
          throw failure;
        }
        if (ended) {
          return;
        }
        await new Promise<void>((resolve) => { wake = resolve; });
      }
    },
  };
}

/**
 * Used by the Codex runtime (`codex-runtime.provider.ts`) when
 * `CLOUDCLI_CODEX_TRANSPORT=app-server`: starts the turn and returns its
 * events, which stream the reply (`agent_message.delta`) where exec only
 * reports finished messages.
 *
 * Everything up to `turn/start` is awaited here, so a failure to start —
 * the CLI missing, the handshake failing, a thread that cannot be resumed —
 * rejects this call before any of the turn has run, and the runtime can fall
 * back to exec. After that, failures surface through the events.
 *
 * One process per turn, as exec runs one: the process ends with the turn, so
 * nothing outlives a run that the abort path does not know about.
 */
export async function startCodexAppServerTurn(input: CodexAppServerTurnInput): Promise<CodexAppServerTurn> {
  const queue = createEventQueue();
  let turnId: string | null = null;
  let processExited = false;
  const translator = createCodexAppServerTranslator(() => turnId);
  // Turn-scoped notifications that arrive before `turn/start` has answered
  // with the turn's id are held, then replayed once the id is known: without
  // the id there is no telling this turn's from a late one of an earlier turn.
  let heldNotifications: Array<[string, AnyRecord]> | null = [];
  // Resolves once the turn is over or the process is gone; lets `dispose`
  // stop waiting as soon as an interrupt has taken effect.
  let settle: () => void = () => {};
  const settled = new Promise<void>((resolve) => { settle = resolve; });

  const deliver = (method: string, params: AnyRecord) => {
    for (const event of translator.translate(method, params)) {
      queue.push(event);
    }
    if (translator.finished) {
      queue.end();
      settle();
    }
  };

  const open = input.open ?? openCodexAppServer;
  const connection: CodexAppServerConnection = await open({
    onNotification: (method, params) => {
      // `turn/*` notifications carry the id on `turn.id`, item ones on `turnId`.
      const notificationTurnId = typeof params.turnId === 'string' ? params.turnId : params.turn?.id;
      if (heldNotifications && typeof notificationTurnId === 'string') {
        heldNotifications.push([method, params]);
        return;
      }
      deliver(method, params);
    },
    onServerRequest: (method) => answerServerRequest(method),
    onExit: (reason) => {
      processExited = true;
      settle();
      if (!translator.finished) {
        queue.fail(new Error(reason));
      }
    },
  });

  const config = input.config || input.effort
    ? { ...input.config, ...(input.effort ? { model_reasoning_effort: input.effort } : {}) }
    : null;
  let threadId: string;
  try {
    const threadSettings = {
      cwd: input.workingDirectory,
      ...(input.model ? { model: input.model } : {}),
      // An explicit sandbox mode overrides a permissions profile in `config`.
      ...(input.sandboxMode ? { sandbox: input.sandboxMode } : {}),
      approvalPolicy: input.approvalPolicy,
      ...(input.developerInstructions ? { developerInstructions: input.developerInstructions } : {}),
      // Effort is passed as config, the way exec passes it, so every effort the
      // model catalog offers reaches the CLI unchanged.
      ...(config ? { config } : {}),
    };
    const started = await connection.request(
      input.providerSessionId ? 'thread/resume' : 'thread/start',
      input.providerSessionId
        ? { threadId: input.providerSessionId, ...threadSettings, excludeTurns: true }
        : threadSettings,
    ) as { thread?: { id?: unknown } } | undefined;
    threadId = typeof started?.thread?.id === 'string' ? started.thread.id : '';
    if (!threadId) {
      throw new Error('Codex app-server started a thread without an id.');
    }

    const turn = await connection.request('turn/start', {
      threadId,
      input: toAppServerInput(input.input),
    }) as { turn?: { id?: unknown } } | undefined;
    turnId = typeof turn?.turn?.id === 'string' ? turn.turn.id : null;
  } catch (error) {
    connection.close();
    throw error;
  }

  const held = heldNotifications;
  heldNotifications = null;
  for (const [method, params] of held) {
    deliver(method, params);
  }

  let interruptSent = false;
  const interrupt = () => {
    if (interruptSent || !turnId || translator.finished || processExited) {
      return;
    }
    interruptSent = true;
    connection.request('turn/interrupt', { threadId, turnId }).catch((error) => {
      // A stop that does nothing must be diagnosable; `dispose` ends the
      // process after the grace either way.
      console.warn('[Codex] turn/interrupt failed:', error instanceof Error ? error.message : error);
    });
  };

  let disposed: Promise<void> | null = null;
  const dispose = () => {
    disposed ??= (async () => {
      input.signal.removeEventListener('abort', onAbort);
      if (!translator.finished && !processExited) {
        // Stopped before the turn ended (an abort): let the server record the
        // interruption before the process goes, but no longer than the grace.
        interrupt();
        let graceTimer: ReturnType<typeof setTimeout> | null = null;
        await Promise.race([
          settled,
          // Not unref'd: the grace is short, and the process must still be
          // closed when it runs out.
          new Promise<void>((resolve) => {
            graceTimer = setTimeout(resolve, INTERRUPT_GRACE_MS);
          }),
        ]);
        if (graceTimer) {
          clearTimeout(graceTimer);
        }
      }
      connection.close();
    })();
    return disposed;
  };

  // An abort ends the turn on its own: a server stuck in a tool call may
  // never answer the interrupt with `turn/completed`, and the events would
  // then never end. Closing the process fails the events, which ends the
  // reader's loop.
  function onAbort() {
    // Nothing awaits an abort listener, so a failure here would surface as an
    // unhandled rejection; log it instead.
    dispose().catch((error) => {
      console.warn('[Codex] Ending an aborted app-server turn failed:', error instanceof Error ? error.message : error);
    });
  }
  input.signal.addEventListener('abort', onAbort, { once: true });
  // The abort may already have happened while the turn was being started.
  if (input.signal.aborted) {
    onAbort();
  }

  async function* events(): AsyncGenerator<AnyRecord> {
    try {
      // Same opening event as exec, so the runtime captures the thread id the
      // way it always has.
      yield { type: 'thread.started', thread_id: threadId };
      yield* queue.drain();
    } finally {
      await dispose();
    }
  }

  return { threadId, events: events(), dispose };
}
