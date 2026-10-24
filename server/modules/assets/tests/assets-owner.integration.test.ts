import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { assetsRoutes } from '@/modules/assets/index.js';
import { closeConnection, initializeDatabase, resourceAccessDb, userDb } from '@/modules/database/index.js';
import { withAccessActor } from '@/shared/utils.js';

test('an uploaded attachment is owned by the member who uploaded it', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'assets-owner-'));
  const previous = { database: process.env.DATABASE_PATH, home: process.env.HOME };
  closeConnection(); process.env.DATABASE_PATH = path.join(directory, 'auth.db'); process.env.HOME = directory;
  await initializeDatabase();
  userDb.createUser('admin', 'hash', 'admin');
  const member = { id: Number(userDb.createUser('member', 'hash', 'member').id), role: 'member' as const };
  const app = express();
  app.use((_req, _res, next) => withAccessActor(member, next));
  app.use('/api/assets', assetsRoutes);
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    // The file part arrives after the route has returned, as a large upload through a proxy does.
    const boundary = 'owner-test-boundary';
    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, path: '/api/assets/files', method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } }, (res) => {
        let text = ''; res.on('data', (chunk) => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
      });
      request.on('error', reject);
      request.write(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="note.txt"\r\nContent-Type: text/plain\r\n\r\n`);
      setTimeout(() => request.end(`note\r\n--${boundary}--\r\n`), 50);
    });
    assert.equal(response.status, 200);
    const { attachments } = JSON.parse(response.body) as { attachments: { path: string }[] };
    assert.equal(withAccessActor(member, () => resourceAccessDb.canReadAsset(path.basename(attachments[0].path))), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    closeConnection();
    if (previous.database === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous.database;
    if (previous.home === undefined) delete process.env.HOME; else process.env.HOME = previous.home;
    await rm(directory, { recursive: true, force: true });
  }
});
