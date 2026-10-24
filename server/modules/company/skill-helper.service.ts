import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { query } from '@anthropic-ai/claude-agent-sdk';

import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';
import type { ProviderAuthStatus } from '@/shared/types.js';
import { AppError, requireAccessActor } from '@/shared/utils.js';

import { companySkillsService } from './skills-library.service.js';

type HelperProvider = 'claude' | 'codex';
type HelperInput = { provider: HelperProvider; mode: 'draft' | 'improve'; request: string; current: string };
type SkillHelperDraft = { name: string; description: string; category: string; examplePrompt: string; body: string };
type RunAgent = (provider: HelperProvider, prompt: string, workingDirectory: string, signal: AbortSignal) => Promise<unknown>;

const DRAFT_SCHEMA = {
  type: 'object',
  properties: Object.fromEntries(['name', 'description', 'category', 'examplePrompt', 'body'].map((key) => [key, { type: 'string' }])),
  required: ['name', 'description', 'category', 'examplePrompt', 'body'],
  additionalProperties: false,
};
const CLAUDE_TIMEOUT_MS = 120_000;
const CODEX_TIMEOUT_MS = 180_000;
// Every run spends the shared agent subscription, so the server keeps at most two in flight and one per employee.
const MAX_CONCURRENT_RUNS = 2;
const runningUsers = new Set<number>();
// Named one by one so a future server variable with an agent-like prefix is never handed to the agent.
const AGENT_ENVIRONMENT = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TMPDIR', 'TZ',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'DISABLE_AUTOUPDATER',
  'ENABLE_CLAUDEAI_MCP_SERVERS', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_HOME']);
// Without these Codex cannot run commands, read files, browse or call MCP/app tools: a drafted prompt has nothing to exfiltrate.
// All are known to the pinned @openai/codex 0.156; an unknown feature name would stop `codex exec` from starting.
const CODEX_DISABLED_FEATURES = ['shell_tool', 'unified_exec', 'apps', 'plugins', 'browser_use', 'computer_use', 'image_generation'];
const INSTRUCTIONS = `You write Agent Skills (SKILL.md) for employees of a company. Reply only with the requested JSON object.
- name: a short kebab-case identifier using latin letters, digits and hyphens.
- description: one or two sentences in the third person saying what the skill does and when to use it; agents decide from it when to apply the skill.
- category: one short category; reuse an existing category when one fits.
- examplePrompt: a realistic first message an employee would send when using the skill.
- body: Markdown instructions without frontmatter: purpose, step-by-step workflow, what to ask the user for, output format, a short example and edge cases. Never include secrets, do not rely on tools that may be unavailable, stay under 300 lines.
Write description, category, examplePrompt and body in the language of the employee's request.`;

function buildPrompt(input: HelperInput, categories: string[]): string {
  return [
    `<existing_categories>${categories.join(', ') || 'none'}</existing_categories>`,
    input.mode === 'improve' ? `Improve this skill so it is clearer and easier to apply while keeping its purpose.\n<current_skill>\n${input.current}\n</current_skill>` : '',
    `<request>\n${input.request || 'Make the skill clearer and easier to follow.'}\n</request>`,
  ].filter(Boolean).join('\n\n');
}

function agentEnvironment(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => AGENT_ENVIRONMENT.has(entry[0]) && entry[1] !== undefined));
}

function parseJsonObject(text: string): unknown {
  try { return JSON.parse(text); } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) { try { return JSON.parse(text.slice(start, end + 1)); } catch { /* reported below */ } }
    throw new AppError('The agent did not return a skill draft', { code: 'HELPER_FAILED', statusCode: 502 });
  }
}

function sanitizeDraft(raw: unknown): SkillHelperDraft {
  const data = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const text = (value: unknown, maxLength: number) => typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
  const body = text(data.body, 100_000);
  if (!body) throw new AppError('The agent returned an empty draft', { code: 'HELPER_FAILED', statusCode: 502 });
  const name = text(data.name, 200).toLowerCase().replace(/[\s_]+/g, '-').replace(/[^\p{L}\p{N}.-]/gu, '')
    .replace(/-+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 64);
  return { name: name || 'new-skill', description: text(data.description, 1024), category: text(data.category, 50), examplePrompt: text(data.examplePrompt, 2000), body };
}

