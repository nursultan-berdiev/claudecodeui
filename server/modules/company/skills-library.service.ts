import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { companyDb, resourceAccessDb, sessionsDb, userDb } from '@/modules/database/index.js';
import type { ManagedSkillRecord, ManagedSkillSummary, ProviderSkill, SkillVisibility } from '@/shared/types.js';
import { AppError, getAccessActor, MANAGED_SKILL_LIMITS, readProviderSkillMarkdownDefinitionFromContent, requireAccessActor } from '@/shared/utils.js';

import { validateResourceSharing } from './company.service.js';
import { skillExportService } from './skill-export.service.js';

const SKILL_PROVIDERS = ['all', 'claude', 'codex', 'cursor', 'opencode'];
const MAX_REQUESTED_SKILLS = 5;

function validateFiles(value: unknown): ManagedSkillRecord['files'] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MANAGED_SKILL_LIMITS.files) throw new AppError('Invalid skill files', { code: 'INVALID_SKILL_FILES', statusCode: 400 });
  const seen = new Set<string>();
  let bytes = 0;
  const files = value.map((entry) => {
    const item = entry as Record<string, unknown>;
    const relativePath = typeof item?.relativePath === 'string' ? item.relativePath.replace(/\\/g, '/') : '';
    const content = typeof item?.content === 'string' ? item.content : '';
    const encoding = item?.encoding === 'base64' ? 'base64' as const : 'utf8' as const;
    if (!relativePath || /[\x00-\x1f]/.test(relativePath) || path.isAbsolute(relativePath) || relativePath.split('/').some((part) => !part || part === '.' || part === '..')
      || relativePath.toLowerCase() === 'skill.md' || seen.has(relativePath)) throw new AppError('Invalid supporting file path', { code: 'INVALID_SKILL_PATH', statusCode: 400 });
    seen.add(relativePath);
    bytes += Buffer.byteLength(content, encoding);
    return { relativePath, content, encoding };
  });
  if (bytes > MANAGED_SKILL_LIMITS.fileBytes) throw new AppError('Skill files exceed 30MB', { code: 'SKILL_TOO_LARGE', statusCode: 400 });
  // `a` next to `a/b`, or `A` next to `a` on a case-insensitive disk, cannot both be written when the skill is exported.
  const lowered = files.map((file) => file.relativePath.toLowerCase());
  if (new Set(lowered).size !== lowered.length || lowered.some((file) => lowered.some((other) => other.startsWith(`${file}/`)))) {
    throw new AppError('A supporting file clashes with another file or folder of the same name', { code: 'INVALID_SKILL_PATH', statusCode: 400 });
  }
  return files;
}

function optionalText(value: unknown, fallback: string, maxLength: number, field: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.trim().length > maxLength) throw new AppError(`Invalid ${field}`, { code: 'INVALID_SKILL_FIELD', statusCode: 400 });
  return value.trim();
}

function requireSkill(id: string, manage = false): ManagedSkillRecord {
  const skill = companyDb.skill(id);
  if (!skill) throw new AppError('Skill not found', { code: 'SKILL_NOT_FOUND', statusCode: 404 });
  if (manage && !skill.canManage) throw new AppError('Only the owner or administrator can edit this skill', { code: 'SKILL_OWNER_REQUIRED', statusCode: 403 });
  return skill;
}

/** Selected people must be active colleagues; departments follow chat rules; only an administrator publishes company-wide. */
function validateSkillSharing(input: Record<string, unknown>, previous: ManagedSkillRecord | null, ownerUserId: number) {
  const actor = requireAccessActor();
  const visibility = input.visibility ?? previous?.visibility ?? 'private';
  if (visibility === 'users') {
    const userIds = Array.isArray(input.userIds) ? [...new Set(input.userIds.map(Number))] : previous?.userIds ?? [];
    const active = userDb.listUsers().filter((user) => user.is_active === 1).map((user) => Number(user.id));
    if (!userIds.length || userIds.length > 200 || userIds.some((id) => id === ownerUserId || !active.includes(id))) {
      throw new AppError('Select active colleagues to share with', { code: 'INVALID_SKILL_USERS', statusCode: 400 });
    }
    return { visibility: 'users' as SkillVisibility, departmentIds: [], userIds };
  }
  if (visibility === 'company' && actor.role !== 'admin' && previous?.visibility !== 'company') {
    throw new AppError('Only an administrator can publish a skill to the whole company', { code: 'SKILL_COMPANY_ADMIN_ONLY', statusCode: 403 });
  }
  const sharing = validateResourceSharing({ visibility, departmentIds: input.departmentIds ?? previous?.departmentIds }, true);
  return { ...sharing, visibility: sharing.visibility as SkillVisibility, userIds: [] };
}

