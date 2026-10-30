import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  PLAN_CHECK_ANSWER_TTL_MS,
  buildPlanCheckScript,
  classifyPlanCheck,
  codexPlanSandbox,
  createCodexPlanProfileChecker,
  preparePlanCheckLayout,
  resolveCodexPlanPermissions,
  runInCodexSandbox,
  runPlanProfileCheck,
} from '@/modules/providers/list/codex/codex-plan-check.js';
import type { PlanCheckExpectation, PlanCheckOutcome, PlanCheckResult } from '@/modules/providers/list/codex/codex-plan-check.js';
import { CODEX_PLAN_PROFILE } from '@/modules/providers/list/codex/codex-plan-profile.js';

const expectations: PlanCheckExpectation[] = [
  { name: 'project file', target: '/w/app.js', expect: 'read' },
  { name: 'Codex sign-in', target: '/h/.codex/auth.json', expect: 'denied' },
  { name: 'write /tmp', target: '/tmp', expect: 'write' },
  { name: 'write project', target: '/w', expect: 'no-write' },
];

test('the Plan check script probes every expectation and ends with a marker', () => {
  const script = buildPlanCheckScript([...expectations, { name: 'quote', target: "/w/it's", expect: 'read' }]);
  assert.equal(script.split('\n').filter((line) => line.includes('PLAN_CHECK ')).length, 5);
  assert.ok(script.includes(`'/w/it'\\''s'`), 'single quotes in paths are escaped');
  assert.ok(script.trimEnd().endsWith('echo PLAN_CHECK_END'));
});

test('the Plan check output is read into honoured, ignored, no-sandbox or unknown', () => {
  const lines = (answers: string[]) => `${answers.map((answer, index) => `PLAN_CHECK ${index} ${answer}`).join('\n')}\nPLAN_CHECK_END\n`;
  assert.equal(classifyPlanCheck({ stdout: lines(['yes', 'no', 'yes', 'no']), stderr: '' }, expectations).outcome, 'honoured');

  const wrong = classifyPlanCheck({ stdout: lines(['yes', 'yes', 'yes', 'yes']), stderr: '' }, expectations);
  assert.equal(wrong.outcome, 'ignored');
  assert.deepEqual(wrong.wrong, ['Codex sign-in', 'write project']);

  const missing = classifyPlanCheck({ stdout: 'PLAN_CHECK 0 yes\nPLAN_CHECK_END\n', stderr: '' }, expectations);
  assert.equal(missing.outcome, 'ignored', 'a probe that printed nothing counts as wrong');

  const noSandbox = classifyPlanCheck({ stdout: '', stderr: 'warning: something\nbwrap: No permissions to create a new namespace\n' }, expectations);
  assert.equal(noSandbox.outcome, 'no-sandbox');
  assert.equal(noSandbox.detail, 'bwrap: No permissions to create a new namespace');

  // Words alone are not a sandbox failure: only a line bubblewrap printed is.
  assert.equal(classifyPlanCheck({ stdout: '', stderr: 'Error: namespace bwrap timeout' }, expectations).outcome, 'unknown');
  const prefixed = classifyPlanCheck({ stdout: '', stderr: "Error: bwrap: Can't mkdir parents for /h/x: Read-only file system" }, expectations);
  assert.equal(prefixed.outcome, 'no-sandbox', 'a bwrap line behind a prefix still counts');
  assert.equal(prefixed.detail, "bwrap: Can't mkdir parents for /h/x: Read-only file system");
  assert.equal(classifyPlanCheck({ stdout: 'PLAN_CHECK 0 yes\n', stderr: 'killed' }, expectations).outcome, 'unknown');
});

test('the Plan check keeps "honoured" for good, a "no" for a while, a failed check briefly', async () => {
  let clock = 0;
  const now = () => clock;
  for (const outcome of ['honoured', 'ignored', 'no-sandbox', 'unknown'] as PlanCheckOutcome[]) {
    clock = 0;
    let runs = 0;
    const check = createCodexPlanProfileChecker(async () => { runs += 1; return { outcome, detail: '' }; }, now);
    assert.equal((await check()).outcome, outcome);
    clock = 30_000;
    assert.equal((await check()).outcome, outcome);
    assert.equal(runs, 1, `${outcome}: answered from the cache within its time`);
    const ttl = PLAN_CHECK_ANSWER_TTL_MS[outcome];
    clock = Number.isFinite(ttl) ? ttl + 1 : 365 * 24 * 3_600_000;
    await check();
    assert.equal(runs, Number.isFinite(ttl) ? 2 : 1, `${outcome}: ${Number.isFinite(ttl) ? 'runs again after its time' : 'kept until a restart'}`);
  }
  assert.ok(PLAN_CHECK_ANSWER_TTL_MS.unknown < PLAN_CHECK_ANSWER_TTL_MS.ignored, 'a failed check is retried sooner than a "no"');
});

