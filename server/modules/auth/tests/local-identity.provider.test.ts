import assert from 'node:assert/strict';
import test from 'node:test';

import { createLocalIdentityProvider } from '../local-identity.provider.js';

test('local login rejects an externally managed identity even when the password hash matches', async () => {
  const provider = createLocalIdentityProvider({
    getUserByUsername: () => ({
      id: 3,
      username: 'directory-user',
      role: 'member',
      identity_provider: 'ldap',
      password_hash: 'placeholder',
    }),
    comparePassword: async () => true,
  });

  assert.equal(await provider.authenticate('directory-user', 'any-password'), null);
});
