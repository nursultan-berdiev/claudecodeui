import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { companyDb, resourceAccessDb, sessionsDb } from '@/modules/database/index.js';
import type { ManagedSkillRecord, ProviderSkill } from '@/shared/types.js';
import { AppError, getAccessActor, readProviderSkillMarkdownDefinitionFromContent } from '@/shared/utils.js';
import { validateResourceSharing } from './company.service.js';

function validateFiles(value: unknown): ManagedSkillRecord['files'] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 500) throw new AppError('Invalid skill files', { code: 'INVALID_SKILL_FILES', statusCode: 400 });
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
  if (bytes > 30 * 1024 * 1024) throw new AppError('Skill files exceed 30MB', { code: 'SKILL_TOO_LARGE', statusCode: 400 });
  return files;
}

function requireSkill(id: string, manage = false): ManagedSkillRecord {
  const row = companyDb.skillRow(id);
  if (!row || !companyDb.canReadSkill(row)) throw new AppError('Skill not found', { code: 'SKILL_NOT_FOUND', statusCode: 404 });
  const skill = companyDb.skillView(row);
  if (manage && !skill.canManage) throw new AppError('Only the owner or administrator can edit this skill', { code: 'SKILL_OWNER_REQUIRED', statusCode: 403 });
  return skill;
}