/** Escapes generated-context closing tags so withoutGeneratedSkillContext always strips exactly what was added. */
function escapeSkillContext(value: string): string {
  return value.replace(/<\/(requested_skill|available_skills)>/g, '<\\/$1>');
}

/** Composer ids (an unreadable one is skipped, so a revoked pinned skill does not block the chat) plus a leading /name or $name. */
function pickRequestedSkills(available: ManagedSkillSummary[], command: string, requestedIds: unknown, actorId: number): ManagedSkillSummary[] {
  const ids = Array.isArray(requestedIds) ? [...new Set(requestedIds.filter((id): id is string => typeof id === 'string'))].slice(0, MAX_REQUESTED_SKILLS) : [];
  const requested = ids.map((id) => available.find((skill) => skill.id === id)).filter((skill): skill is ManagedSkillSummary => Boolean(skill));
  const requestedName = command.match(/^\s*[/$]([\p{L}\p{N}_.-]+)(?:\s|$)/u)?.[1];
  const named = available.filter((skill) => skill.name === requestedName)
    .sort((left, right) => Number(right.ownerUserId === actorId) - Number(left.ownerUserId === actorId)
      || Number(right.isFavorite) - Number(left.isFavorite) || Number(Boolean(right.lastUsedAt)) - Number(Boolean(left.lastUsedAt)))[0];
  if (named && !requested.some((skill) => skill.name === named.name)) requested.push(named);
  return requested;
}

