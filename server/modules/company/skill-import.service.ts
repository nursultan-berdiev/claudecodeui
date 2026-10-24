import { readFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { companyDb } from '@/modules/database/index.js';
import type { ManagedSkillRecord, ProviderSkill } from '@/shared/types.js';
import { AppError, MANAGED_SKILL_LIMITS, readProviderSkillMarkdownDefinitionFromContent, requireAccessActor } from '@/shared/utils.js';

import { codexCatalogService } from './codex-catalog.service.js';
import { companySkillsService } from './skills-library.service.js';

type DiscoverSkills = (provider: string) => Promise<ProviderSkill[]>;
type SkillFolder = { content: string; files: ManagedSkillRecord['files'] };
type ImportCandidate = { key: string; name: string; description: string; scope: string; pluginName?: string; read(): Promise<SkillFolder> };

const LOCAL_PROVIDERS = ['claude', 'codex', 'cursor', 'opencode'];
// Project and repo scopes would be the server's own working directory, not something an agent offers the user.
const IMPORTABLE_SCOPES = new Set(['user', 'plugin', 'admin', 'system']);

/**
 * Reads SKILL.md with its sibling files as an agent sees them, skipping nested symlinks and VCS or dependency folders.
 * The skill folder itself may be a symlink (~/.claude/skills/x -> a shared repo); sizes are checked before anything is read.
 */
async function readSkillFolder(skillPath: string): Promise<SkillFolder> {
  const tooLarge = () => new AppError('Skill markdown must be below 1MB', { code: 'INVALID_SKILL_CONTENT', statusCode: 400 });
  const definition = await stat(skillPath);
  if (!definition.isFile()) throw new AppError('SKILL.md is not a file', { code: 'INVALID_SKILL_CONTENT', statusCode: 400 });
  if (definition.size > MANAGED_SKILL_LIMITS.markdownBytes) throw tooLarge();
  const content = await readFile(skillPath, 'utf8');
  // The file can grow between stat and read, so the limit is checked again on what was actually read.
  if (Buffer.byteLength(content) > MANAGED_SKILL_LIMITS.markdownBytes) throw tooLarge();
  const root = path.dirname(skillPath);
  const files: SkillFolder['files'] = [];
  let bytes = 0;
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || ['.git', 'node_modules'].includes(entry.name)) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && full !== skillPath) {
        const limitExceeded = () => new AppError('Skill import limit exceeded', { code: 'SKILL_TOO_LARGE', statusCode: 400 });
        if (files.length >= MANAGED_SKILL_LIMITS.files || bytes + (await stat(full)).size > MANAGED_SKILL_LIMITS.fileBytes) throw limitExceeded();
        const buffer = await readFile(full);
        bytes += buffer.length;
        if (bytes > MANAGED_SKILL_LIMITS.fileBytes) throw limitExceeded();
        files.push({ relativePath: path.relative(root, full).split(path.sep).join('/'), content: buffer.toString('base64'), encoding: 'base64' });
      }
    }
  };
  await walk(root);
  return { content, files };
}

