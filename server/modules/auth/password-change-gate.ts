// Only the change itself and the session plumbing the change screen needs stay open.
const PASSWORD_CHANGE_ALLOWED_PATHS = new Set([
  '/api/auth/user',
  '/api/auth/password',
  '/api/auth/refresh',
  '/api/auth/logout',
]);

/** Used by the REST and WebSocket guards; API keys and the chat dispatcher read the same users column directly. */
export function mustChangePassword(user: { must_change_password?: number | boolean | null } | null | undefined): boolean {
  return Boolean(user?.must_change_password);
}

/** Used by authenticateToken to decide which request path such an account may still reach. */
export function isAllowedBeforePasswordChange(path: string): boolean {
  return PASSWORD_CHANGE_ALLOWED_PATHS.has(path);
}