/** Claude without tools, MCP or settings; persistSession:false keeps the run out of ~/.claude/projects and the sidebar. */
async function runClaude(prompt: string, workingDirectory: string, signal: AbortSignal): Promise<unknown> {
  const abortController = new AbortController();
  let timedOut = false;
  const abort = () => abortController.abort();
  const timer = setTimeout(() => { timedOut = true; abort(); }, CLAUDE_TIMEOUT_MS);
  signal.addEventListener('abort', abort, { once: true });
  const executable = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);
  try {
    for await (const message of query({ prompt, options: {
      cwd: workingDirectory, abortController, persistSession: false, tools: [], settingSources: [], mcpServers: {}, strictMcpConfig: true,
      maxTurns: 3, systemPrompt: INSTRUCTIONS, outputFormat: { type: 'json_schema', schema: DRAFT_SCHEMA }, env: agentEnvironment(),
      ...executable ? { pathToClaudeCodeExecutable: executable } : {},
    } })) {
      if (message.type !== 'result') continue;
      if (message.subtype === 'success' && !message.is_error) return message.structured_output ?? parseJsonObject(message.result);
      const reason = message.subtype === 'success' ? message.result : message.errors.join('; ');
      throw new AppError(`Claude could not draft the skill: ${reason}`, { code: 'HELPER_FAILED', statusCode: 502 });
    }
    throw new AppError('Claude ended without a draft', { code: 'HELPER_FAILED', statusCode: 502 });
  } catch (error) {
    if (timedOut) throw new AppError('The helper took too long, try a shorter request', { code: 'HELPER_TIMEOUT', statusCode: 504 });
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

/** `codex exec --ephemeral` writes no rollout under ~/.codex/sessions, so no stray chat appears. */
async function runCodex(prompt: string, workingDirectory: string, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) throw new AppError('The helper was cancelled', { code: 'HELPER_CANCELLED', statusCode: 499 });
  const launcher = createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js');
  const schemaFile = path.join(workingDirectory, 'schema.json');
  const outputFile = path.join(workingDirectory, 'draft.json');
  await writeFile(schemaFile, JSON.stringify(DRAFT_SCHEMA));
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [launcher, 'exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only',
      ...CODEX_DISABLED_FEATURES.flatMap((feature) => ['--disable', feature]), '-c', 'mcp_servers={}',
      '--cd', workingDirectory, '--output-schema', schemaFile, '--output-last-message', outputFile, '-'], { cwd: workingDirectory, env: agentEnvironment(), stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    let timedOut = false;
    const kill = () => child.kill('SIGTERM');
    const timer = setTimeout(() => { timedOut = true; kill(); }, CODEX_TIMEOUT_MS);
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', kill); };
    signal.addEventListener('abort', kill, { once: true });
    child.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-2000); });
    child.on('error', (error) => { cleanup(); reject(error); });
    child.on('close', (code) => {
      cleanup();
      if (code === 0) resolve();
      else if (timedOut) reject(new AppError('The helper took too long, try a shorter request', { code: 'HELPER_TIMEOUT', statusCode: 504 }));
      else reject(new AppError(`Codex could not draft the skill: ${stderr.trim().split('\n').at(-1) ?? `exit ${code}`}`, { code: 'HELPER_FAILED', statusCode: 502 }));
    });
    child.stdin.end(`${INSTRUCTIONS}\n\n${prompt}`);
  });
  return parseJsonObject(await readFile(outputFile, 'utf8'));
}

const runAgent: RunAgent = (provider, prompt, workingDirectory, signal) => provider === 'claude'
  ? runClaude(prompt, workingDirectory, signal) : runCodex(prompt, workingDirectory, signal);

/** Used by company routes to draft or improve a skill through the agent login the chat already uses; it never saves. */
export const skillHelperService = {
  async draft(input: HelperInput, deps: { authStatus(provider: string): Promise<ProviderAuthStatus>; signal?: AbortSignal; runAgent?: RunAgent }): Promise<SkillHelperDraft> {
    const actor = requireAccessActor();
    const status = await deps.authStatus(input.provider).catch(() => null);
    if (!status?.installed || !status.authenticated) {
      throw new AppError(`Sign in to ${input.provider === 'claude' ? 'Claude' : 'Codex'} before using the helper`, { code: 'HELPER_PROVIDER_UNAVAILABLE', statusCode: 409 });
    }
    if (runningUsers.has(actor.id) || runningUsers.size >= MAX_CONCURRENT_RUNS) {
      throw new AppError('The helper is busy, try again in a minute', { code: 'HELPER_BUSY', statusCode: 429 });
    }
    runningUsers.add(actor.id);
    let workingDirectory: string | null = null;
    try {
      workingDirectory = await mkdtemp(path.join(os.tmpdir(), 'cloudcli-skill-helper-'));
      const prompt = buildPrompt(input, companySkillsService.list().categories);
      return sanitizeDraft(await (deps.runAgent ?? runAgent)(input.provider, prompt, workingDirectory, deps.signal ?? new AbortController().signal));
    } finally {
      runningUsers.delete(actor.id);
      if (workingDirectory) await rm(workingDirectory, { recursive: true, force: true });
    }
  },
};