/** Used by the company UI, provider command discovery and runtime dispatcher for a single managed library. */
export const companySkillsService = {
  list(provider?: string) { return companyDb.skills(provider); },
  get(id: string) { return requireSkill(id); },
  save(input: Record<string, unknown>, id?: string): ManagedSkillRecord {
    const actor = getAccessActor();
    if (!actor) throw new AppError('Authentication required', { code: 'AUTH_REQUIRED', statusCode: 401 });
    const previous = id ? requireSkill(id, true) : null;
    const content = typeof input.content === 'string' ? input.content.trim() : '';
    if (!content || Buffer.byteLength(content) > 1024 * 1024) throw new AppError('Skill markdown is required and must be below 1MB', { code: 'INVALID_SKILL_CONTENT', statusCode: 400 });
    const definition = readProviderSkillMarkdownDefinitionFromContent(content, 'new-skill');
    if (!/^[\p{L}\p{N}_.-]{1,100}$/u.test(definition.name)) throw new AppError('Use letters, digits, dots or hyphens in the skill name', { code: 'INVALID_SKILL_NAME', statusCode: 400 });
    const provider = typeof input.provider === 'string' ? input.provider : previous?.provider ?? 'all';
    if (!['all', 'claude', 'codex', 'cursor', 'opencode'].includes(provider)) throw new AppError('Invalid provider', { code: 'INVALID_PROVIDER', statusCode: 400 });
    const sharing = validateResourceSharing({ visibility: input.visibility ?? previous?.visibility ?? 'private', departmentIds: input.departmentIds ?? previous?.departmentIds });
    const skillId = id ?? randomUUID();
    if (companyDb.skillNameTaken(previous?.ownerUserId ?? actor.id, definition.name, provider, skillId)) {
      throw new AppError('You already have a skill with this name for this agent', { code: 'SKILL_NAME_EXISTS', statusCode: 409 });
    }
    companyDb.saveSkill({ id: skillId, ownerUserId: previous?.ownerUserId ?? actor.id, name: definition.name,
      description: definition.description, provider, content, files: input.files === undefined ? previous?.files ?? [] : validateFiles(input.files), ...sharing });
    return requireSkill(skillId);
  },
  remove(id: string) { requireSkill(id, true); companyDb.deleteSkill(id); return { success: true }; },

  async importDiscovered(provider: string, skills: ProviderSkill[]): Promise<void> {
    const ownerUserId = resourceAccessDb.defaultOwnerId();
    if (!ownerUserId) return;
    for (const skill of skills) {
      const sourcePath = `${provider}:${skill.sourcePath}`;
      if (companyDb.hasImportedSource(sourcePath)) continue;
      try {
        const content = await readFile(skill.sourcePath, 'utf8');
        const files: ManagedSkillRecord['files'] = [];
        let bytes = 0;
        const root = path.dirname(skill.sourcePath);
        // Legacy command markdown shares a directory with other commands; only SKILL.md owns supporting files.
        if (path.basename(skill.sourcePath).toLowerCase() === 'skill.md') {
          const walk = async (directory: string) => {
            for (const entry of await readdir(directory, { withFileTypes: true })) {
              if (entry.isSymbolicLink() || ['.git', 'node_modules'].includes(entry.name)) continue;
              const full = path.join(directory, entry.name);
              if (entry.isDirectory()) await walk(full);
              else if (entry.isFile() && full !== skill.sourcePath) {
                const buffer = await readFile(full);
                bytes += buffer.length;
                if (files.length >= 500 || bytes > 30 * 1024 * 1024) throw new Error('Skill import limit exceeded');
                files.push({ relativePath: path.relative(root, full).split(path.sep).join('/'), content: buffer.toString('base64'), encoding: 'base64' });
              }
            }
          };
          await walk(root);
        }
        companyDb.saveSkill({ id: randomUUID(), ownerUserId, name: skill.name, description: skill.description,
          provider, content, files, visibility: 'company', departmentIds: [], sourcePath });
      } catch (error) { console.warn('Could not import a discovered skill', skill.name, error instanceof Error ? error.message : String(error)); }
    }
  },

  providerSkills(provider: string): ProviderSkill[] {
    return this.list(provider).sort((left, right) => Number(right.ownerUserId === getAccessActor()?.id) - Number(left.ownerUserId === getAccessActor()?.id)).map((skill) => ({ provider: provider as ProviderSkill['provider'], name: skill.name,
      description: skill.description, command: `${provider === 'codex' ? '$' : '/'}${skill.name}`, scope: 'user', sourcePath: `library/${skill.id}/SKILL.md` }));
  },

  async preparePrompt(provider: string, command: string, sessionId: string): Promise<string> {
    const actor = getAccessActor();
    if (!actor) return command;
    const ownDepartments = companyDb.ownDepartmentIds(actor.id);
    const available = this.list(provider).filter((skill) => skill.ownerUserId === actor.id || skill.visibility === 'company'
      || (skill.visibility === 'departments' && skill.departmentIds.some((id) => ownDepartments.includes(id))));
    const chat = sessionsDb.getSessionById(sessionId);
    const sharing = chat ? resourceAccessDb.sessionSharing(sessionId) : null;
    const skills = available.filter((skill) => !sharing || sharing.visibility === 'private'
      || skill.visibility === 'company'
      || (sharing.visibility === 'departments' && skill.visibility === 'departments'
        && sharing.departmentIds.every((id) => skill.departmentIds.includes(id))))
      .sort((left, right) => Number(right.ownerUserId === actor.id) - Number(left.ownerUserId === actor.id));
    const requested = command.match(/^\s*[/$]([\p{L}\p{N}_.-]+)(?:\s|$)/u)?.[1];
    if (requested && available.some((skill) => skill.name === requested) && !skills.some((skill) => skill.name === requested)) {
      throw new AppError('Share this skill with the chat audience before using it in a shared chat', { code: 'SKILL_AUDIENCE_MISMATCH', statusCode: 403 });
    }
    if (!skills.length) return command;
    const root = path.join(os.homedir(), '.cloudcli', 'session-skills', String(getAccessActor()?.id), sessionId.replace(/[^a-zA-Z0-9_.-]/g, '_'));
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true });
    const names = new Set<string>();
    const catalog: string[] = [];
    for (const skill of skills) {
      if (names.has(skill.name)) continue;
      names.add(skill.name);
      const skillRoot = path.join(root, skill.id);
      await mkdir(skillRoot, { recursive: true });
      await writeFile(path.join(skillRoot, 'SKILL.md'), skill.content);
      for (const file of skill.files) {
        const full = path.join(skillRoot, file.relativePath);
        await mkdir(path.dirname(full), { recursive: true });
        await writeFile(full, file.encoding === 'base64' ? Buffer.from(file.content, 'base64') : file.content);
      }
      catalog.push(`- ${skill.name}: ${skill.description}\n  Definition: ${path.join(skillRoot, 'SKILL.md')}`);
    }
    const selected = requested ? skills.find((skill) => skill.name === requested) : null;
    return `<available_skills>\nUse these authorized skill definitions when relevant.\n${catalog.join('\n')}\n</available_skills>\n${selected ? `<requested_skill>\n${selected.content}\n</requested_skill>\n` : ''}${command}`;
  },
};
