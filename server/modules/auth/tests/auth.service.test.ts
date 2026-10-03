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
      setPasswordHash: () => undefined,
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
      setPasswordHash: () => undefined,
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
