/**
 * User repository.
 *
 * Provides typed CRUD operations for the `users` table.
 * Local account records and stable external identity fields are stored here.
 */

import { getConnection } from '@/modules/database/connection.js';

type UserRow = {
  id: number;
  username: string;
  password_hash: string;
  role: 'admin' | 'member';
  identity_provider: string;
  identity_subject: string | null;
  auth_version: number;
  created_at: string;
  last_login: string | null;
  is_active: number;
  git_name: string | null;
  git_email: string | null;
  has_completed_onboarding: number;
  must_change_password: number;
};

type UserPublicRow = Pick<UserRow, 'id' | 'username' | 'role' | 'identity_provider' | 'is_active' | 'auth_version' | 'created_at' | 'last_login' | 'must_change_password'>;

type UserGitConfig = {
  git_name: string | null;
  git_email: string | null;
};

type CreateUserResult = {
  id: number | bigint;
  username: string;
  role: 'admin' | 'member';
  auth_version: number;
};

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const userDb = {
  /** Returns true if at least one user exists in the database. */
  hasUsers(): boolean {
    const db = getConnection();
    const row = db.prepare('SELECT COUNT(*) as count FROM users').get() as {
      count: number;
    };
    return row.count > 0;
  },

  /** Inserts a new user and returns the created ID + username. */
  createUser(username: string, passwordHash: string, role: 'admin' | 'member' = 'member'): CreateUserResult {
    const db = getConnection();
    const result = db
      .prepare('INSERT INTO users (username, password_hash, role, has_completed_onboarding) VALUES (?, ?, ?, ?)')
      .run(username, passwordHash, role, role === 'member' ? 1 : 0);
    return { id: result.lastInsertRowid, username, role, auth_version: 0 };
  },

  /**
   * Looks up an active user by username.
   * Returns the full row (including password hash) for auth verification.
   */
  getUserByUsername(username: string): UserRow | undefined {
    const db = getConnection();
    return db
      .prepare('SELECT * FROM users WHERE username = ? AND is_active = 1')
      .get(username) as UserRow | undefined;
  },

  /** Updates the last_login timestamp. Non-fatal — logs but does not throw. */
  updateLastLogin(userId: number): void {
    try {
      const db = getConnection();
      db.prepare(
        'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?'
      ).run(userId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Failed to update last login', { error: message });
    }
  },

  /** Returns public user fields by ID (no password hash). */
  getUserById(userId: number): UserPublicRow | undefined {
    const db = getConnection();
    return db
      .prepare(
        'SELECT id, username, role, identity_provider, is_active, auth_version, created_at, last_login, must_change_password FROM users WHERE id = ? AND is_active = 1'
      )
      .get(userId) as UserPublicRow | undefined;
  },

  /** Lists accounts for administration without exposing password hashes. */
  listUsers(): UserPublicRow[] {
    return getConnection()
      .prepare('SELECT id, username, role, identity_provider, is_active, auth_version, created_at, last_login, must_change_password FROM users ORDER BY id')
      .all() as UserPublicRow[];
  },

  /** Reads an account including a disabled one for admin updates. */
  getUserByIdIncludingInactive(userId: number): UserPublicRow | undefined {
    return getConnection()
      .prepare('SELECT id, username, role, identity_provider, is_active, auth_version, created_at, last_login, must_change_password FROM users WHERE id = ?')
      .get(userId) as UserPublicRow | undefined;
  },

  /** Counts administrators who can still sign in. */
  countActiveAdmins(): number {
    const row = getConnection()
      .prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND is_active = 1")
      .get() as { count: number };
    return row.count;
  },

  /** Changes a local account's role. */
  setRole(userId: number, role: 'admin' | 'member'): void {
    getConnection().prepare('UPDATE users SET role = ?, auth_version = auth_version + 1 WHERE id = ?').run(role, userId);
  },

  /** Enables or disables an account. */
  setActive(userId: number, isActive: boolean): void {
    getConnection().prepare('UPDATE users SET is_active = ?, auth_version = auth_version + 1 WHERE id = ?').run(isActive ? 1 : 0, userId);
  },

  /**
   * Replaces a local password hash and signs the account out of every existing session.
   * With `expectedAuthVersion`, nothing is written unless the account is still at that version.
   */
  setPasswordHash(userId: number, passwordHash: string, mustChangePassword: boolean, expectedAuthVersion?: number): boolean {
    const db = getConnection();
    const result = expectedAuthVersion === undefined
      ? db
        .prepare('UPDATE users SET password_hash = ?, must_change_password = ?, auth_version = auth_version + 1 WHERE id = ?')
        .run(passwordHash, mustChangePassword ? 1 : 0, userId)
      : db
        .prepare('UPDATE users SET password_hash = ?, must_change_password = ?, auth_version = auth_version + 1 WHERE id = ? AND auth_version = ?')
        .run(passwordHash, mustChangePassword ? 1 : 0, userId, expectedAuthVersion);
    return result.changes > 0;
  },

  /** Returns the first active user. Used for single-user mode lookups. */
  getFirstUser(): UserPublicRow | undefined {
    const db = getConnection();
    return db
      .prepare(
        'SELECT id, username, role, identity_provider, is_active, auth_version, created_at, last_login, must_change_password FROM users WHERE is_active = 1 LIMIT 1'
      )
      .get() as UserPublicRow | undefined;
  },

  /** Stores the user's preferred git name and email. */
  updateGitConfig(
    userId: number,
    gitName: string,
    gitEmail: string
  ): void {
    const db = getConnection();
    db.prepare('UPDATE users SET git_name = ?, git_email = ? WHERE id = ?').run(
      gitName,
      gitEmail,
      userId
    );
  },

  /** Retrieves the user's git identity (name + email). */
  getGitConfig(userId: number): UserGitConfig | undefined {
    const db = getConnection();
    return db
      .prepare('SELECT git_name, git_email FROM users WHERE id = ?')
      .get(userId) as UserGitConfig | undefined;
  },

  /** Marks onboarding as complete for the given user. */
  completeOnboarding(userId: number): void {
    const db = getConnection();
    db.prepare(
      'UPDATE users SET has_completed_onboarding = 1 WHERE id = ?'
    ).run(userId);
  },

  /** Returns true if the user has finished the onboarding flow. */
  hasCompletedOnboarding(userId: number): boolean {
    const db = getConnection();
    const row = db
      .prepare('SELECT has_completed_onboarding FROM users WHERE id = ?')
      .get(userId) as { has_completed_onboarding: number } | undefined;
    return row?.has_completed_onboarding === 1;
  },
};