/** Used by the company UI, provider command discovery and runtime dispatcher for a single managed library. */
export const companySkillsService = {
  list() {
    const skills = companyDb.skillSummaries();
    const categories = [...new Set(skills.map((skill) => skill.category).filter(Boolean))].sort((left, right) => left.localeCompare(right));
    return { skills, categories };
  },
  get(id: string) { return requireSkill(id); },
  /** Creates or edits a skill; `origin` is set only by the import service, never from request bodies. */
  save(input: Record<string, unknown>, id?: string, origin?: string): ManagedSkillRecord {
    const actor = requireAccessActor();
    const previous = id ? requireSkill(id, true) : null;
    const content = typeof input.content === 'string' ? input.content.trim() : previous?.content ?? '';
    if (!content || Buffer.byteLength(content) > MANAGED_SKILL_LIMITS.markdownBytes) throw new AppError('Skill markdown is required and must be below 1MB', { code: 'INVALID_SKILL_CONTENT', statusCode: 400 });
    let definition: { name: string; description: string };
    try { definition = readProviderSkillMarkdownDefinitionFromContent(content, 'new-skill'); }
    catch (error) {
      throw new AppError(`The SKILL.md header is not valid YAML: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`, { code: 'INVALID_SKILL_FRONTMATTER', statusCode: 400 });
    }
    if (!/^[\p{L}\p{N}_.-]{1,100}$/u.test(definition.name)) throw new AppError('Use letters, digits, dots or hyphens in the skill name', { code: 'INVALID_SKILL_NAME', statusCode: 400 });
    const provider = typeof input.provider === 'string' ? input.provider : previous?.provider ?? 'all';
    if (!SKILL_PROVIDERS.includes(provider)) throw new AppError('Invalid provider', { code: 'INVALID_PROVIDER', statusCode: 400 });
    const ownerUserId = previous?.ownerUserId ?? actor.id;
    const sharing = validateSkillSharing(input, previous, ownerUserId);
    const skillId = id ?? randomUUID();
    if (previous?.name !== definition.name && companyDb.skillNameTaken(ownerUserId, definition.name, skillId)) {
      throw new AppError('You already have a skill with this name', { code: 'SKILL_NAME_EXISTS', statusCode: 409 });
    }
    companyDb.saveSkill({ id: skillId, ownerUserId, name: definition.name, description: definition.description, provider, content,
      category: optionalText(input.category, previous?.category ?? '', 50, 'category'),
      examplePrompt: optionalText(input.examplePrompt, previous?.examplePrompt ?? '', 2000, 'example prompt'),
      files: input.files === undefined ? previous?.files ?? [] : validateFiles(input.files), ...sharing, origin }, actor.id);
    return requireSkill(skillId);
  },
  remove(id: string) {
    requireSkill(id, true);
    companyDb.deleteSkill(id);
    void skillExportService.purge(id);
    return { success: true };
  },
  versions(id: string) { requireSkill(id); return companyDb.skillVersions(id); },
  rollback(id: string, version: number): ManagedSkillRecord {
    const actor = requireAccessActor();
    const skill = requireSkill(id, true);
    const snapshot = companyDb.skillVersion(id, version);
    if (!snapshot) throw new AppError('Skill version not found', { code: 'SKILL_VERSION_NOT_FOUND', statusCode: 404 });
    if (snapshot.name !== skill.name && companyDb.skillNameTaken(skill.ownerUserId, snapshot.name, id)) {
      throw new AppError('You already have a skill with this name', { code: 'SKILL_NAME_EXISTS', statusCode: 409 });
    }
    companyDb.saveSkill({ ...snapshot, id, ownerUserId: skill.ownerUserId, visibility: skill.visibility, departmentIds: skill.departmentIds, userIds: skill.userIds }, actor.id, version);
    return requireSkill(id);
  },
  setFavorite(id: string, favorite: boolean) {
    requireSkill(id);
    companyDb.setSkillFavorite(requireAccessActor().id, id, favorite);
    return { favorite };
  },
  /** An administrator publishes any skill shared with them; the owner keeps ownership. */
  publish(id: string): ManagedSkillRecord {
    const actor = requireAccessActor();
    if (actor.role !== 'admin') throw new AppError('Only an administrator can publish a skill to the whole company', { code: 'SKILL_COMPANY_ADMIN_ONLY', statusCode: 403 });
    const skill = requireSkill(id);
    companyDb.saveSkill({ ...skill, visibility: 'company', departmentIds: [], userIds: [] }, actor.id);
    return requireSkill(id);
  },

  /** Commands for the chat `/` menu: favourites first, then own skills, then recently used, then by name. */
  providerSkills(provider: string): ProviderSkill[] {
    const actorId = getAccessActor()?.id;
    const rank = (skill: ManagedSkillSummary) => [Number(!skill.isFavorite), Number(skill.ownerUserId !== actorId), Number(!skill.lastUsedAt)];
    return companyDb.skillSummaries(provider)
      .sort((left, right) => {
        const [a, b] = [rank(left), rank(right)];
        return a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || String(right.lastUsedAt).localeCompare(String(left.lastUsedAt)) || left.name.localeCompare(right.name);
      })
      .map((skill) => ({ provider: provider as ProviderSkill['provider'], name: skill.name, description: skill.description,
        command: `${provider === 'codex' ? '$' : '/'}${skill.name}`, scope: 'user', sourcePath: `library/${skill.id}/SKILL.md` }));
  },

  /**
   * Inlines the requested skills (composer ids or a leading /name) and lists the user's favourites with paths to
   * their exported folders. Shared chats may only use skills their whole audience can read.
   */
  async preparePrompt(provider: string, command: string, sessionId: string, requestedIds?: unknown): Promise<string> {
    const actor = getAccessActor();
    if (!actor) return command;
    const available = companyDb.skillSummaries(provider);
    const sharing = sessionsDb.getSessionById(sessionId) ? resourceAccessDb.sessionSharing(sessionId) : null;
    const audienceAllows = (skill: ManagedSkillSummary) => !sharing || sharing.visibility === 'private' || skill.visibility === 'company'
      || (sharing.visibility === 'departments' && skill.visibility === 'departments' && sharing.departmentIds.every((id) => skill.departmentIds.includes(id)));
    const requested = pickRequestedSkills(available, command, requestedIds, actor.id);
    if (requested.some((skill) => !audienceAllows(skill))) {
      throw new AppError('Share this skill with the chat audience before using it in a shared chat', { code: 'SKILL_AUDIENCE_MISMATCH', statusCode: 403 });
    }
    const names = new Set(requested.map((skill) => skill.name));
    const catalog: ManagedSkillSummary[] = [];
    for (const skill of available.filter((item) => item.isFavorite && audienceAllows(item))
      .sort((left, right) => Number(right.ownerUserId === actor.id) - Number(left.ownerUserId === actor.id))) {
      if (names.has(skill.name)) continue;
      names.add(skill.name);
      catalog.push(skill);
    }
    if (!requested.length && !catalog.length) return command;

    if (requested.length) companyDb.touchSkillRecent(actor.id, requested.map((skill) => skill.id));
    const listed: string[] = [];
    for (const skill of catalog) {
      const directory = await skillExportService.directory(skill.id);
      if (directory) listed.push(`- ${skill.name}: ${escapeSkillContext(skill.description)}\n  Definition: ${path.join(directory, 'SKILL.md')}`);
    }
    const blocks: string[] = [];
    for (const summary of requested) {
      const skill = companyDb.skill(summary.id);
      if (!skill) continue;
      const directory = await skillExportService.directory(skill.id, skill);
      blocks.push(`<requested_skill name="${skill.name}"${directory ? ` dir="${directory}"` : ''}>\n${escapeSkillContext(skill.content)}\n</requested_skill>\n`);
    }
    return `${listed.length ? `<available_skills>\nUse these authorized skill definitions when relevant.\n${listed.join('\n')}\n</available_skills>\n` : ''}${blocks.join('')}${command}`;
  },
};
