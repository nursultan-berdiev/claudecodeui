import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import readline from 'node:readline';

import { resolveCodexLauncher } from '@/modules/providers/list/codex/codex-cli.js';
import type { CodexAppServerConnection, CodexAppServerHandlers } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/**
 * Minimal JSON-RPC client for `codex app-server`.
 *
 * Codex ships two entry points and they expose different things. The
 * `@openai/codex-sdk` this app runs conversations through is a wrapper around
 * `codex exec`, and its whole surface is `startThread` and `resumeThread` —
 * there is no way to branch a thread or to resume one partway. The same
 * binary's `app-server` subcommand speaks JSON-RPC and does have that
 * primitive, `thread/fork`, which is what the Codex IDE clients build their
 * own "fork" and "edit an earlier message" on top of.
 *
 * So this is a second transport to the same CLI. Forks always go through it;
 * chat turns do when `CLOUDCLI_CODEX_TRANSPORT=app-server`, because only the
 * app-server streams the reply as it is written (`item/agentMessage/delta`) —
 * `codex exec` reports each message once it is finished.
 */

/** How long a single request may take before the child is killed. */
const REQUEST_TIMEOUT_MS = 30_000;

/** How long `close` waits after SIGTERM before it stops asking nicely. */
const CLOSE_GRACE_MS = 3_000;

/** JSON-RPC "method not found", sent for a server request nobody handles. */
const METHOD_NOT_FOUND = -32601;

type JsonRpcResponse = {
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string };
};

/**
 * One fork of a Codex thread.
 *
 * `path` is returned by the server rather than reconstructed: the rollout
 * lands in today's date directory, not next to the file it was copied from,
 * so deriving it from the source path would be wrong roughly every day.
 */
export type CodexThreadFork = {
  threadId: string;
  path: string;
};

/**
 * Used by the Codex runtime (`codex-runtime.provider.ts`) to run a chat turn
 * over the app-server, and by `forkThread` below: spawns `codex app-server`,
 * performs the `initialize` handshake and returns the live connection.
 *
 * Every stdout line is routed by shape, because the server's own requests
 * carry numeric ids too: `method` with `id` is a server request (answered
 * through `onServerRequest`), `method` alone is a notification, `id` alone is
 * a reply to one of ours. Treating every numeric id as a reply would resolve
 * the wrong pending call the first time the server asked for an approval.
 */
export async function openCodexAppServer(handlers: CodexAppServerHandlers): Promise<CodexAppServerConnection> {
  const launcher = resolveCodexLauncher();
  const child = spawn(process.execPath, [launcher, 'app-server'], {
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // The server logs sandbox and skill warnings to stderr on every start. They
  // are not failures and drowning the app log in them helps nobody, so stderr
  // is only kept around to explain a spawn that dies.
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr = (stderr + String(chunk)).slice(-2000);
  });

  let nextRequestId = 1;
  const pending = new Map<number, (response: JsonRpcResponse) => void>();
  let exitReason: string | null = null;
  let closed = false;

  const write = (message: Record<string, unknown>) => {
    if (exitReason) {
      return;
    }
    child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  };

  const answerServerRequest = async (id: unknown, method: string, params: Record<string, unknown>) => {
    try {
      const result = await handlers.onServerRequest(method, params);
      write({ id, result: result ?? null });
    } catch (error) {
      write({
        id,
        error: {
          code: METHOD_NOT_FOUND,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  };

  const reader = readline.createInterface({ input: child.stdout });
  reader.on('line', (line) => {
    if (!line.trim()) {
      return;
    }
    let message: JsonRpcResponse & { method?: unknown; params?: unknown };
    try {
      message = JSON.parse(line);
    } catch {
      // A non-JSON banner is not part of the protocol.
      return;
    }
    const params = (message.params && typeof message.params === 'object' ? message.params : {}) as Record<string, unknown>;
    if (typeof message.method === 'string') {
      if (message.id !== undefined && message.id !== null) {
        void answerServerRequest(message.id, message.method, params);
      } else {
        handlers.onNotification(message.method, params);
      }
      return;
    }
    if (typeof message.id !== 'number') {
      return;
    }
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });

  const failPending = (reason: string) => {
    if (!exitReason) {
      exitReason = reason;
      handlers.onExit(reason);
    }
    for (const resolve of pending.values()) {
      resolve({ error: { message: reason } });
    }
    pending.clear();
  };

  child.on('error', (error) => failPending(error.message));
  child.on('exit', (code, signal) => {
    // The reason reaches the chat as an error message; the server's own
    // stderr (paths, config warnings) stays in the server log.
    if (!closed && stderr.trim()) {
      console.warn('[Codex] app-server exited unexpectedly; last stderr:', stderr.trim().split('\n').slice(-3).join(' | '));
    }
    failPending(`codex app-server exited (code ${code ?? 'null'}, signal ${signal ?? 'null'})`);
  });
  // A child that dies mid-request leaves its pipes broken, and the next write
  // raises EPIPE on the stream rather than at the call site. Without a
  // listener that is an unhandled 'error' event, which takes the whole server
  // down over one failed request.
  child.stdin?.on('error', (error) => failPending(error.message));
  child.stdout?.on('error', (error) => failPending(error.message));
  child.stderr?.on('error', () => {});

  const request = (method: string, params: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (exitReason) {
        reject(new AppError(`Codex app-server is not running: ${exitReason}`, {
          code: 'CODEX_APP_SERVER_UNAVAILABLE',
          statusCode: 502,
        }));
        return;
      }

      const id = nextRequestId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new AppError(`Codex app-server did not answer "${method}" within ${REQUEST_TIMEOUT_MS}ms.`, {
          code: 'CODEX_APP_SERVER_TIMEOUT',
          statusCode: 504,
        }));
      }, REQUEST_TIMEOUT_MS);

      pending.set(id, (response) => {
        clearTimeout(timer);
        if (response.error) {
          reject(new AppError(response.error.message || `Codex app-server rejected "${method}".`, {
            code: 'CODEX_APP_SERVER_ERROR',
            statusCode: 502,
            details: { method, rpcCode: response.error.code },
          }));
          return;
        }
        resolve(response.result);
      });

      write({ id, method, params });
    });

  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    reader.close();
    child.kill('SIGTERM');
    // A server busy in a tool call can ignore SIGTERM; never leave it behind.
    const killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }, CLOSE_GRACE_MS);
    killTimer.unref?.();
  };

  try {
    // `capabilities` is deliberately empty: everything used here — threads,
    // turns, interrupt, fork with `lastTurnId` — is in the stable protocol.
    await request('initialize', {
      clientInfo: { name: 'cloudcli', title: 'CloudCLI', version: '1' },
      capabilities: {},
    });
    write({ method: 'initialized', params: {} });
  } catch (error) {
    close();
    throw error;
  }

  return { request, close };
}

