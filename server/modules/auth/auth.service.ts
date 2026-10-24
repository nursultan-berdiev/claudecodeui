import { AppError } from '@/shared/utils.js';

type AuthUser = {
  id: number | bigint;
  username: string;
  role: 'admin' | 'member';
  auth_version?: number;
  must_change_password?: number;
  identity_provider?: string;
};

type ManagedUser = AuthUser & {
  identity_provider: string;
  is_active: number;
  created_at: string;
  last_login: string | null;
};

type AuthDependencies = {
  users: {
    hasUsers(): boolean;
    createUser(username: string, passwordHash: string, role: 'admin' | 'member'): AuthUser;
    listUsers(): ManagedUser[];
    getUserByIdIncludingInactive(userId: number): ManagedUser | undefined;
    countActiveAdmins(): number;
    setRole(userId: number, role: 'admin' | 'member'): void;
    setActive(userId: number, isActive: boolean): void;
    setPasswordHash(userId: number, passwordHash: string, mustChangePassword: boolean, expectedAuthVersion?: number): boolean;
    updateLastLogin(userId: number): void;
  };
  identityProvider: {
    authenticate(username: string, password: string): Promise<AuthUser | null>;
  };
  transaction: {
    begin(): void;
    commit(): void;
    rollback(): void;
  };
  hashPassword(password: string): Promise<string>;
  generateToken(user: AuthUser): string;
  audit: {
    record(actorUserId: number | null, action: string, target: string | null, statusCode: number | null): void;
    recent(limit: number): unknown[];
  };
};

function numericUserId(userId: number | bigint): number {
  return Number(userId);
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'SQLITE_CONSTRAINT_UNIQUE';
}

function requireAdmin(actor: unknown): AuthUser {
  if (!actor || typeof actor !== 'object' || !('id' in actor) || !('role' in actor)
    || (actor as AuthUser).role !== 'admin') {
    throw new AppError('Administrator access required', {
      code: 'AUTH_ADMIN_REQUIRED',
      statusCode: 403,
    });
  }
  return actor as AuthUser;
}

function readRole(role: unknown): 'admin' | 'member' {
  if (role === 'admin' || role === 'member') return role;
  throw new AppError('Role must be admin or member', {
    code: 'AUTH_INVALID_ROLE',
    statusCode: 400,
  });
}

function readUserId(value: unknown): number {
  const id = typeof value === 'string' ? Number(value) : value;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) {
    throw new AppError('Invalid user id', {
      code: 'AUTH_INVALID_USER_ID',
      statusCode: 400,
    });
  }
  return id;
}

const MIN_PASSWORD_LENGTH = 8;

