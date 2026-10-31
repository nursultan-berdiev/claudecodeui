/**
 * Codex Plan sandbox check
 * ========================
 *
 * Codex applies Plan's permissions profile (codex-plan-profile.ts) only when
 * no sandbox mode is passed, so a Codex that ignored the profile would run
 * Plan with whatever sandbox its own config names. Before a Plan turn runs,
 * the server therefore checks the real profile on a throwaway layout in
 * Codex's sandbox. Until it passes, Plan turns fail with a clear error: there
 * is no fallback to Codex's `read-only` sandbox, which reads all of $HOME
 * (sign-ins, the user database) and so would hand them to a prompt injected
 * through an attachment.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { resolveCodexLauncher } from '@/modules/providers/list/codex/codex-cli.js';
import { toCodexConfigOverrides } from '@/modules/providers/list/codex/codex-config-overrides.js';
import type { CodexConfig } from '@/modules/providers/list/codex/codex-config-overrides.js';
import {
  CodexPlanRefusal,
  buildCodexPlanPermissionsConfig,
  resolveCodexPlanPaths,
} from '@/modules/providers/list/codex/codex-plan-profile.js';
import type { CodexPlanPaths, CodexPlanPermissions } from '@/modules/providers/list/codex/codex-plan-profile.js';
import { AppError } from '@/shared/utils.js';

const execFileAsync = promisify(execFile);

/**
 * What one check found: the profile is `honoured`; Codex got a rule wrong
 * (`ignored`); the sandbox could not start at all (`no-sandbox`); or the
 * check could not lay out its throwaway folder in the server's home
 * (`no-scratch`: read-only or full disk); or it could not run for another
 * reason (`unknown`: timeout, spawn failure).
 */
export type PlanCheckOutcome = 'honoured' | 'ignored' | 'no-sandbox' | 'no-scratch' | 'unknown';

/**
 * A check's result: its outcome and, when it is not `honoured`, why. `detail`
 * is for the server log only: it can hold the command line and absolute
 * paths, so it never reaches the chat.
 */
export type PlanCheckResult = { outcome: PlanCheckOutcome; detail: string };

/** One probe of the check: a file that must read or be refused, or a folder that must or must not take a write. */
export type PlanCheckExpectation = { name: string; target: string; expect: 'read' | 'denied' | 'write' | 'no-write' };

const CHECK_END = 'PLAN_CHECK_END';

type PlanCheckLayout = { paths: CodexPlanPaths; config: CodexConfig; expectations: PlanCheckExpectation[]; cwd: string };

async function writeProbe(file: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, 'probe');
}

/**
 * Lays out a throwaway home, a workspaces root and a chat folder under
 * `base`, builds Plan's profile for them and lists what each probe must do.
 * `base` must lie outside /tmp, which the profile makes writable, so "the
 * chat folder takes no write" means something. The chat folder sits in the
 * home, next to a key folder, as it does outside Docker; the workspaces root
 * lies outside the home, as it does in Docker. Exported for tests.
 */
export async function preparePlanCheckLayout(base: string): Promise<PlanCheckLayout> {
  const home = path.join(base, 'home');
  const workspaces = path.join(base, 'workspace');
  const chat = path.join(home, 'code', 'chat');
  const files = {
    chatFile: path.join(chat, 'app.js'),
    chatEnv: path.join(chat, '.env'),
    workspaceFile: path.join(workspaces, 'project', 'app.js'),
    workspaceEnv: path.join(workspaces, 'project', 'nested', '.env.local'),
    skill: path.join(home, '.codex', 'skills', 'probe', 'SKILL.md'),
    attachment: path.join(home, '.cloudcli', 'assets', 'attachment.txt'),
    signIn: path.join(home, '.codex', 'auth.json'),
    // Deep inside a denied folder, as real chat transcripts are: a rule that
    // also matched it would stop the sandbox from starting.
    transcript: path.join(home, '.codex', 'sessions', '2026', '01', 'rollout.jsonl'),
    sshKey: path.join(home, '.ssh', 'id_ed25519'),
    shellRc: path.join(home, '.bashrc'),
  };
  for (const file of Object.values(files)) {
    await writeProbe(file);
  }
  const paths: CodexPlanPaths = {
    home,
    codexHome: path.join(home, '.codex'),
    databasePath: path.join(home, '.cloudcli', 'auth.db'),
    workspacesRoot: workspaces,
    cwd: chat,
  };
  const config = buildCodexPlanPermissionsConfig(paths);
  // Written only now that the rules are built: a file Codex creates during a
  // turn is covered only by a rule by name, and this checks that rule.
  const lateHistory = path.join(home, '.codex', 'history.jsonl');
  await writeProbe(lateHistory);
  const expectations: PlanCheckExpectation[] = [
    { name: 'chat file', target: files.chatFile, expect: 'read' },
    { name: 'workspace file', target: files.workspaceFile, expect: 'read' },
    { name: 'skill', target: files.skill, expect: 'read' },
    { name: 'attachment', target: files.attachment, expect: 'read' },
    { name: 'Codex sign-in', target: files.signIn, expect: 'denied' },
    { name: 'chat transcript', target: files.transcript, expect: 'denied' },
    { name: 'late Codex history', target: lateHistory, expect: 'denied' },
    { name: 'key folder', target: files.sshKey, expect: 'denied' },
    { name: 'shell rc file', target: files.shellRc, expect: 'denied' },
    { name: 'chat .env', target: files.chatEnv, expect: 'denied' },
    { name: 'workspace .env', target: files.workspaceEnv, expect: 'denied' },
    { name: 'write /tmp', target: '/tmp', expect: 'write' },
    { name: 'write chat folder', target: chat, expect: 'no-write' },
  ];
  return { paths, config, expectations, cwd: chat };
}

