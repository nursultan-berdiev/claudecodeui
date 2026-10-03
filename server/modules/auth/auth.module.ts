import { createRequire } from 'node:module';

import { authAuditDb, getConnection, userDb } from '@/modules/database/index.js';

import { authenticateToken, generateToken } from './auth.middleware.js';
import { createAuthRouter } from './auth.routes.js';
import { createAuthService } from './auth.service.js';
import { createLocalIdentityProvider } from './local-identity.provider.js';

type BcryptAdapter = {
  hash(password: string, saltRounds: number): Promise<string>;
  compare(password: string, passwordHash: string): Promise<boolean>;
};

// bcrypt does not ship TypeScript declarations in this project, so the
// composition root narrows its CommonJS runtime surface before injecting it.
const require = createRequire(import.meta.url);
const bcrypt = require('bcrypt') as BcryptAdapter;
const databaseConnection = getConnection();

const authService = createAuthService({
  users: {
    hasUsers: () => userDb.hasUsers(),
    createUser: (username, passwordHash, role) => userDb.createUser(username, passwordHash, role),
    listUsers: () => userDb.listUsers(),
    getUserByIdIncludingInactive: (userId) => userDb.getUserByIdIncludingInactive(userId),
    countActiveAdmins: () => userDb.countActiveAdmins(),
    setRole: (userId, role) => userDb.setRole(userId, role),
    setActive: (userId, isActive) => userDb.setActive(userId, isActive),
    setPasswordHash: (userId, passwordHash) => userDb.setPasswordHash(userId, passwordHash),
    updateLastLogin: (userId) => userDb.updateLastLogin(userId),
  },
  identityProvider: createLocalIdentityProvider({
    getUserByUsername: (username) => userDb.getUserByUsername(username),
    comparePassword: (password, passwordHash) => bcrypt.compare(password, passwordHash),
  }),
  transaction: {
    begin: () => databaseConnection.prepare('BEGIN').run(),
    commit: () => databaseConnection.prepare('COMMIT').run(),
    rollback: () => databaseConnection.prepare('ROLLBACK').run(),
  },
  hashPassword: (password) => bcrypt.hash(password, 12),
  generateToken,
  audit: authAuditDb,
});

/** Auth router assembled for the server entrypoint. */
export const authRoutes = createAuthRouter(authService, authenticateToken);