/** Claude Code tolerates frontmatter js-yaml rejects, such as an unquoted description containing ": "; quoting plain top-level values repairs it. */
function withReadableFrontmatter(content: string): string {
  try { readProviderSkillMarkdownDefinitionFromContent(content, 'skill'); return content; } catch {
    const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
    if (frontmatter === undefined) return content;
    const quoted = frontmatter.split(/\r?\n/).map((line) => {
      const pair = line.match(/^([A-Za-z_][\w-]*):[ \t]+(\S.*)$/);
      return pair && !/^["'|>[{&*!]/.test(pair[2]) ? `${pair[1]}: ${JSON.stringify(pair[2].trim())}` : line;
    }).join('\n');
    return content.replace(frontmatter, () => quoted);
  }
}

/** Name and description for a listing; a skill whose frontmatter cannot be read is listed by folder name and reported on import. */
function describeSkill(content: string, fallbackName: string): { name: string; description: string } {
  try { return readProviderSkillMarkdownDefinitionFromContent(withReadableFrontmatter(content), fallbackName); }
  catch { return { name: fallbackName, description: '' }; }
}

/** The same SKILL.md discovered through two agents (e.g. ~/.claude/skills via OpenCode) counts as one source. */
function sourceIdentity(key: string): string {
  return key.replace(/^(claude|codex|cursor|opencode):/, '');
}

async function localCandidates(discover: DiscoverSkills): Promise<{ id: string; items: ImportCandidate[]; error?: string }[]> {
  const seen = new Set<string>();
  const groups: { id: string; items: ImportCandidate[]; error?: string }[] = [];
  for (const provider of LOCAL_PROVIDERS) {
    try {
      const items = (await discover(provider))
        .filter((skill) => IMPORTABLE_SCOPES.has(skill.scope) && path.basename(skill.sourcePath).toLowerCase() === 'skill.md' && !seen.has(skill.sourcePath))
        .map((skill) => {
          seen.add(skill.sourcePath);
          return { key: `${provider}:${skill.sourcePath}`, name: skill.name, description: skill.description, scope: skill.scope,
            pluginName: skill.pluginName, read: () => readSkillFolder(skill.sourcePath) };
        });
      groups.push({ id: provider, items });
    } catch (error) {
      groups.push({ id: provider, items: [], error: error instanceof Error ? error.message : String(error) });
    }
  }
  return groups;
}

/** Skills of the signed-in claude.ai account, which Claude Code downloads into ~/.claude/skills/synced/<bucket>/<skill>. */
async function syncedCandidates(): Promise<ImportCandidate[]> {
  const root = path.join(os.homedir(), '.claude', 'skills', 'synced');
  const candidates = new Map<string, ImportCandidate>();
  const buckets = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const bucket of buckets.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))) {
    for (const entry of await readdir(path.join(root, bucket.name), { withFileTypes: true })) {
      if (!entry.isDirectory() || candidates.has(entry.name)) continue;
      const skillPath = path.join(root, bucket.name, entry.name, 'SKILL.md');
      const content = await readFile(skillPath, 'utf8').catch(() => null);
      if (content === null) continue;
      const definition = describeSkill(content, entry.name);
      candidates.set(entry.name, { key: `claude-synced:${entry.name}`, name: definition.name, description: definition.description,
        scope: 'claude.ai', read: () => readSkillFolder(skillPath) });
    }
  }
  return [...candidates.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function curatedCandidate(skill: { name: string; description: string }): ImportCandidate {
  return { key: `codex-curated:${skill.name}`, name: skill.name, description: skill.description, scope: 'curated', read: () => codexCatalogService.read(skill.name) };
}

function flagged(candidates: ImportCandidate[], userId: number) {
  const origins = companyDb.skillOrigins(userId);
  const own = new Set(origins.own.map(sourceIdentity));
  const readable = new Set(origins.readable.map(sourceIdentity));
  return candidates.map(({ read: _read, ...item }) => ({ ...item, alreadyImported: own.has(sourceIdentity(item.key)), inLibrary: readable.has(sourceIdentity(item.key)) }));
}

/** Used by company routes to show the skills connected agents see and copy the selected ones into the caller's library. */
export const skillImportService = {
  async listSources(discover: DiscoverSkills) {
    const actor = requireAccessActor();
    const groups = await localCandidates(discover);
    groups.splice(1, 0, { id: 'claude-synced', items: await syncedCandidates() });
    return { sources: groups.map((group) => ({ id: group.id, items: flagged(group.items, actor.id), ...group.error ? { error: group.error } : {} })) };
  },
  async listCurated() {
    const actor = requireAccessActor();
    return { items: flagged((await codexCatalogService.list()).map(curatedCandidate), actor.id) };
  },
  /** Keys are resolved against fresh discovery, so a request can never point the server at an arbitrary path or URL. */
  async importSelected(keys: string[], discover: DiscoverSkills) {
    const actor = requireAccessActor();
    const candidates = new Map<string, ImportCandidate>();
    if (keys.some((key) => LOCAL_PROVIDERS.some((provider) => key.startsWith(`${provider}:`)))) {
      for (const group of await localCandidates(discover)) for (const item of group.items) candidates.set(item.key, item);
    }
    if (keys.some((key) => key.startsWith('claude-synced:'))) for (const item of await syncedCandidates()) candidates.set(item.key, item);
    // Catalog keys resolve on read, so a GitHub outage is reported per skill as CURATED_UNAVAILABLE.
    for (const key of keys.filter((item) => /^codex-curated:[\w.-]+$/.test(item))) {
      candidates.set(key, curatedCandidate({ name: key.slice('codex-curated:'.length), description: '' }));
    }
    const own = new Set(companyDb.skillOrigins(actor.id).own.map(sourceIdentity));
    const imported: { id: string; name: string }[] = [];
    const skipped: { key: string; code: string }[] = [];
    for (const key of new Set(keys)) {
      const candidate = candidates.get(key);
      if (!candidate) { skipped.push({ key, code: 'IMPORT_SOURCE_NOT_FOUND' }); continue; }
      if (own.has(sourceIdentity(key))) { skipped.push({ key, code: 'ALREADY_IMPORTED' }); continue; }
      try {
        const folder = await candidate.read();
        const skill = companySkillsService.save({ ...folder, content: withReadableFrontmatter(folder.content), visibility: 'private', provider: 'all' }, undefined, key);
        own.add(sourceIdentity(key));
        imported.push({ id: skill.id, name: skill.name });
      } catch (error) {
        skipped.push({ key, code: error instanceof AppError && error.code ? error.code : 'IMPORT_FAILED' });
      }
    }
    return { imported, skipped };
  },
};