/** A shell script that prints `PLAN_CHECK <index> yes|no` per probe and an end marker. Exported for tests. */
export function buildPlanCheckScript(expectations: PlanCheckExpectation[]): string {
  const lines = expectations.map(({ target, expect }, index) => {
    const quoted = `'${target.replace(/'/g, `'\\''`)}'`;
    const probe = expect === 'read' || expect === 'denied'
      ? `head -c1 ${quoted} > /dev/null 2>&1`
      : `t=$(mktemp -d -p ${quoted} 2>/dev/null) && rm -rf "$t"`;
    return `if ${probe}; then echo "PLAN_CHECK ${index} yes"; else echo "PLAN_CHECK ${index} no"; fi`;
  });
  return [...lines, `echo ${CHECK_END}`].join('\n');
}

type ExecFile = (file: string, args: string[], options: { cwd: string; timeout: number }) => Promise<{ stdout: string; stderr: string }>;

/**
 * Runs the script in Codex's sandbox under `config`. A failed run still
 * hands back what it printed; `exec` is replaced in tests, which also call it
 * directly.
 */
export async function runInCodexSandbox(
  config: CodexConfig,
  script: string,
  cwd: string,
  exec: ExecFile = execFileAsync,
): Promise<{ stdout: string; stderr: string }> {
  const overrides = toCodexConfigOverrides(config).flatMap((override) => ['-c', override]);
  try {
    return await exec(process.execPath, [resolveCodexLauncher(), ...overrides, 'sandbox', '--', 'sh', '-c', script], {
      cwd,
      timeout: 20_000,
    });
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; message?: string };
    return { stdout: failed.stdout ?? '', stderr: failed.stderr || failed.message || '' };
  }
}

/** A line bubblewrap printed about its own failure, also when a caller prefixed it (`Error: bwrap: ...`). */
const BWRAP_FAILURE = /(?:^|\s)(bwrap: .+)$/m;

/**
 * Reads the check's output. Without the end marker the check did not finish:
 * if bubblewrap reported a failure the sandbox could not start, otherwise
 * something else stopped it. Exported for tests.
 */
export function classifyPlanCheck(
  output: { stdout: string; stderr: string },
  expectations: PlanCheckExpectation[],
): PlanCheckResult & { wrong: string[] } {
  if (!output.stdout.includes(CHECK_END)) {
    const bwrapFailure = BWRAP_FAILURE.exec(output.stderr)?.[1]?.trim();
    return bwrapFailure
      ? { outcome: 'no-sandbox', wrong: [], detail: bwrapFailure }
      : { outcome: 'unknown', wrong: [], detail: output.stderr.trim().slice(0, 300) };
  }
  const results = new Map(output.stdout.split('\n')
    .map((line) => /^PLAN_CHECK (\d+) (yes|no)$/.exec(line.trim()))
    .filter((match): match is RegExpExecArray => Boolean(match))
    .map((match) => [Number(match[1]), match[2] === 'yes']));
  const wrong = expectations
    .filter(({ expect }, index) => results.get(index) !== (expect === 'read' || expect === 'write'))
    .map(({ name }) => name);
  return wrong.length > 0
    ? { outcome: 'ignored', wrong, detail: `wrong: ${wrong.join(', ')}` }
    : { outcome: 'honoured', wrong: [], detail: '' };
}

function failedCheck(outcome: 'no-scratch' | 'unknown', error: unknown): PlanCheckResult {
  const detail = error instanceof Error ? error.message : String(error);
  console.warn(`[Codex] Plan sandbox check could not run (${outcome}); Plan turns are refused for now:`, detail);
  return { outcome, detail };
}

/**
 * Runs Plan's real profile once, on a throwaway layout under `parent` (the
 * server's home by default), in Codex's sandbox. Exported for tests.
 */
export async function runPlanProfileCheck(parent: string = os.homedir()): Promise<PlanCheckResult> {
  let base: string | null = null;
  try {
    let layout: PlanCheckLayout;
    try {
      base = await fs.promises.mkdtemp(path.join(parent, '.cloudcli-plan-check-'));
      layout = await preparePlanCheckLayout(base);
    } catch (error) {
      return failedCheck('no-scratch', error);
    }
    const output = await runInCodexSandbox(layout.config, buildPlanCheckScript(layout.expectations), layout.cwd);
    const { outcome, detail } = classifyPlanCheck(output, layout.expectations);
    if (outcome !== 'honoured') {
      console.warn(`[Codex] Plan sandbox check: ${outcome}; Plan turns are refused for now.`, detail);
    }
    return { outcome, detail };
  } catch (error) {
    return failedCheck('unknown', error);
  } finally {
    if (base) {
      await fs.promises.rm(base, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/**
 * How long an answer is kept. "Honoured" holds until a restart. A "no" holds
 * for a while, then the check runs again, so a fixed host (seccomp profile,
 * Codex upgrade) recovers without a restart. A check that could not run is
 * retried soon, but not on every turn: it can take up to 20 seconds. Exported
 * for tests.
 */
export const PLAN_CHECK_ANSWER_TTL_MS: Record<PlanCheckOutcome, number> = {
  honoured: Number.POSITIVE_INFINITY,
  ignored: 10 * 60_000,
  'no-sandbox': 10 * 60_000,
  'no-scratch': 60_000,
  unknown: 60_000,
};

/** Wraps a check run with the cache above; turns that arrive during a run share it. Exported for tests. */
export function createCodexPlanProfileChecker(
  run: () => Promise<PlanCheckResult>,
  now: () => number = Date.now,
): () => Promise<PlanCheckResult> {
  let answer: { result: PlanCheckResult; until: number } | null = null;
  let inFlight: Promise<PlanCheckResult> | null = null;
  return () => {
    if (answer && now() < answer.until) {
      return Promise.resolve(answer.result);
    }
    inFlight ??= run()
      .then((result) => {
        answer = { result, until: now() + PLAN_CHECK_ANSWER_TTL_MS[result.outcome] };
        return result;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}

/**
 * The process-wide check. An object rather than a bare function so tests can
 * replace `check` with `t.mock.method` instead of running Codex.
 */
export const codexPlanSandbox = {
  check: createCodexPlanProfileChecker(() => runPlanProfileCheck()),
};

const REFUSAL: Record<Exclude<PlanCheckOutcome, 'honoured'>, string> = {
  ignored: 'this Codex does not apply the Plan sandbox rules correctly. Ask an administrator.',
  'no-sandbox': "Codex's sandbox cannot start in this container. Ask an administrator to check the seccomp profile in compose.yaml.",
  'no-scratch': "the server cannot create the Plan sandbox check's temporary folder in its home directory (read-only, full, or a path with glob characters). Ask an administrator.",
  unknown: 'the Plan sandbox check could not run. Try again in a minute.',
};

/**
 * Plan's sandbox for one turn: the permissions profile once Codex is known to
 * honour it. Otherwise the turn is refused with an error the chat shows. The
 * error holds a fixed reason only: the check's own `detail` (command line,
 * absolute paths, bubblewrap output) stays in the server log.
 */
export async function resolveCodexPlanPermissions(workingDirectory: string): Promise<CodexPlanPermissions> {
  const { outcome } = await codexPlanSandbox.check();
  if (outcome !== 'honoured') {
    throw new AppError(`Plan is unavailable: ${REFUSAL[outcome]}`, {
      code: 'CODEX_PLAN_SANDBOX_UNAVAILABLE',
      statusCode: 503,
    });
  }
  try {
    return { approvalPolicy: 'never', config: buildCodexPlanPermissionsConfig(resolveCodexPlanPaths(workingDirectory)) };
  } catch (error) {
    if (error instanceof CodexPlanRefusal) {
      throw new AppError(`Plan is unavailable: ${error.message}`, { code: 'CODEX_PLAN_FOLDER_UNSUPPORTED', statusCode: 400 });
    }
    throw error;
  }
}
