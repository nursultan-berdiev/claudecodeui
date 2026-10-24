import { createHash } from 'node:crypto';

import { getConnection } from '@/modules/database/connection.js';
import type { DepartmentRecord, ManagedSkillRecord, ManagedSkillSummary, ManagedSkillVersion, SkillVisibility } from '@/shared/types.js';
import { getAccessActor } from '@/shared/utils.js';

type SkillRow = {
  id: string; owner_user_id: number; name: string; description: string; category: string; example_prompt: string;
  provider: string; version: number; visibility: SkillVisibility; owner_name: string | null; file_count: number;
  created_at: string; updated_at: string;
};
type SkillVersionRow = {
  version: number; name: string; description: string; category: string; example_prompt: string; provider: string;
  content: string; files_hash: string; restored_from: number | null; created_at: string; created_by_name: string | null;
};
type SkillFiles = ManagedSkillRecord['files'];
type SkillSnapshot = { name: string; description: string; category: string; examplePrompt: string; provider: string; content: string; files: SkillFiles };

const MAX_SKILL_VERSIONS = 20;
const MAX_RECENT_SKILLS = 20;
const SKILL_COLUMNS = `s.id, s.owner_user_id, s.name, s.description, s.category, s.example_prompt, s.provider, s.version, s.visibility,
  s.created_at, s.updated_at, u.username AS owner_name, s.file_count`;
// Bound with the actor id four times; a missing actor is a trusted startup/indexing read.
const READABLE_SKILL_SQL = `(? IS NULL OR s.owner_user_id = ? OR s.visibility = 'company'
  OR (s.visibility = 'users' AND EXISTS (SELECT 1 FROM skill_user_shares x WHERE x.skill_id = s.id AND x.user_id = ?))
  OR (s.visibility = 'departments' AND EXISTS (SELECT 1 FROM skill_department_shares d
    JOIN department_members m ON m.department_id = d.department_id WHERE d.skill_id = s.id AND m.user_id = ?)))`;

function readableParams(): (number | null)[] {
  const id = getAccessActor()?.id ?? null;
  return [id, id, id, id];
}

function filesHash(filesJson: string): string {
  return createHash('sha256').update(filesJson).digest('hex');
}

