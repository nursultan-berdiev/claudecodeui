import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { companyDb } from '@/modules/database/index.js';
import type { ManagedSkillRecord } from '@/shared/types.js';

// A chat may still hold the path of an older version in its history, so a few stay on disk.
const KEPT_VERSIONS = 3;
const STALE_STAGING_MS = 60 * 60 * 1000;

const exportsRoot = () => path.join(os.homedir(), '.cloudcli', 'skill-exports');
const skillRoot = (skillId: string) => path.join(exportsRoot(), skillId);

/** Exports are read-only, so removing one first gives its folders write access back. */
async function removeExport(target: string): Promise<void> {
  const unlock = async (directory: string) => {
    await chmod(directory, 0o700).catch(() => undefined);
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory()) await unlock(path.join(directory, entry.name));
    }
  };
  await unlock(target);
  await rm(target, { recursive: true, force: true });
}

/** Read-only files stop agent file tools from rewriting a skill other people's chats will load next. */
async function lockExport(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) await lockExport(full);
    else await chmod(full, 0o444);
  }
  await chmod(directory, 0o555);
}

/** Best-effort cleanup; a parallel export may remove entries meanwhile, and a failure here never undoes a finished export. */
async function pruneExports(root: string, currentVersion: number): Promise<void> {
  const entries = await readdir(root).catch(() => [] as string[]);
  const older = entries.filter((entry) => /^v\d+$/.test(entry)).map((entry) => Number(entry.slice(1)))
    .filter((version) => version !== currentVersion).sort((left, right) => right - left);
  for (const version of older.slice(KEPT_VERSIONS - 1)) await removeExport(path.join(root, `v${version}`)).catch(() => undefined);
  // Staging folders survive only a crashed export; a running one is far younger than an hour.
  for (const entry of entries.filter((name) => name.startsWith('.staging-'))) {
    const staging = path.join(root, entry);
    const modified = await stat(staging).then((info) => info.mtimeMs).catch(() => null);
    if (modified !== null && Date.now() - modified > STALE_STAGING_MS) await removeExport(staging).catch(() => undefined);
  }
}

async function writeExport(skill: ManagedSkillRecord): Promise<string> {
  const root = skillRoot(skill.id);
  await mkdir(exportsRoot(), { recursive: true });
  await chmod(exportsRoot(), 0o700);
  const directory = path.join(root, `v${skill.version}`);
  const staging = path.join(root, `.staging-${randomUUID()}`);
  let replaced: string | null = null;
  try {
    await mkdir(staging, { recursive: true });
    await writeFile(path.join(staging, 'SKILL.md'), skill.content);
    for (const file of skill.files) {
      const full = path.join(staging, file.relativePath);
      const relative = path.relative(staging, full);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Unsafe supporting file path ${file.relativePath}`);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, file.encoding === 'base64' ? Buffer.from(file.content, 'base64') : file.content);
    }
    await lockExport(staging);
    const onDisk = () => readFile(path.join(directory, 'SKILL.md'), 'utf8').catch(() => null);
    // A parallel message may have finished the same version already; then this copy is simply dropped.
    if (await onDisk() === skill.content) return directory;
    // A changed or half-written copy is moved aside, not deleted first, so the version path never goes missing for long.
    if (await stat(directory).then(() => true, () => false)) {
      replaced = path.join(root, `.staging-${randomUUID()}`);
      await rename(directory, replaced).catch(() => { replaced = null; });
    }
    await rename(staging, directory).catch(async (error) => { if (await onDisk() !== skill.content) throw error; });
  } finally {
    await removeExport(staging);
    if (replaced) await removeExport(replaced).catch(() => undefined);
  }
  await pruneExports(root, skill.version);
  return directory;
}

/** Used by the skills library to give agents a folder with SKILL.md and the attached files of a skill. */
export const skillExportService = {
  /**
   * Folder of the skill's current version under ~/.cloudcli/skill-exports/<id>/v<version>; the id is a server UUID, so nothing
   * from a request reaches the path. SKILL.md is compared with the database on every use and the folder rewritten when it differs.
   * Returns null when the export fails, so one broken skill never blocks a message.
   */
  async directory(skillId: string, record?: ManagedSkillRecord): Promise<string | null> {
    try {
      const head = record ?? companyDb.skillHead(skillId);
      if (!head) return null;
      const directory = path.join(skillRoot(skillId), `v${head.version}`);
      if (await readFile(path.join(directory, 'SKILL.md'), 'utf8').catch(() => null) === head.content) return directory;
      const skill = record ?? companyDb.skill(skillId);
      return skill ? await writeExport(skill) : null;
    } catch (error) {
      console.warn('Could not export a skill for the agent', skillId, error instanceof Error ? error.message : String(error));
      return null;
    }
  },
  /** Removes every exported version of a deleted skill; read-only folders are unlocked first. */
  async purge(skillId: string): Promise<void> {
    await removeExport(skillRoot(skillId)).catch(() => undefined);
  },
};
