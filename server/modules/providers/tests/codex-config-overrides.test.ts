import assert from 'node:assert/strict';
import test from 'node:test';

import { toCodexConfigOverrides } from '@/modules/providers/list/codex/codex-config-overrides.js';

test('Codex config overrides keep file paths whole and reject values TOML cannot hold', () => {
  assert.deepEqual(
    toCodexConfigOverrides({ permissions: { p: { filesystem: { '/home/n/.codex/auth.json': 'deny', '/w/**/.env*': 'deny' }, network: { enabled: true } } }, default_permissions: 'p' }),
    ['permissions={"p" = {"filesystem" = {"/home/n/.codex/auth.json" = "deny", "/w/**/.env*" = "deny"}, "network" = {"enabled" = true}}}', 'default_permissions="p"'],
  );
  assert.deepEqual(toCodexConfigOverrides({ k: { 'a "quoted" \\ path': 'v' } }), ['k={"a \\"quoted\\" \\\\ path" = "v"}']);
  for (const bad of [null, undefined, 10n, Number.NaN]) {
    assert.throws(() => toCodexConfigOverrides({ k: { x: bad as never } }), TypeError);
  }
});
