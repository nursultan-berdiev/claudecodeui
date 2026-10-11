import assert from 'node:assert/strict';
import test from 'node:test';

import { isAllowedBeforePasswordChange, mustChangePassword } from '../password-change-gate.js';

test('a temporary password only opens the password change and session endpoints', () => {
  for (const path of ['/api/auth/user', '/api/auth/password', '/api/auth/refresh', '/api/auth/logout']) {
    assert.equal(isAllowedBeforePasswordChange(path), true, path);
  }
  for (const path of ['/api/projects', '/api/auth/users', '/api/user/preferences', '/api/agent', '/api/auth/password/x']) {
    assert.equal(isAllowedBeforePasswordChange(path), false, path);
  }
});

test('only a set flag requires a password change', () => {
  assert.equal(mustChangePassword({ must_change_password: 1 }), true);
  assert.equal(mustChangePassword({ must_change_password: 0 }), false);
  assert.equal(mustChangePassword({}), false);
  assert.equal(mustChangePassword(undefined), false);
});
