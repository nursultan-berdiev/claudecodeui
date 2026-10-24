type LocalUser = {
  id: number | bigint;
  username: string;
  role: 'admin' | 'member';
  identity_provider: string;
  password_hash: string;
};

type LocalIdentityDependencies = {
  getUserByUsername(username: string): LocalUser | undefined;
  comparePassword(password: string, passwordHash: string): Promise<boolean>;
};

/** Used by Auth to verify local credentials; another identity provider can implement the same authenticate contract. */
export function createLocalIdentityProvider(dependencies: LocalIdentityDependencies) {
  return {
    async authenticate(username: string, password: string): Promise<LocalUser | null> {
      const user = dependencies.getUserByUsername(username);
      if (!user || user.identity_provider !== 'local') {
        return null;
      }
      return await dependencies.comparePassword(password, user.password_hash) ? user : null;
    },
  };
}
