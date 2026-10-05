import { getConnection } from '@/modules/database/connection.js';
import type { DepartmentRecord, ManagedSkillRecord } from '@/shared/types.js';
import { getAccessActor } from '@/shared/utils.js';

type SkillRow = {
  id: string; owner_user_id: number; name: string; description: string; provider: string;
  content: string; files_json: string; visibility: ManagedSkillRecord['visibility']; source_path: string | null;
  created_at: string; updated_at: string;
};

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
  skillRow(id: string): SkillRow | null {
    return getConnection().prepare('SELECT * FROM managed_skills WHERE id = ?').get(id) as SkillRow ?? null;
  },
  hasImportedSource(source: string): boolean {
    return Boolean(getConnection().prepare(`SELECT 1 FROM managed_skills WHERE source_path = ?
      UNION ALL SELECT 1 FROM dismissed_skill_sources WHERE source_path = ?`).get(source, source));
  },
  skillNameTaken(ownerId: number, name: string, provider: string, exceptId: string): boolean {
    return Boolean(getConnection().prepare('SELECT 1 FROM managed_skills WHERE owner_user_id = ? AND name = ? AND provider = ? AND id <> ?').get(ownerId, name, provider, exceptId));
  },
  canReadSkill(row: SkillRow): boolean {
    const actor = getAccessActor();
    if (!actor || actor.role === 'admin' || row.owner_user_id === actor.id || row.visibility === 'company') return true;
    if (row.visibility !== 'departments') return false;
    return Boolean(getConnection().prepare(`SELECT 1 FROM skill_department_shares s
      JOIN department_members m ON m.department_id = s.department_id WHERE s.skill_id = ? AND m.user_id = ? LIMIT 1`).get(row.id, actor.id));
  },
  skillView(row: SkillRow): ManagedSkillRecord {
    const actor = getAccessActor();
    const shares = getConnection().prepare('SELECT department_id FROM skill_department_shares WHERE skill_id = ? ORDER BY department_id').all(row.id) as { department_id: number }[];
    const owner = getConnection().prepare('SELECT username FROM users WHERE id = ?').get(row.owner_user_id) as { username: string } | undefined;
    return { id: row.id, name: row.name, description: row.description, provider: row.provider, ownerName: owner?.username,
      content: row.content, files: JSON.parse(row.files_json), ownerUserId: row.owner_user_id,
      visibility: row.visibility, departmentIds: shares.map((share) => share.department_id),
      canManage: actor?.id === row.owner_user_id || actor?.role === 'admin', createdAt: row.created_at, updatedAt: row.updated_at };
  },
  skills(provider?: string): ManagedSkillRecord[] {
    const rows = getConnection().prepare('SELECT * FROM managed_skills ORDER BY name, created_at').all() as SkillRow[];
    return rows.filter((row) => (!provider || row.provider === provider || row.provider === 'all') && this.canReadSkill(row)).map((row) => this.skillView(row));
  },
  saveSkill(skill: { id: string; ownerUserId: number; name: string; description: string; provider: string; content: string;
    files: ManagedSkillRecord['files']; visibility: ManagedSkillRecord['visibility']; departmentIds: number[]; sourcePath?: string }): void {
    const db = getConnection();
    db.transaction(() => {
      db.prepare(`INSERT INTO managed_skills (id, owner_user_id, name, description, provider, content, files_json, visibility, source_path)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name,
        description = excluded.description, provider = excluded.provider, content = excluded.content,
        files_json = excluded.files_json, visibility = excluded.visibility, updated_at = CURRENT_TIMESTAMP`)
        .run(skill.id, skill.ownerUserId, skill.name, skill.description, skill.provider, skill.content, JSON.stringify(skill.files), skill.visibility, skill.sourcePath ?? null);
      db.prepare('DELETE FROM skill_department_shares WHERE skill_id = ?').run(skill.id);
      for (const departmentId of skill.departmentIds) db.prepare('INSERT INTO skill_department_shares VALUES (?, ?)').run(skill.id, departmentId);
    })();
  },
  deleteSkill(id: string): void {
    const db = getConnection();
    db.transaction(() => {
      db.prepare(`INSERT OR IGNORE INTO dismissed_skill_sources (source_path)
        SELECT source_path FROM managed_skills WHERE id = ? AND source_path IS NOT NULL`).run(id);
      db.prepare('DELETE FROM managed_skills WHERE id = ?').run(id);
    })();
  },
};