function requirePasswordLength(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new AppError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`, {
      code: 'AUTH_CREDENTIALS_TOO_SHORT', statusCode: 400,
    });
  }
}

function readSessionUser(user: unknown): AuthUser {
  if (
    typeof user !== 'object'
    || user === null
    || !('id' in user)
    || !('username' in user)
    || (typeof user.id !== 'number' && typeof user.id !== 'bigint')
    || typeof user.username !== 'string'
  ) {
    throw new AppError('Authenticated user is required', {
      code: 'AUTH_USER_REQUIRED',
      statusCode: 401,
    });
  }
  return user as AuthUser;
}

function validateLocalCredentials(username: string, password: string): void {
  if (username.length < 3 || password.length < MIN_PASSWORD_LENGTH) {
    throw new AppError(`Username must be at least 3 characters and password at least ${MIN_PASSWORD_LENGTH} characters`, {
      code: 'AUTH_CREDENTIALS_TOO_SHORT',
      statusCode: 400,
    });
  }
}

/**
 * Creates the Auth application service around explicit persistence, crypto,
 * transaction, and token dependencies.
 */
export function createAuthService(dependencies: AuthDependencies) {
  return {
    getStatus() {
      return {
        needsSetup: !dependencies.users.hasUsers(),
        isAuthenticated: false,
      };
    },

    async register(usernameInput: unknown, passwordInput: unknown) {
      const username = typeof usernameInput === 'string' ? usernameInput : '';
      const password = typeof passwordInput === 'string' ? passwordInput : '';

      if (!username || !password) {
        throw new AppError('Username and password are required', {
          code: 'AUTH_CREDENTIALS_REQUIRED',
          statusCode: 400,
        });
      }
      validateLocalCredentials(username, password);
      const passwordHash = await dependencies.hashPassword(password);

      dependencies.transaction.begin();
      try {
        if (dependencies.users.hasUsers()) {
          throw new AppError('Initial administrator already configured', {
            code: 'AUTH_USER_ALREADY_CONFIGURED',
            statusCode: 403,
          });
        }

        const user = dependencies.users.createUser(username, passwordHash, 'admin');
        dependencies.audit.record(numericUserId(user.id), 'account.bootstrap', username, 201);
        const token = dependencies.generateToken(user);
        dependencies.transaction.commit();
        dependencies.users.updateLastLogin(numericUserId(user.id));

        return {
          success: true,
          user: { id: user.id, username: user.username, role: user.role },
          token,
        };
      } catch (error) {
        dependencies.transaction.rollback();
        if (isUniqueConstraintError(error)) {
          throw new AppError('Username already exists', {
            code: 'AUTH_USERNAME_CONFLICT',
            statusCode: 409,
          });
        }
        throw error;
      }
    },

    async login(usernameInput: unknown, passwordInput: unknown) {
      const username = typeof usernameInput === 'string' ? usernameInput : '';
      const password = typeof passwordInput === 'string' ? passwordInput : '';
      if (!username || !password) {
        throw new AppError('Username and password are required', {
          code: 'AUTH_CREDENTIALS_REQUIRED',
          statusCode: 400,
        });
      }

      const user = await dependencies.identityProvider.authenticate(username, password);
      if (!user) {
        dependencies.audit.record(null, 'account.login.failed', username, 401);
        throw new AppError('Invalid username or password', {
          code: 'AUTH_INVALID_CREDENTIALS',
          statusCode: 401,
        });
      }

      dependencies.users.updateLastLogin(numericUserId(user.id));
      dependencies.audit.record(numericUserId(user.id), 'account.login', null, 200);
      return {
        success: true,
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
          must_change_password: user.must_change_password ? 1 : 0,
        },
        token: dependencies.generateToken(user),
      };
    },

    listUsers(actor: unknown) {
      requireAdmin(actor);
      return { users: dependencies.users.listUsers() };
    },

    listAudit(actor: unknown) {
      requireAdmin(actor);
      return { events: dependencies.audit.recent(100) };
    },

    async createManagedUser(actor: unknown, usernameInput: unknown, passwordInput: unknown, roleInput: unknown) {
      requireAdmin(actor);
      const username = typeof usernameInput === 'string' ? usernameInput.trim() : '';
      const password = typeof passwordInput === 'string' ? passwordInput : '';
      validateLocalCredentials(username, password);
      const role = roleInput === undefined ? 'member' : readRole(roleInput);
      const passwordHash = await dependencies.hashPassword(password);
      try {
        const user = dependencies.users.createUser(username, passwordHash, role);
        return { user };
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw new AppError('Username already exists', {
            code: 'AUTH_USERNAME_CONFLICT',
            statusCode: 409,
          });
        }
        throw error;
      }
    },

    updateManagedUser(actorInput: unknown, userIdInput: unknown, changes: { role?: unknown; isActive?: unknown }) {
      const actor = requireAdmin(actorInput);
      const userId = readUserId(userIdInput);
      if (changes.role === undefined && changes.isActive === undefined) {
        throw new AppError('Role or active state is required', { code: 'AUTH_EMPTY_UPDATE', statusCode: 400 });
      }
      const role = changes.role === undefined ? undefined : readRole(changes.role);
      const isActive = changes.isActive === undefined ? undefined : changes.isActive;
      if (isActive !== undefined && typeof isActive !== 'boolean') {
        throw new AppError('isActive must be a boolean', { code: 'AUTH_INVALID_ACTIVE_STATE', statusCode: 400 });
      }

      dependencies.transaction.begin();
      try {
        const target = dependencies.users.getUserByIdIncludingInactive(userId);
        if (!target) {
          throw new AppError('User not found', { code: 'AUTH_USER_NOT_FOUND', statusCode: 404 });
        }
        if (Number(actor.id) === userId && (role === 'member' || isActive === false)) {
          throw new AppError('An administrator cannot remove their own access', {
            code: 'AUTH_SELF_ACCESS_REQUIRED', statusCode: 400,
          });
        }
        if (target.role === 'admin' && target.is_active === 1
          && (role === 'member' || isActive === false)
          && dependencies.users.countActiveAdmins() <= 1) {
          throw new AppError('At least one active administrator is required', {
            code: 'AUTH_LAST_ADMIN_REQUIRED', statusCode: 400,
          });
        }
        if (role !== undefined) dependencies.users.setRole(userId, role);
        if (isActive !== undefined) dependencies.users.setActive(userId, isActive);
        const updated = dependencies.users.getUserByIdIncludingInactive(userId);
        dependencies.transaction.commit();
        return { user: updated };
      } catch (error) {
        dependencies.transaction.rollback();
        throw error;
      }
    },

    async resetManagedPassword(actor: unknown, userIdInput: unknown, passwordInput: unknown, requireChangeInput?: unknown) {
      requireAdmin(actor);
      const userId = readUserId(userIdInput);
      const password = typeof passwordInput === 'string' ? passwordInput : '';
      requirePasswordLength(password);
      const requireChange = requireChangeInput === undefined ? true : requireChangeInput;
      if (typeof requireChange !== 'boolean') {
        throw new AppError('requireChange must be a boolean', {
          code: 'AUTH_INVALID_REQUIRE_CHANGE', statusCode: 400,
        });
      }
      const target = dependencies.users.getUserByIdIncludingInactive(userId);
      if (!target) {
        throw new AppError('User not found', { code: 'AUTH_USER_NOT_FOUND', statusCode: 404 });
      }
      if (target.identity_provider !== 'local') {
        throw new AppError('Password is managed by the identity provider', {
          code: 'AUTH_EXTERNAL_PASSWORD', statusCode: 400,
        });
      }
      const passwordHash = await dependencies.hashPassword(password);
      dependencies.users.setPasswordHash(userId, passwordHash, requireChange);
      return { success: true, mustChangePassword: requireChange };
    },

    async changeOwnPassword(actor: unknown, currentPasswordInput: unknown, newPasswordInput: unknown) {
      const user = readSessionUser(actor);
      const currentPassword = typeof currentPasswordInput === 'string' ? currentPasswordInput : '';
      const newPassword = typeof newPasswordInput === 'string' ? newPasswordInput : '';
      if (!currentPassword || !newPassword) {
        throw new AppError('Current and new password are required', {
          code: 'AUTH_CREDENTIALS_REQUIRED', statusCode: 400,
        });
      }
      requirePasswordLength(newPassword);
      if (newPassword === currentPassword) {
        throw new AppError('New password must differ from the current one', {
          code: 'AUTH_PASSWORD_UNCHANGED', statusCode: 400,
        });
      }
      if (user.identity_provider !== undefined && user.identity_provider !== 'local') {
        throw new AppError('Password is managed by the identity provider', {
          code: 'AUTH_EXTERNAL_PASSWORD', statusCode: 400,
        });
      }
      const verified = await dependencies.identityProvider.authenticate(user.username, currentPassword);
      if (!verified || Number(verified.id) !== numericUserId(user.id)) {
        throw new AppError('Current password is incorrect', {
          code: 'AUTH_INVALID_CURRENT_PASSWORD', statusCode: 400,
        });
      }

      const passwordHash = await dependencies.hashPassword(newPassword);
      // The session's version pins the write, so an administrator reset during the bcrypt awaits is not overwritten.
      if (!dependencies.users.setPasswordHash(numericUserId(user.id), passwordHash, false, user.auth_version)) {
        throw new AppError('The account changed while the password was being updated', {
          code: 'AUTH_SESSION_CHANGED', statusCode: 409,
        });
      }
      const updated = dependencies.users.getUserByIdIncludingInactive(numericUserId(user.id));
      if (!updated) {
        throw new AppError('User not found', { code: 'AUTH_USER_NOT_FOUND', statusCode: 404 });
      }
      return {
        success: true,
        user: { id: updated.id, username: updated.username, role: updated.role, must_change_password: 0 },
        token: dependencies.generateToken(updated),
      };
    },

    getCurrentUser(user: unknown) {
      return { user };
    },

    refreshSession(user: unknown) {
      return { token: dependencies.generateToken(readSessionUser(user)) };
    },

    logout() {
      return { success: true, message: 'Logged out successfully' };
    },
  };
}
