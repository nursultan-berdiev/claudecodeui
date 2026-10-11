import assert from 'node:assert/strict';
import test from 'node:test';

import { AppError } from '@/shared/utils.js';

import { createAuthService } from '../auth.service.js';

type AuthDependencies = Parameters<typeof createAuthService>[0];

function createDependencies(overrides: Partial<AuthDependencies> = {}): AuthDependencies {
  return {
    users: {
      hasUsers: () => false,
      createUser: (username, _passwordHash, role) => ({ id: 1, username, role }),
      listUsers: () => [],
      getUserByIdIncludingInactive: () => undefined,
      countActiveAdmins: () => 1,
      setRole: () => undefined,
      setActive: () => undefined,
      setPasswordHash: () => true,
      updateLastLogin: () => undefined,
    },
    identityProvider: { authenticate: async () => null },
    transaction: {
      begin: () => undefined,
      commit: () => undefined,
      rollback: () => undefined,
    },
    hashPassword: async () => 'hashed-password',
    generateToken: () => 'signed-token',
    audit: {
      record: () => undefined,
      recent: () => [],
    },
    ...overrides,
  };
}

test('register hashes credentials and commits through injected dependencies', async () => {
  const operations: string[] = [];
  const service = createAuthService(createDependencies({
    transaction: {
      begin: () => operations.push('begin'),
      commit: () => operations.push('commit'),
      rollback: () => operations.push('rollback'),
    },
    hashPassword: async (password) => {
      operations.push(`hash:${password}`);
      return 'hash';
    },
    users: {
      hasUsers: () => false,
      createUser: (username, passwordHash, role) => {
        operations.push(`create:${username}:${passwordHash}:${role}`);
        return { id: 1, username, role };
      },
      listUsers: () => [],
      getUserByIdIncludingInactive: () => undefined,
      countActiveAdmins: () => 1,
      setRole: () => undefined,
      setActive: () => undefined,
      setPasswordHash: () => true,
      updateLastLogin: (userId) => operations.push(`login:${userId}`),
    },
  }));

  const result = await service.register('alice', 'secret12');

  assert.equal(result.token, 'signed-token');
  assert.deepEqual(operations, ['hash:secret12', 'begin', 'create:alice:hash:admin', 'commit', 'login:1']);
});

test('login rejects an invalid password without issuing a token', async () => {
  let tokenIssued = false;
  const service = createAuthService(createDependencies({
    identityProvider: { authenticate: async () => null },
    generateToken: () => {
      tokenIssued = true;
      return 'token';
    },
  }));

  await assert.rejects(
    service.login('alice', 'wrong-password'),
    (error: unknown) => error instanceof AppError && error.code === 'AUTH_INVALID_CREDENTIALS',
  );
  assert.equal(tokenIssued, false);
});

test('refreshSession issues a replacement token for the authenticated user', () => {
  let tokenUser: { id: number | bigint; username: string } | undefined;
  const service = createAuthService(createDependencies({
    generateToken: (user) => {
      tokenUser = user;
      return 'replacement-token';
    },
  }));

  const result = service.refreshSession({ id: 7, username: 'alice', role: 'member' });

  assert.deepEqual(result, { token: 'replacement-token' });
  assert.deepEqual(tokenUser, { id: 7, username: 'alice', role: 'member' });
});

test('member cannot manage other accounts', async () => {
  const service = createAuthService(createDependencies());
  const member = { id: 2, username: 'bob', role: 'member' };
  assert.throws(() => service.listUsers(member), (error: unknown) =>
    error instanceof AppError && error.code === 'AUTH_ADMIN_REQUIRED');
  await assert.rejects(service.createManagedUser(member, 'alice', 'secret123', 'member'),
    (error: unknown) => error instanceof AppError && error.code === 'AUTH_ADMIN_REQUIRED');
});

test('administrator cannot disable the last active administrator', () => {
  const admin = { id: 1, username: 'alice', role: 'admin' as const };
  const target = {
    ...admin, identity_provider: 'local', is_active: 1,
    created_at: '', last_login: null,
  };
  const service = createAuthService(createDependencies({
    users: {
      ...createDependencies().users,
      getUserByIdIncludingInactive: () => target,
      countActiveAdmins: () => 1,
    },
  }));
  assert.throws(() => service.updateManagedUser(admin, 1, { isActive: false }),
    (error: unknown) => error instanceof AppError && error.code === 'AUTH_SELF_ACCESS_REQUIRED');
  assert.throws(() => service.updateManagedUser({ id: 2, username: 'other', role: 'admin' }, 1, { isActive: false }),
    (error: unknown) => error instanceof AppError && error.code === 'AUTH_LAST_ADMIN_REQUIRED');
});

test('administrator reset requires a password change unless told otherwise', async () => {
  const resets: Array<[number, string, boolean]> = [];
  const target = {
    id: 5, username: 'bob', role: 'member' as const, identity_provider: 'local', is_active: 1,
    created_at: '', last_login: null,
  };
  const service = createAuthService(createDependencies({
    users: {
      ...createDependencies().users,
      getUserByIdIncludingInactive: () => target,
      setPasswordHash: (userId, passwordHash, mustChangePassword) => {
        resets.push([userId, passwordHash, mustChangePassword]);
        return true;
      },
    },
  }));
  const admin = { id: 1, username: 'alice', role: 'admin' };

  assert.deepEqual(await service.resetManagedPassword(admin, 5, 'temporary1'), { success: true, mustChangePassword: true });
  assert.deepEqual(await service.resetManagedPassword(admin, 5, 'temporary1', false), { success: true, mustChangePassword: false });
  await assert.rejects(service.resetManagedPassword(admin, 5, 'temporary1', 'yes'),
    (error: unknown) => error instanceof AppError && error.code === 'AUTH_INVALID_REQUIRE_CHANGE');
  assert.deepEqual(resets, [[5, 'hashed-password', true], [5, 'hashed-password', false]]);
});

