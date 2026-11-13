import { createRequire } from 'node:module';

import { AppError } from '@/shared/utils.js';

/**
 * Resolves the `codex` launcher shipped in node_modules
 * (`@openai/codex/bin/codex.js`), run with the server's own Node. Used to
 * spawn `codex app-server` and the Plan sandbox check.
 *
 * Deliberately not the `codex` on PATH: a machine can have a second, older
 * install, and the protocol and config this code relies on are only
 * guaranteed against the version this package depends on.
 */
export function resolveCodexLauncher(): string {
  const require_ = createRequire(import.meta.url);
  try {
    return require_.resolve('@openai/codex/bin/codex.js');
  } catch {
    throw new AppError('The Codex CLI package is not installed, so Codex cannot run.', {
      code: 'CODEX_CLI_UNAVAILABLE',
      statusCode: 501,
    });
  }
}
