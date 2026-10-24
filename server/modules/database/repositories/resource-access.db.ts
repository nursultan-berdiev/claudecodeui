import { getConnection } from '@/modules/database/connection.js';
import type { AccessActor, ResourceSharing, ResourceVisibility } from '@/shared/types.js';
import { AppError, getAccessActor } from '@/shared/utils.js';

type SharedRow = { session_id: string; owner_user_id: number | null; visibility: string };

/** Used by session, company and asset services to enforce resource grants independently of UI controls. */
export const resourceAccessDb = {
  defaultOwnerId(): number | null {
    return (getConnection().prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get() as { id: number } | undefined)?.id ?? null;
  },

  canReadSessionRow(row: SharedRow, actor: AccessActor | null = getAccessActor()): boolean {
    if (!actor || row.owner_user_id === actor.id || row.visibility === 'company') return true;
    if (row.visibility !== 'departments') return false;
    return Boolean(getConnection().prepare(`SELECT 1 FROM session_department_shares s
      JOIN department_members m ON m.department_id = s.department_id
      WHERE s.session_id = ? AND m.user_id = ? LIMIT 1`).get(row.session_id, actor.id));
  },

  canReadSession(sessionId: string, actor: AccessActor | null = getAccessActor()): boolean {
    const row = getConnection().prepare('SELECT session_id, owner_user_id, visibility FROM sessions WHERE session_id = ?').get(sessionId) as SharedRow | undefined;
    return Boolean(row && this.canReadSessionRow(row, actor));
  },

  assertManageSession(sessionId: string): void {
    const actor = getAccessActor();
    if (!actor) return;
    const row = getConnection().prepare('SELECT owner_user_id FROM sessions WHERE session_id = ?').get(sessionId) as { owner_user_id: number | null } | undefined;
    if (!row || row.owner_user_id !== actor.id) {
      throw new AppError('Only the chat owner can manage this chat', { code: 'CHAT_OWNER_REQUIRED', statusCode: 403 });
    }
  },

  sessionSharing(sessionId: string): ResourceSharing {
    const row = getConnection().prepare('SELECT session_id, owner_user_id, visibility FROM sessions WHERE session_id = ?').get(sessionId) as SharedRow | undefined;
    if (!row || !this.canReadSessionRow(row)) throw new AppError('Chat not found', { code: 'SESSION_NOT_FOUND', statusCode: 404 });
    const departments = getConnection().prepare('SELECT department_id FROM session_department_shares WHERE session_id = ? ORDER BY department_id').all(sessionId) as { department_id: number }[];
    return { ownerUserId: row.owner_user_id, visibility: row.visibility as ResourceVisibility,
      departmentIds: departments.map((item) => item.department_id), canManage: row.owner_user_id === getAccessActor()?.id };
  },

  setSessionSharing(sessionId: string, visibility: ResourceVisibility, departmentIds: number[]): void {
    this.assertManageSession(sessionId);
    const db = getConnection();
    db.transaction(() => {
      db.prepare('UPDATE sessions SET visibility = ? WHERE session_id = ?').run(visibility, sessionId);
      db.prepare('DELETE FROM session_department_shares WHERE session_id = ?').run(sessionId);
      for (const id of departmentIds) db.prepare('INSERT INTO session_department_shares VALUES (?, ?)').run(sessionId, id);
    })();
  },

  recordAsset(filename: string): void {
    const actor = getAccessActor();
    if (actor) getConnection().prepare('INSERT OR REPLACE INTO asset_owners VALUES (?, ?)').run(filename, actor.id);
  },

  /** Used for files a provider produced inside a chat: owned by the chat owner and readable by the chat's audience. */
  attachSessionAsset(sessionId: string, filename: string, ownerUserId: number | null): void {
    const db = getConnection();
    db.transaction(() => {
      if (ownerUserId !== null) db.prepare('INSERT OR IGNORE INTO asset_owners VALUES (?, ?)').run(filename, ownerUserId);
      db.prepare('INSERT OR IGNORE INTO session_assets VALUES (?, ?)').run(sessionId, filename);
    })();
  },

  bindAsset(sessionId: string, filename: string): void {
    if (!this.canReadAsset(filename)) throw new AppError('Attachment not found', { code: 'ASSET_NOT_FOUND', statusCode: 404 });
    getConnection().prepare('INSERT OR IGNORE INTO session_assets VALUES (?, ?)').run(sessionId, filename);
  },

  canReadAsset(filename: string): boolean {
    const actor = getAccessActor();
    if (!actor) return true;
    const owner = getConnection().prepare('SELECT owner_user_id FROM asset_owners WHERE filename = ?').get(filename) as { owner_user_id: number } | undefined;
    if (owner?.owner_user_id === actor.id) return true;
    if (!owner && actor.id === this.defaultOwnerId()) return true;
    const rows = getConnection().prepare(`SELECT s.session_id, s.owner_user_id, s.visibility FROM sessions s
      JOIN session_assets a ON a.session_id = s.session_id WHERE a.filename = ?`).all(filename) as SharedRow[];
    return rows.some((row) => this.canReadSessionRow(row, actor));
  },
};
