import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CODEX_PLAN_PROFILE,
  buildCodexPlanPermissionsConfig,
  readCodexPlanFolders,
  resolveCodexPlanPaths,
} from '@/modules/providers/list/codex/codex-plan-profile.js';
import type { CodexPlanPaths } from '@/modules/providers/list/codex/codex-plan-profile.js';

type PlanFilesystem = Record<string, string>;

const planFilesystem = (paths: CodexPlanPaths): PlanFilesystem => {
  const config = buildCodexPlanPermissionsConfig(paths) as { permissions: Record<string, { filesystem: PlanFilesystem }> };
  return config.permissions[CODEX_PLAN_PROFILE].filesystem;
};

async function makeHome(): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'codex-plan-home-'));
  for (const dir of ['.codex/skills', '.codex/plugins', '.codex/sessions', '.agents/skills', '.agents/cache',
    '.cloudcli/assets', '.cloudcli/skill-exports', '.cloudcli/session-skills', '.cloudcli/backups',
    '.cloudcli/browser-use/profiles', '.aws', '.docker', '.ssh', '.claude', '.local/share/opencode']) {
    await mkdir(path.join(home, dir), { recursive: true });
  }
  for (const file of ['.codex/auth.json', '.codex/state_5.sqlite', '.cloudcli/auth.db', '.docker/config.json',
    '.netrc', '.claude.json', '.profile', '.bashrc', '.bash_logout', '.gitconfig']) {
    await writeFile(path.join(home, file), 'x');
  }
  return home;
}