test('turns that arrive during a Plan check share it', async () => {
  let runs = 0;
  let finish: (result: PlanCheckResult) => void = () => {};
  const check = createCodexPlanProfileChecker(() => {
    runs += 1;
    return new Promise<PlanCheckResult>((resolve) => { finish = resolve; });
  });
  const first = check();
  const second = check();
  finish({ outcome: 'honoured', detail: '' });
  assert.deepEqual((await Promise.all([first, second])).map((result) => result.outcome), ['honoured', 'honoured']);
  assert.equal(runs, 1);
});

test('a sandbox run that fails still hands back what it printed', async () => {
  const output = await runInCodexSandbox({ k: 'v' }, 'true', os.tmpdir(), async () => {
    throw Object.assign(new Error('Command failed'), { stdout: 'PLAN_CHECK 0 yes\n', stderr: 'bwrap: No permissions to create a new namespace\n' });
  });
  assert.deepEqual(output, { stdout: 'PLAN_CHECK 0 yes\n', stderr: 'bwrap: No permissions to create a new namespace\n' });
  const bare = await runInCodexSandbox({ k: 'v' }, 'true', os.tmpdir(), async () => { throw new Error('spawn ENOENT'); });
  assert.deepEqual(bare, { stdout: '', stderr: 'spawn ENOENT' });
});

test('a Plan check that cannot even set up answers unknown', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const result = await runPlanProfileCheck(path.join(os.tmpdir(), 'no-such-folder', 'deeper'));
  assert.equal(result.outcome, 'unknown');
  assert.match(result.detail, /ENOENT/);
});

test('the Plan check layout puts the chat in $HOME next to a key folder, the workspaces outside', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'plan-check-layout-'));
  try {
    const layout = await preparePlanCheckLayout(base);
    assert.ok(layout.cwd.startsWith(`${layout.paths.home}${path.sep}`));
    assert.ok(!layout.paths.workspacesRoot.startsWith(layout.paths.home));
    assert.ok((await readdir(layout.paths.home)).includes('.ssh'));
    const names = layout.expectations.map(({ name }) => name);
    for (const name of ['chat file', 'workspace file', 'key folder', 'chat .env', 'workspace .env', 'late Codex history', 'write chat folder']) {
      assert.ok(names.includes(name), `the check probes ${name}`);
    }
    const filesystem = (layout.config as { permissions: Record<string, { filesystem: Record<string, string> }> })
      .permissions[CODEX_PLAN_PROFILE].filesystem;
    assert.equal(filesystem[path.join(layout.paths.home, '.ssh')], 'deny');
    assert.equal(filesystem[path.join(layout.paths.home, 'code')], undefined, 'the folder holding the chat is open');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('Plan is refused, with the reason, until the profile check passes', async (t) => {
  for (const outcome of ['ignored', 'no-sandbox', 'unknown'] as PlanCheckOutcome[]) {
    const check = t.mock.method(codexPlanSandbox, 'check', async () => ({ outcome, detail: 'probe detail' }));
    await assert.rejects(resolveCodexPlanPermissions(os.tmpdir()), (error: Error & { code?: string }) => {
      assert.equal(error.code, 'CODEX_PLAN_SANDBOX_UNAVAILABLE');
      assert.match(error.message, /^Plan is unavailable: .*\(probe detail\)$/);
      return true;
    }, `${outcome} refuses Plan instead of falling back to the read-only sandbox`);
    check.mock.restore();
  }
  t.mock.method(codexPlanSandbox, 'check', async () => ({ outcome: 'honoured', detail: '' }));
  const permissions = await resolveCodexPlanPermissions(os.tmpdir());
  assert.equal(permissions.sandboxMode, undefined);
  assert.equal(permissions.approvalPolicy, 'never');
  assert.equal((permissions.config as { default_permissions?: string }).default_permissions, CODEX_PLAN_PROFILE);
});