/**
 * Runs one exchange against a freshly spawned `codex app-server`.
 *
 * A process per operation rather than a pooled long-lived one: the handshake
 * costs a fraction of a second, forking happens at most once per user action,
 * and a shared child would need lifecycle handling — restarts, back-pressure,
 * a crash taking every pending fork with it — for no measurable gain next to
 * the model turn that follows.
 */
async function withAppServer<T>(
  run: (call: (method: string, params: unknown) => Promise<unknown>) => Promise<T>,
): Promise<T> {
  const connection = await openCodexAppServer({
    onNotification: () => {},
    // A fork never starts a turn, so the server has nothing to ask for.
    onServerRequest: (method) => {
      throw new Error(`Unsupported request: ${method}`);
    },
    onExit: () => {},
  });
  try {
    return await run(connection.request);
  } finally {
    connection.close();
  }
}

export const codexAppServer = {
  /**
   * Copies a thread into a new one that ends at `lastTurnId`, or copies the
   * whole thread when it is omitted.
   *
   * `lastTurnId` is inclusive of the turn it names, which is the same
   * convention the app's edit anchor uses ("the last row to keep").
   *
   * `cwd` decides the working directory recorded in the copy's `session_meta`,
   * and that field is what the session indexer keys a session's project off —
   * omitting it would file every fork under whatever directory this server
   * happens to be running from.
   */
  async forkThread(input: {
    threadId: string;
    lastTurnId?: string;
    cwd: string;
  }): Promise<CodexThreadFork> {
    return withAppServer(async (call) => {
      const result = await call('thread/fork', {
        threadId: input.threadId,
        ...(input.lastTurnId ? { lastTurnId: input.lastTurnId } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {}),
      }) as { thread?: { id?: unknown; path?: unknown } } | undefined;

      const threadId = typeof result?.thread?.id === 'string' ? result.thread.id : '';
      const path = typeof result?.thread?.path === 'string' ? result.thread.path : '';
      if (!threadId || !path) {
        throw new AppError('Codex reported a fork without a thread id or transcript path.', {
          code: 'FORK_FAILED',
          statusCode: 502,
        });
      }

      // Confirmed rather than trusted: both callers are about to point a
      // database row at this file, and a row naming a transcript that is not
      // there is a session that can never be opened.
      try {
        await stat(path);
      } catch {
        throw new AppError('Codex reported a fork but wrote no transcript for it.', {
          code: 'FORK_FAILED',
          statusCode: 502,
        });
      }

      return { threadId, path };
    });
  },
};