test('Codex Plan closes $HOME except skills and attachments', async () => {
  const home = await makeHome();
  try {
    const paths: CodexPlanPaths = {
      home,
      codexHome: path.join(home, '.codex'),
      databasePath: path.join(home, '.cloudcli', 'auth.db'),
      workspacesRoot: '/workspace',
    };
    const config = buildCodexPlanPermissionsConfig(paths) as { allow_login_shell?: boolean };
    const filesystem = planFilesystem(paths);
    const at = (relative: string) => filesystem[path.join(home, relative)];

    assert.equal(filesystem[':root'], 'read');
    assert.equal(filesystem[':slash_tmp'], 'write');
    assert.equal(config.allow_login_shell, false, 'no login shell: ~/.profile is denied');
    for (const denied of ['.codex/auth.json', '.codex/sessions', '.codex/state_5.sqlite', '.agents/cache',
      '.cloudcli/auth.db', '.cloudcli/auth.db-wal', '.cloudcli/backups', '.cloudcli/browser-use',
      '.aws', '.docker', '.netrc', '.ssh', '.claude', '.claude.json', '.local',
      '.profile', '.bashrc', '.bash_logout', '.gitconfig',
      // Denied by name before they exist, so files created during the turn are covered.
      '.codex/history.jsonl', '.codex/archived_sessions']) {
      assert.equal(at(denied), 'deny', `${denied} is denied`);
    }
    for (const readable of ['.codex', '.codex/skills', '.codex/plugins', '.agents', '.agents/skills', '.cloudcli',
      '.cloudcli/assets', '.cloudcli/skill-exports', '.cloudcli/session-skills']) {
      assert.equal(at(readable), undefined, `${readable} stays readable`);
    }
    assert.equal(Object.keys(filesystem).some((key) => key.startsWith(`${path.join(home, '.codex')}/*`)), false,
      'no glob rules inside Codex\'s folder: they would match inside denied folders and stop the sandbox');
    assert.equal(filesystem['/workspace/**/.env*'], 'deny', 'project .env files are denied');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('Codex Plan keeps a project inside $HOME readable when the workspaces live there', async () => {
  const home = await makeHome();
  try {
    await mkdir(path.join(home, 'projects', 'app'), { recursive: true });
    const filesystem = planFilesystem({
      home,
      codexHome: path.join(home, '.codex'),
      databasePath: path.join(home, '.cloudcli', 'auth.db'),
      workspacesRoot: home,
      cwd: path.join(home, 'projects', 'app'),
    });
    assert.equal(filesystem[path.join(home, 'projects')], undefined, 'the folder holding the chat stays readable');
    assert.equal(filesystem[path.join(home, '.aws')], 'deny');
    // $HOME holds denied folders, so a glob over it would match inside them;
    // the chat's folder carries the .env rule instead.
    assert.equal(filesystem[`${home}/**/.env*`], undefined);
    assert.equal(filesystem[`${path.join(home, 'projects', 'app')}/**/.env*`], 'deny');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('Codex Plan follows CODEX_HOME, a relative DATABASE_PATH and a chat outside the workspaces', async () => {
  const home = await makeHome();
  const elsewhere = await mkdtemp(path.join(os.tmpdir(), 'codex-plan-elsewhere-'));
  try {
    await mkdir(path.join(elsewhere, 'codex', 'skills'), { recursive: true });
    await writeFile(path.join(elsewhere, 'codex', 'config.toml'), 'x');
    const paths: CodexPlanPaths = {
      home,
      codexHome: path.join(elsewhere, 'codex'),
      databasePath: path.join(elsewhere, 'data', 'cloudcli.db'),
      workspacesRoot: '/workspace',
      cwd: '/srv/project',
    };
    const filesystem = planFilesystem(paths);
    assert.equal(filesystem[path.join(elsewhere, 'codex', 'auth.json')], 'deny');
    assert.equal(filesystem[path.join(elsewhere, 'codex', 'config.toml')], 'deny');
    assert.equal(filesystem[path.join(elsewhere, 'codex', 'skills')], undefined);
    assert.equal(filesystem[path.join(elsewhere, 'data', 'cloudcli.db')], 'deny');
    assert.equal(filesystem[path.join(elsewhere, 'data', 'backups')], 'deny');
    assert.equal(filesystem[path.join(home, '.codex')], 'deny', 'an unused ~/.codex is closed like any other folder');
    assert.equal(filesystem['/srv/project/**/.env*'], 'deny');

    const previous = { CODEX_HOME: process.env.CODEX_HOME, DATABASE_PATH: process.env.DATABASE_PATH };
    process.env.CODEX_HOME = path.join(elsewhere, 'codex');
    process.env.DATABASE_PATH = 'relative/cloudcli.db';
    try {
      const resolved = resolveCodexPlanPaths('relative-cwd');
      assert.equal(resolved.codexHome, path.join(elsewhere, 'codex'));
      assert.equal(resolved.databasePath, path.resolve('relative/cloudcli.db'));
      assert.equal(resolved.cwd, path.resolve('relative-cwd'));
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(elsewhere, { recursive: true, force: true });
  }
});

test('Codex Plan skips and reports a glob rule whose root itself holds glob syntax', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const home = await makeHome();
  try {
    const filesystem = planFilesystem({
      home,
      codexHome: path.join(home, '.codex'),
      databasePath: path.join(home, '.cloudcli', 'auth.db'),
      workspacesRoot: '/srv/work[1]',
    });
    assert.equal(Object.keys(filesystem).some((key) => key.startsWith('/srv/work[1]/')), false);
    assert.ok(warn.mock.calls.some((call) => String(call.arguments[0]).includes('/srv/work[1]')), 'the skipped rule is logged');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('Codex Plan refuses to start when a folder it must close cannot be read', { skip: process.getuid?.() === 0 }, async () => {
  const home = await makeHome();
  try {
    await chmod(path.join(home, '.codex'), 0o000);
    assert.throws(
      () => readCodexPlanFolders({ home, codexHome: path.join(home, '.codex'), databasePath: path.join(home, 'db'), workspacesRoot: '/workspace' }),
      /Cannot prepare the Codex Plan sandbox/,
    );
  } finally {
    await chmod(path.join(home, '.codex'), 0o755);
    await rm(home, { recursive: true, force: true });
  }
});


test('Codex Plan opens the $HOME entry holding the chat but keeps the workspaces rule outside $HOME', async () => {
  const home = await makeHome();
  try {
    await mkdir(path.join(home, 'projects', 'app'), { recursive: true });
    const cwd = path.join(home, 'projects', 'app');
    const filesystem = planFilesystem({
      home,
      codexHome: path.join(home, '.codex'),
      databasePath: path.join(home, '.cloudcli', 'auth.db'),
      workspacesRoot: '/workspace',
      cwd,
    });
    assert.equal(filesystem[path.join(home, 'projects')], undefined, 'the entry holding the chat stays readable');
    assert.equal(filesystem[path.join(home, '.aws')], 'deny');
    assert.equal(filesystem['/workspace/**/.env*'], 'deny');
    assert.equal(filesystem[`${cwd}/**/.env*`], 'deny', 'the chat folder outside the workspaces root gets its own .env rule');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('Codex Plan keeps a key folder closed even when the chat folder lies inside it', async () => {
  const home = await makeHome();
  try {
    await mkdir(path.join(home, '.ssh', 'work'), { recursive: true });
    const cwd = path.join(home, '.ssh', 'work');
    const filesystem = planFilesystem({
      home,
      codexHome: path.join(home, '.codex'),
      databasePath: path.join(home, '.cloudcli', 'auth.db'),
      workspacesRoot: home,
      cwd,
    });
    assert.equal(filesystem[path.join(home, '.ssh')], 'deny');
    assert.equal(Object.keys(filesystem).some((key) => key.startsWith(`${cwd}/`)), false,
      'no glob inside a denied folder: it would stop the sandbox from starting');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('Codex Plan never opens a hidden $HOME entry, listed or not, around the chat folder', async () => {
  const home = await makeHome();
  try {
    for (const hidden of ['.cargo', '.vault-token-dir']) {
      const cwd = path.join(home, hidden, 'work');
      await mkdir(cwd, { recursive: true });
      const filesystem = planFilesystem({
        home,
        codexHome: path.join(home, '.codex'),
        databasePath: path.join(home, '.cloudcli', 'auth.db'),
        workspacesRoot: '/workspace',
        cwd,
      });
      assert.equal(filesystem[path.join(home, hidden)], 'deny', `${hidden} stays denied`);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('Codex Plan judges a $HOME link by where it leads', async () => {
  const home = await makeHome();
  try {
    await mkdir(path.join(home, '.ssh', 'work'), { recursive: true });
    await symlink(path.join(home, '.ssh'), path.join(home, 'work'));
    // The chat folder is given through the link; resolveCodexPlanPaths follows it.
    const previous = process.env.HOME;
    process.env.HOME = home;
    let paths: CodexPlanPaths;
    try {
      paths = { ...resolveCodexPlanPaths(path.join(home, 'work', 'work')), workspacesRoot: '/workspace' };
    } finally {
      if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous;
    }
    assert.equal(paths.cwd, path.join(home, '.ssh', 'work'), 'the chat folder is resolved through the link');
    const filesystem = planFilesystem(paths);
    assert.equal(filesystem[path.join(home, 'work')], 'deny', 'a visible link into a hidden folder is not opened');
    assert.equal(filesystem[path.join(home, '.ssh')], 'deny');
    assert.equal(Object.keys(filesystem).some((key) => key.includes('/.ssh/work/**')), false, 'no glob inside the denied folder');

    await mkdir(path.join(home, 'real-code', 'app'), { recursive: true });
    await symlink(path.join(home, 'real-code'), path.join(home, 'code'));
    const viaVisibleLink = planFilesystem({ ...paths, cwd: path.join(home, 'real-code', 'app') });
    assert.equal(viaVisibleLink[path.join(home, 'real-code')], undefined, 'the folder holding the chat is open');
    assert.equal(viaVisibleLink[path.join(home, 'code')], undefined, 'and so is a visible link to it');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('Codex Plan keeps the .env rule on a workspaces root that holds the user database', async () => {
  const home = await makeHome();
  try {
    const filesystem = planFilesystem({
      home,
      codexHome: path.join(home, '.codex'),
      databasePath: '/srv/workspace/.cloudcli/auth.db',
      workspacesRoot: '/srv/workspace',
    });
    assert.equal(filesystem['/srv/workspace/.cloudcli/auth.db'], 'deny');
    assert.equal(filesystem['/srv/workspace/**/.env*'], 'deny', 'database files and folders that do not exist do not cancel the rule');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
