import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { authAuditDb } from '@/modules/database/repositories/auth-audit.js';
import { userDb } from '@/modules/database/repositories/users.js';

test('existing single-user database gains an administrator and supports managed users', async () => {
  const oldPath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(tmpdir(), 'cloudcli-users-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');

  try {
    const db = getConnection();
    db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_login DATETIME,
        is_active BOOLEAN DEFAULT 1
      );
      INSERT INTO users (username, password_hash) VALUES ('owner', 'hash');
    `);

    await initializeDatabase();
    const owner = userDb.getUserByUsername('owner');
    assert.equal(owner?.role, 'admin');
    assert.equal(owner?.auth_version, 0);
    assert.equal(owner?.identity_provider, 'local');

    const member = userDb.createUser('member', 'hash', 'member');
    assert.equal(member.role, 'member');
    userDb.setActive(Number(member.id), false);
    assert.equal(userDb.getUserById(Number(member.id)), undefined);
    assert.equal(userDb.getUserByIdIncludingInactive(Number(member.id))?.auth_version, 1);
    assert.equal(userDb.countActiveAdmins(), 1);

    authAuditDb.record(Number(owner?.id), 'account.create', 'member', 201);
    assert.equal(authAuditDb.recent(1)[0]?.action, 'account.create');
  } finally {
    closeConnection();
    if (oldPath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = oldPath;
    await rm(directory, { recursive: true, force: true });
  }
});
