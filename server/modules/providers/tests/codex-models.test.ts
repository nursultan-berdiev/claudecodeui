import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CODEX_PREDEFINED_MODELS, readCodexAccountModels } from '@/modules/providers/list/codex/codex-models.provider.js';

const require = createRequire(import.meta.url);

const findCodexModel = (value: string) =>
  CODEX_PREDEFINED_MODELS.OPTIONS.find((option) => option.value === value);

test('lists GPT-6 Sol and GPT-6 Luna with the effort levels the Codex CLI accepts', () => {
  const sol = findCodexModel('gpt-6-sol');
  assert.equal(sol?.label, 'GPT-6 Sol');
  assert.equal(sol?.effort?.default, 'medium');
  assert.deepEqual(
    sol?.effort?.values.map((effort) => effort.value),
    ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  );

  const luna = findCodexModel('gpt-6-luna');
  assert.equal(luna?.label, 'GPT-6 Luna');
  assert.equal(luna?.effort?.default, 'medium');
  assert.deepEqual(
    luna?.effort?.values.map((effort) => effort.value),
    ['low', 'medium', 'high', 'xhigh', 'max'],
  );
});

test('bundles a Codex CLI new enough to know the GPT-6 Sol and Luna models', () => {
  // Codex only ships metadata for gpt-6-sol / gpt-6-luna from 0.155.0 on. An
  // older CLI still sends the request, but on fallback metadata: it warns
  // "Model metadata ... not found" and quietly drops `ultra` to `medium`.
  const { version } = require('@openai/codex/package.json') as { version: string };
  const [major, minor] = version.split('.').map(Number);
  assert.ok(major > 0 || minor >= 155, `bundled @openai/codex ${version} predates 0.155.0`);
});

test('offers only the models the signed-in account lists, keeping the curated default when it is among them', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-models-'));
  const cachePath = path.join(directory, 'models_cache.json');
  const level = (effort: string) => ({ effort });
  await writeFile(cachePath, JSON.stringify({ models: [
    { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', priority: 13, default_reasoning_level: 'medium', supported_reasoning_levels: ['low', 'medium'].map(level) },
    { slug: 'gpt-reserve', visibility: 'hide', priority: 4 },
    { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', visibility: 'list', priority: 5, default_reasoning_level: 'low', supported_reasoning_levels: ['low', 'ultra'].map(level) },
  ] }));
  try {
    const models = await readCodexAccountModels(cachePath);
    assert.deepEqual(models?.OPTIONS.map((option) => option.value), ['gpt-5.6-sol', 'gpt-5.5']);
    assert.equal(models?.DEFAULT, 'gpt-5.6-sol');
    assert.deepEqual(models?.OPTIONS[0].effort, { default: 'low', values: [{ value: 'low' }, { value: 'ultra' }] });
    assert.equal(models?.OPTIONS.some((option) => option.value === 'gpt-5.4'), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('falls back to the curated catalog until the CLI has cached the account models', async () => {
  assert.equal(await readCodexAccountModels(path.join(os.tmpdir(), 'missing-codex-models-cache.json')), null);
});
