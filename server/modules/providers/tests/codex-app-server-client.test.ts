import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openCodexAppServer } from '@/modules/providers/list/codex/codex-app-server.client.js';

/**
 * The connection is driven against the real bundled `codex app-server`, with
 * an empty CODEX_HOME so nothing of the machine's own Codex setup is read or
 * written and no model is ever called.
 */

test('the real app-server completes the handshake, rejects an unknown method and exits on close', { timeout: 60_000 }, async () => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), 'codex-app-server-client-'));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  const exits: string[] = [];
  try {
    const connection = await openCodexAppServer({
      onNotification: () => {},
      onServerRequest: () => ({}),
      onExit: (reason) => { exits.push(reason); },
    });

    await assert.rejects(
      connection.request('no/such/method', {}),
      (error: Error & { code?: string }) => error.code === 'CODEX_APP_SERVER_ERROR',
    );

    connection.close();
    connection.close();
    for (let waited = 0; exits.length === 0 && waited < 5000; waited += 50) {
      await new Promise((resolve) => { setTimeout(resolve, 50); });
    }
    assert.equal(exits.length, 1, 'onExit fires once when the process ends');
    await assert.rejects(connection.request('thread/start', {}), (error: Error & { code?: string }) => error.code === 'CODEX_APP_SERVER_UNAVAILABLE');
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    await rm(codexHome, { recursive: true, force: true });
  }
});