test('changeOwnPassword keeps the old password when the current one is wrong', async () => {
  let hashed = false;
  const service = createAuthService(createDependencies({
    identityProvider: { authenticate: async () => null },
    hashPassword: async () => {
      hashed = true;
      return 'hash';
    },
  }));

  await assert.rejects(
    service.changeOwnPassword({ id: 5, username: 'bob', role: 'member' }, 'wrong-current', 'brand-new-pass'),
    (error: unknown) => error instanceof AppError && error.code === 'AUTH_INVALID_CURRENT_PASSWORD' && error.statusCode === 400,
  );
  assert.equal(hashed, false);
});

test('changeOwnPassword rejects a short or unchanged new password before checking the current one', async () => {
  let checked = false;
  const service = createAuthService(createDependencies({
    identityProvider: {
      authenticate: async () => {
        checked = true;
        return null;
      },
    },
  }));
  const bob = { id: 5, username: 'bob', role: 'member' };

  await assert.rejects(service.changeOwnPassword(bob, 'temporary1', 'short'),
    (error: unknown) => error instanceof AppError && error.code === 'AUTH_CREDENTIALS_TOO_SHORT');
  await assert.rejects(service.changeOwnPassword(bob, 'temporary1', 'temporary1'),
    (error: unknown) => error instanceof AppError && error.code === 'AUTH_PASSWORD_UNCHANGED');
  await assert.rejects(service.changeOwnPassword(bob, '', 'brand-new-pass'),
    (error: unknown) => error instanceof AppError && error.code === 'AUTH_CREDENTIALS_REQUIRED');
  assert.equal(checked, false);
});

test('changeOwnPassword clears the pending change and signs the new session version', async () => {
  const resets: Array<[number, string, boolean]> = [];
  let tokenUser: { auth_version?: number } | undefined;
  const bob = { id: 5, username: 'bob', role: 'member' as const };
  const service = createAuthService(createDependencies({
    identityProvider: { authenticate: async (username, password) => (username === 'bob' && password === 'temporary1' ? bob : null) },
    hashPassword: async (password) => `hash:${password}`,
    generateToken: (user) => {
      tokenUser = user;
      return 'new-session-token';
    },
    users: {
      ...createDependencies().users,
      setPasswordHash: (userId, passwordHash, mustChangePassword) => {
        resets.push([userId, passwordHash, mustChangePassword]);
        return true;
      },
      getUserByIdIncludingInactive: () => ({
        ...bob, identity_provider: 'local', is_active: 1, created_at: '', last_login: null, auth_version: 3,
      }),
    },
  }));

  const result = await service.changeOwnPassword(bob, 'temporary1', 'brand-new-pass');

  assert.deepEqual(resets, [[5, 'hash:brand-new-pass', false]]);
  assert.equal(result.token, 'new-session-token');
  assert.deepEqual(result.user, { id: 5, username: 'bob', role: 'member', must_change_password: 0 });
  assert.equal(tokenUser?.auth_version, 3);
});

test('login tells the client that a temporary password must be changed', async () => {
  const service = createAuthService(createDependencies({
    identityProvider: {
      authenticate: async () => ({ id: 5, username: 'bob', role: 'member', must_change_password: 1 }),
    },
  }));

  const result = await service.login('bob', 'temporary1');

  assert.deepEqual(result.user, { id: 5, username: 'bob', role: 'member', must_change_password: 1 });
});

test('changeOwnPassword refuses an account whose password belongs to an external identity provider', async () => {
  let checked = false;
  const service = createAuthService(createDependencies({
    identityProvider: {
      authenticate: async () => {
        checked = true;
        return null;
      },
    },
  }));

  await assert.rejects(
    service.changeOwnPassword({ id: 5, username: 'bob', role: 'member', identity_provider: 'ldap' }, 'current-pass', 'brand-new-pass'),
    (error: unknown) => error instanceof AppError && error.code === 'AUTH_EXTERNAL_PASSWORD',
  );
  assert.equal(checked, false);
});

test('changeOwnPassword does not overwrite an administrator reset that landed during the change', async () => {
  const writes: Array<number | undefined> = [];
  let tokenIssued = false;
  const bob = { id: 5, username: 'bob', role: 'member' as const, auth_version: 2 };
  const service = createAuthService(createDependencies({
    identityProvider: { authenticate: async () => bob },
    generateToken: () => {
      tokenIssued = true;
      return 'token';
    },
    users: {
      ...createDependencies().users,
      // The administrator's reset already moved the account to version 3.
      setPasswordHash: (_userId, _passwordHash, _mustChange, expectedAuthVersion) => {
        writes.push(expectedAuthVersion);
        return false;
      },
    },
  }));

  await assert.rejects(service.changeOwnPassword(bob, 'temporary1', 'brand-new-pass'),
    (error: unknown) => error instanceof AppError && error.code === 'AUTH_SESSION_CHANGED' && error.statusCode === 409);
  assert.deepEqual(writes, [2]);
  assert.equal(tokenIssued, false);
});
