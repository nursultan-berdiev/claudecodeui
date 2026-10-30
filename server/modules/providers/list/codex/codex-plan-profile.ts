/**
 * Codex Plan permissions profile
 * ==============================
 *
 * Plan runs Codex commands in its sandbox under a named permissions profile
 * instead of Codex's built-in `read-only` mode, which forbids writes even to
 * /tmp and so cannot convert a .doc or .xls copy for reading (see
 * docker/agent-instructions.md). The profile reads what is left after the
 * denials below, writes only under /tmp and keeps network on (without it the
 * sandbox refuses AF_INET sockets and LibreOffice converts nothing).
 *
 * $HOME is closed by default: Plan may read only the skills Codex and
 * CloudCLI point it at and the uploaded attachments. Whether the running
 * Codex honours the profile is checked in codex-plan-check.ts.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ThreadOptions } from '@openai/codex-sdk';

import type { CodexConfig } from '@/modules/providers/list/codex/codex-config-overrides.js';

/** Name of the permissions profile Plan selects. */
export const CODEX_PLAN_PROFILE = 'cloudcli-plan';

/** Where Plan's file rules come from; `resolveCodexPlanPaths` fills it from the process. */
export type CodexPlanPaths = {
  home: string;
  /** Codex's own folder: `CODEX_HOME`, else ~/.codex. */
  codexHome: string;
  /** CloudCLI's user database (`DATABASE_PATH`), absolute. */
  databasePath: string;
  /** Root of the shared workspaces, whose `.env` files Plan must not read. */
  workspacesRoot: string;
  /** The chat's working folder. */
  cwd?: string;
};

/** Folder entries Plan's rules are built from, read once per turn. */
export type CodexPlanFolders = Map<string, string[]>;

/** Plan's sandbox for one turn, in the shape the Codex transports take. */
export type CodexPlanPermissions = Pick<ThreadOptions, 'sandboxMode' | 'approvalPolicy'> & { config?: CodexConfig };

/**
 * Plan's paths for this process, all absolute: `$HOME`, `CODEX_HOME`,
 * `DATABASE_PATH` and `WORKSPACES_ROOT` (default `$HOME`, as the server uses
 * it), plus the chat's folder.
 */
export function resolveCodexPlanPaths(cwd?: string): CodexPlanPaths {
  const home = realPath(os.homedir());
  return {
    home,
    codexHome: realPath(process.env.CODEX_HOME || path.join(home, '.codex')),
    databasePath: realPath(process.env.DATABASE_PATH || path.join(home, '.cloudcli', 'auth.db')),
    workspacesRoot: realPath(process.env.WORKSPACES_ROOT || home),
    cwd: cwd ? realPath(cwd) : undefined,
  };
}

/**
 * A path with symlinks followed, so that a link such as ~/work -> ~/.ssh is
 * judged by where it leads. A path that does not exist yet keeps its absolute
 * form.
 */
