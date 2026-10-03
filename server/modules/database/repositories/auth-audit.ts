import { getConnection } from '@/modules/database/connection.js';

type AuditEvent = {
  id: number;
  actor_user_id: number | null;
  action: string;
  target: string | null;
  status_code: number | null;
  created_at: string;
};

/** Used by Auth to record account and HTTP actions without request bodies or credentials. */
export const authAuditDb = {
  record(actorUserId: number | null, action: string, target: string | null, statusCode: number | null): void {
    getConnection()
      .prepare('INSERT INTO audit_events (actor_user_id, action, target, status_code) VALUES (?, ?, ?, ?)')
      .run(actorUserId, action, target, statusCode);
  },

  recent(limit = 100): AuditEvent[] {
    return getConnection()
      .prepare('SELECT id, actor_user_id, action, target, status_code, created_at FROM audit_events ORDER BY id DESC LIMIT ?')
      .all(limit) as AuditEvent[];
  },
};