/** Used by Company to persist departments, memberships and the managed skill library. */
export const companyDb = {
  departments(): DepartmentRecord[] {
    const db = getConnection();
    return (db.prepare('SELECT id, name, description FROM departments ORDER BY name').all() as Omit<DepartmentRecord, 'memberIds'>[])
      .map((department) => ({ ...department, memberIds: (db.prepare('SELECT user_id FROM department_members WHERE department_id = ? ORDER BY user_id').all(department.id) as { user_id: number }[]).map((row) => row.user_id) }));
  },
  ownDepartmentIds(userId: number): number[] {
    return (getConnection().prepare('SELECT department_id FROM department_members WHERE user_id = ? ORDER BY department_id').all(userId) as { department_id: number }[]).map((row) => row.department_id);
  },
  createDepartment(name: string, description: string): number {
    return Number(getConnection().prepare('INSERT INTO departments (name, description) VALUES (?, ?)').run(name, description).lastInsertRowid);
  },
  updateDepartment(id: number, name: string, description: string, memberIds: number[]): void {
    const db = getConnection();
    db.transaction(() => {
      db.prepare('UPDATE departments SET name = ?, description = ? WHERE id = ?').run(name, description, id);
      db.prepare('DELETE FROM department_members WHERE department_id = ?').run(id);
      for (const userId of memberIds) db.prepare('INSERT INTO department_members VALUES (?, ?)').run(id, userId);
    })();
  },
  deleteDepartment(id: number): void {
    getConnection().prepare('DELETE FROM departments WHERE id = ?').run(id);
  },

  /** Cards of every skill the current actor may read, optionally narrowed to one agent (or skills for all agents) or one id. */
  skillSummaries(provider?: string, id?: string): ManagedSkillSummary[] {
    const db = getConnection();
    const rows = db.prepare(`SELECT ${SKILL_COLUMNS} FROM managed_skills s LEFT JOIN users u ON u.id = s.owner_user_id
      WHERE ${READABLE_SKILL_SQL} AND (? IS NULL OR s.provider = ? OR s.provider = 'all') AND (? IS NULL OR s.id = ?) ORDER BY s.name, s.created_at`)
      .all(...readableParams(), provider ?? null, provider ?? null, id ?? null, id ?? null) as SkillRow[];
    const actor = getAccessActor();
    const favorites = new Set(actor ? (db.prepare('SELECT skill_id FROM skill_favorites WHERE user_id = ?').all(actor.id) as { skill_id: string }[]).map((row) => row.skill_id) : []);
    const recent = new Map(actor ? (db.prepare('SELECT skill_id, used_at FROM skill_recent WHERE user_id = ?').all(actor.id) as { skill_id: string; used_at: string }[]).map((row) => [row.skill_id, row.used_at]) : []);
    // Shares and author departments come in one query each instead of per card.
    const grouped = <K, V>(pairs: [K, V][]) => pairs.reduce((map, [key, value]) => map.set(key, [...map.get(key) ?? [], value]), new Map<K, V[]>());
    const onlyThisSkill = '(? IS NULL OR skill_id = ?)';
    const departmentShares = grouped((db.prepare(`SELECT skill_id, department_id FROM skill_department_shares WHERE ${onlyThisSkill} ORDER BY department_id`)
      .all(id ?? null, id ?? null) as { skill_id: string; department_id: number }[]).map((row): [string, number] => [row.skill_id, row.department_id]));
    const userShares = grouped((db.prepare(`SELECT skill_id, user_id FROM skill_user_shares WHERE ${onlyThisSkill} ORDER BY user_id`)
      .all(id ?? null, id ?? null) as { skill_id: string; user_id: number }[]).map((row): [string, number] => [row.skill_id, row.user_id]));
    const ownerDepartments = grouped((db.prepare(`SELECT m.user_id, d.name FROM department_members m JOIN departments d ON d.id = m.department_id
      ORDER BY d.name`).all() as { user_id: number; name: string }[]).map((row): [number, string] => [row.user_id, row.name]));
    return rows.map((row) => ({
      id: row.id, name: row.name, description: row.description, category: row.category, examplePrompt: row.example_prompt,
      provider: row.provider, version: row.version, ownerUserId: row.owner_user_id, ownerName: row.owner_name ?? undefined,
      ownerDepartments: ownerDepartments.get(row.owner_user_id) ?? [], visibility: row.visibility,
      departmentIds: departmentShares.get(row.id) ?? [], userIds: userShares.get(row.id) ?? [],
      canManage: actor?.id === row.owner_user_id || (actor?.role === 'admin' && row.visibility === 'company'),
      isFavorite: favorites.has(row.id), lastUsedAt: recent.get(row.id) ?? null, fileCount: row.file_count ?? 0,
      createdAt: row.created_at, updatedAt: row.updated_at,
    }));
  },
  /** A readable skill with SKILL.md and files, or null when it is missing or hidden from the current actor. */
  skill(id: string): ManagedSkillRecord | null {
    const db = getConnection();
    const [summary] = this.skillSummaries(undefined, id);
    if (!summary) return null;
    const row = db.prepare('SELECT content, files_json FROM managed_skills WHERE id = ?').get(id) as { content: string; files_json: string };
    return { ...summary, content: row.content, files: JSON.parse(row.files_json) as SkillFiles };
  },
  /** Current version and SKILL.md of a skill whose id came from a readable listing; cheap, without the attached files. */
  skillHead(id: string): { version: number; content: string } | null {
    return getConnection().prepare('SELECT version, content FROM managed_skills WHERE id = ?').get(id) as { version: number; content: string } | undefined ?? null;
  },
  skillNameTaken(ownerId: number, name: string, exceptId: string): boolean {
    return Boolean(getConnection().prepare('SELECT 1 FROM managed_skills WHERE owner_user_id = ? AND name = ? AND id <> ?').get(ownerId, name, exceptId));
  },
  /** Import sources the actor already copied, and the sources of every skill the actor can read. */
  skillOrigins(userId: number): { own: string[]; readable: string[] } {
    const db = getConnection();
    const own = db.prepare('SELECT origin FROM managed_skills WHERE owner_user_id = ? AND origin IS NOT NULL').all(userId) as { origin: string }[];
    const readable = db.prepare(`SELECT s.origin FROM managed_skills s WHERE s.origin IS NOT NULL AND ${READABLE_SKILL_SQL}`).all(...readableParams()) as { origin: string }[];
    return { own: own.map((row) => row.origin), readable: readable.map((row) => row.origin) };
  },

  /**
   * Creates or updates a skill; a content, metadata or file change records a new version, a sharing-only change does not.
   * A legacy skill without history first gets its current state recorded so the change can be undone.
   */
  saveSkill(skill: SkillSnapshot & { id: string; ownerUserId: number; visibility: SkillVisibility; departmentIds: number[]; userIds: number[]; origin?: string },
    actorId: number, restoredFrom: number | null = null): void {
    const db = getConnection();
    db.transaction(() => {
      const current = db.prepare('SELECT name, description, category, example_prompt, provider, content, files_json, version FROM managed_skills WHERE id = ?')
        .get(skill.id) as { name: string; description: string; category: string; example_prompt: string; provider: string; content: string; files_json: string; version: number } | undefined;
      const filesJson = JSON.stringify(skill.files);
      const changed = !current || current.name !== skill.name || current.description !== skill.description || current.category !== skill.category
        || current.example_prompt !== skill.examplePrompt || current.provider !== skill.provider || current.content !== skill.content || current.files_json !== filesJson;
      if (!current) {
        db.prepare(`INSERT INTO managed_skills (id, owner_user_id, name, description, category, example_prompt, provider, content, files_json, file_count, visibility, origin, version)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`).run(skill.id, skill.ownerUserId, skill.name, skill.description, skill.category,
          skill.examplePrompt, skill.provider, skill.content, filesJson, skill.files.length, skill.visibility, skill.origin ?? null);
      } else if (changed) {
        const hasHistory = db.prepare('SELECT 1 FROM skill_versions WHERE skill_id = ? LIMIT 1').get(skill.id);
        if (!hasHistory) this.recordSkillVersion(skill.id, current.version, { name: current.name, description: current.description, category: current.category,
          examplePrompt: current.example_prompt, provider: current.provider, content: current.content, files: JSON.parse(current.files_json) as SkillFiles }, null, null);
        db.prepare(`UPDATE managed_skills SET name = ?, description = ?, category = ?, example_prompt = ?, provider = ?, content = ?, files_json = ?,
          file_count = ?, visibility = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(skill.name, skill.description, skill.category,
          skill.examplePrompt, skill.provider, skill.content, filesJson, skill.files.length, skill.visibility, skill.id);
      } else {
        db.prepare('UPDATE managed_skills SET visibility = ? WHERE id = ?').run(skill.visibility, skill.id);
      }
      if (changed) {
        const { version } = db.prepare('SELECT version FROM managed_skills WHERE id = ?').get(skill.id) as { version: number };
        this.recordSkillVersion(skill.id, version, skill, actorId, restoredFrom);
      }
      db.prepare('DELETE FROM skill_department_shares WHERE skill_id = ?').run(skill.id);
      for (const departmentId of skill.departmentIds) db.prepare('INSERT INTO skill_department_shares VALUES (?, ?)').run(skill.id, departmentId);
      db.prepare('DELETE FROM skill_user_shares WHERE skill_id = ?').run(skill.id);
      for (const userId of skill.userIds) db.prepare('INSERT INTO skill_user_shares VALUES (?, ?)').run(skill.id, userId);
    })();
  },
  recordSkillVersion(skillId: string, version: number, snapshot: SkillSnapshot, actorId: number | null, restoredFrom: number | null): void {
    const db = getConnection();
    const filesJson = JSON.stringify(snapshot.files);
    const hash = filesHash(filesJson);
    db.prepare('INSERT OR IGNORE INTO skill_file_blobs (hash, files_json) VALUES (?, ?)').run(hash, filesJson);
    db.prepare(`INSERT OR REPLACE INTO skill_versions (skill_id, version, name, description, category, example_prompt, provider, content, files_hash, restored_from, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(skillId, version, snapshot.name, snapshot.description, snapshot.category,
      snapshot.examplePrompt, snapshot.provider, snapshot.content, hash, restoredFrom, actorId);
    db.prepare(`DELETE FROM skill_versions WHERE skill_id = ? AND version NOT IN
      (SELECT version FROM skill_versions WHERE skill_id = ? ORDER BY version DESC LIMIT ${MAX_SKILL_VERSIONS})`).run(skillId, skillId);
    db.prepare('DELETE FROM skill_file_blobs WHERE hash NOT IN (SELECT files_hash FROM skill_versions)').run();
  },
  skillVersions(skillId: string): ManagedSkillVersion[] {
    const db = getConnection();
    const current = db.prepare('SELECT version FROM managed_skills WHERE id = ?').get(skillId) as { version: number } | undefined;
    return (db.prepare(`SELECT v.version, v.name, v.description, v.category, v.restored_from, v.created_at, u.username AS created_by_name
      FROM skill_versions v LEFT JOIN users u ON u.id = v.created_by WHERE v.skill_id = ? ORDER BY v.version DESC`).all(skillId) as SkillVersionRow[])
      .map((row) => ({ version: row.version, name: row.name, description: row.description, category: row.category, createdAt: row.created_at,
        createdByName: row.created_by_name, restoredFrom: row.restored_from, isCurrent: row.version === current?.version }));
  },
  skillVersion(skillId: string, version: number): SkillSnapshot | null {
    const row = getConnection().prepare(`SELECT v.*, b.files_json FROM skill_versions v JOIN skill_file_blobs b ON b.hash = v.files_hash
      WHERE v.skill_id = ? AND v.version = ?`).get(skillId, version) as (SkillVersionRow & { files_json: string }) | undefined;
    return row ? { name: row.name, description: row.description, category: row.category, examplePrompt: row.example_prompt,
      provider: row.provider, content: row.content, files: JSON.parse(row.files_json) as SkillFiles } : null;
  },
  deleteSkill(id: string): void {
    const db = getConnection();
    db.transaction(() => {
      for (const table of ['skill_versions', 'skill_user_shares', 'skill_department_shares', 'skill_favorites', 'skill_recent']) {
        db.prepare(`DELETE FROM ${table} WHERE skill_id = ?`).run(id);
      }
      db.prepare('DELETE FROM managed_skills WHERE id = ?').run(id);
      db.prepare('DELETE FROM skill_file_blobs WHERE hash NOT IN (SELECT files_hash FROM skill_versions)').run();
    })();
  },
  setSkillFavorite(userId: number, skillId: string, favorite: boolean): void {
    getConnection().prepare(favorite ? 'INSERT OR IGNORE INTO skill_favorites (user_id, skill_id) VALUES (?, ?)'
      : 'DELETE FROM skill_favorites WHERE user_id = ? AND skill_id = ?').run(userId, skillId);
  },
  touchSkillRecent(userId: number, skillIds: string[]): void {
    const db = getConnection();
    db.transaction(() => {
      for (const skillId of skillIds) {
        db.prepare(`INSERT INTO skill_recent (user_id, skill_id) VALUES (?, ?) ON CONFLICT(user_id, skill_id)
          DO UPDATE SET used_at = CURRENT_TIMESTAMP, use_count = use_count + 1`).run(userId, skillId);
      }
      db.prepare(`DELETE FROM skill_recent WHERE user_id = ? AND skill_id NOT IN
        (SELECT skill_id FROM skill_recent WHERE user_id = ? ORDER BY used_at DESC, rowid DESC LIMIT ${MAX_RECENT_SKILLS})`).run(userId, userId);
    })();
  },
};