function realPath(target: string): string {
  const absolute = path.resolve(target);
  try {
    return fs.realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/**
 * Folders where Plan reads only the named entries: skills Codex is pointed at,
 * skills CloudCLI exports for chats, and uploaded attachments. Everything else
 * in $HOME is denied.
 */
function readableInside(paths: CodexPlanPaths): Map<string, Set<string>> {
  return new Map([
    [paths.codexHome, new Set(['skills', 'plugins'])],
    [path.join(paths.home, '.agents'), new Set(['skills'])],
    [path.join(paths.home, '.cloudcli'), new Set(['assets', 'skill-exports', 'session-skills'])],
  ]);
}

/**
 * Codex files denied by name even before they exist, so a file created during
 * the turn is covered too. No glob rules here: Codex expands a glob into every
 * match below the folder, and a match inside an already denied folder (a chat
 * transcript in `sessions`) stops bubblewrap from starting at all.
 */
const CODEX_SECRET_NAMES = ['auth.json', 'sessions', 'archived_sessions', 'history.jsonl', 'log'];

const GLOB_SPECIAL = /[*?[\]{}!]/;
const warnedGlobRoots = new Set<string>();

/** A glob rule under `root`, or nothing when `root` itself holds glob syntax and cannot be matched literally. */
function globUnder(root: string, pattern: string): string[] {
  if (!GLOB_SPECIAL.test(root)) {
    return [`${root}/${pattern}`];
  }
  if (!warnedGlobRoots.has(root)) {
    warnedGlobRoots.add(root);
    console.warn(`[Codex] Plan cannot deny ${pattern} under ${root}: the path itself contains glob syntax.`);
  }
  return [];
}

function isSameOrInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

/** A folder's entries; a missing folder has none, any other failure is an error, never a silent pass. */
function readFolder(folder: string): string[] {
  try {
    return fs.readdirSync(folder);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw new Error(`Cannot prepare the Codex Plan sandbox: reading ${folder} failed (${(error as Error).message})`);
  }
}

/** Reads $HOME and the partly open folders once, for one turn's rules. */
export function readCodexPlanFolders(paths: CodexPlanPaths): CodexPlanFolders {
  const folders: CodexPlanFolders = new Map([[paths.home, readFolder(paths.home)]]);
  for (const folder of readableInside(paths).keys()) {
    folders.set(folder, readFolder(folder));
  }
  return folders;
}

/**
 * Whether an entry of $HOME stays open because the workspaces or the chat's
 * folder lie inside it (outside Docker these can live in $HOME). Hidden
 * entries never do: they hold keys and sign-ins (`.ssh`, `.aws`, `.config`,
 * ...), and a chat working inside one cannot read its own folder in Plan,
 * which beats opening the keys. The entry is judged by where it leads, so a
 * link such as ~/work -> ~/.ssh counts as hidden.
 */
function holdsWork(paths: CodexPlanPaths, entry: string): boolean {
  const target = realPath(entry);
  const leadsToHidden = path.basename(entry).startsWith('.')
    || (isSameOrInside(target, paths.home) && path.relative(paths.home, target).split(path.sep)[0]?.startsWith('.'));
  if (leadsToHidden) {
    return false;
  }
  const workFolders = [paths.workspacesRoot, ...(paths.cwd ? [paths.cwd] : [])];
  return workFolders.some((folder) => isSameOrInside(folder, target) || isSameOrInside(folder, entry));
}

/**
 * What Codex in Plan must not read, from a snapshot of the folders. Every
 * entry of $HOME is denied except the partly open folders, where everything
 * but the named entries is denied in turn (a denied folder cannot re-allow a
 * child, hence entry by entry), and except a visible entry that holds the
 * workspaces or the chat's folder (see holdsWork).
 */
export function listCodexPlanDeniedPaths(paths: CodexPlanPaths, folders: CodexPlanFolders): string[] {
  const partlyOpen = readableInside(paths);
  const denied: string[] = [];
  for (const name of folders.get(paths.home) ?? []) {
    const entry = path.join(paths.home, name);
    if (!partlyOpen.has(entry) && !holdsWork(paths, entry)) {
      denied.push(entry);
    }
  }
  for (const [folder, readable] of partlyOpen) {
    for (const name of folders.get(folder) ?? []) {
      if (!readable.has(name)) {
        denied.push(path.join(folder, name));
      }
    }
  }
  denied.push(
    ...CODEX_SECRET_NAMES.map((name) => path.join(paths.codexHome, name)),
    ...databaseFiles(paths),
    path.join(path.dirname(paths.databasePath), 'backups'),
  );
  return [...new Set(denied)];
}

function isFolder(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** The user database and its SQLite side files. */
function databaseFiles(paths: CodexPlanPaths): string[] {
  return [paths.databasePath, `${paths.databasePath}-wal`, `${paths.databasePath}-shm`];
}

/**
 * Glob rules for `.env*` files under the workspaces root and the chat's
 * folder. A root that holds an existing denied folder, or lies inside one,
 * gets no rule: the glob would match inside the denied folder and stop
 * bubblewrap from starting. Outside Docker the workspaces root is $HOME itself, so there the
 * chat's folder carries the rule.
 */
export function listCodexPlanDeniedPatterns(paths: CodexPlanPaths, deniedPaths: string[]): string[] {
  // Only an existing denied folder can hold a match: files (the database) and
  // paths that do not exist yet cannot.
  const deniedFolders = deniedPaths.filter(isFolder);
  const candidates = [paths.workspacesRoot, ...(paths.cwd ? [paths.cwd] : [])];
  const roots = candidates.filter((root) => !deniedFolders.some(
    (denied) => isSameOrInside(denied, root) || isSameOrInside(root, denied),
  ));
  return [...new Set(roots)]
    .filter((root, _index, kept) => !kept.some((other) => other !== root && isSameOrInside(root, other)))
    .flatMap((root) => globUnder(root, '**/.env*'));
}

/** Plan's Codex config: the permissions profile, selected by default, and no login shell (~/.profile is denied). */
export function buildCodexPlanPermissionsConfig(
  paths: CodexPlanPaths,
  folders: CodexPlanFolders = readCodexPlanFolders(paths),
): CodexConfig {
  const filesystem: CodexConfig = { ':root': 'read', ':slash_tmp': 'write' };
  const deniedPaths = listCodexPlanDeniedPaths(paths, folders);
  for (const denied of [...deniedPaths, ...listCodexPlanDeniedPatterns(paths, deniedPaths)]) {
    filesystem[denied] = 'deny';
  }
  return {
    permissions: {
      [CODEX_PLAN_PROFILE]: { filesystem, network: { enabled: true } },
    },
    default_permissions: CODEX_PLAN_PROFILE,
    allow_login_shell: false,
  };
}
