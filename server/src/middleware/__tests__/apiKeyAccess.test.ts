import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import express from 'express';
import type { Server } from 'http';

const { tmpDbPath } = vi.hoisted(() => {
  const osMod = require('os');
  const pathMod = require('path');
  return {
    tmpDbPath: pathMod.join(osMod.tmpdir(), `prunerr-apikey-test-${process.pid}-${Date.now()}.db`),
  };
});

vi.mock('../../config', () => ({
  default: { dbPath: tmpDbPath, nodeEnv: 'test', mediaServer: { type: 'plex' }, plex: { url: '', token: '' }, jellyfin: { url: '', apiKey: '' } },
}));
vi.mock('../../utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { initializeDatabase, closeDatabase } from '../../db/index';
import { setAuthConfigForTests, loadAuthConfig } from '../../auth/config';
import { apiAuthMiddleware, isApiKeyEnabled, setApiKeyEnabled } from '../apiAuth';
import { clearApiKeyUsage, getApiKeyUsageSummary, recordApiKeyUse, pruneApiKeyUsage } from '../../services/apiKeyUsage';
import { getDatabase } from '../../db/index';

process.env['PRUNERR_API_KEY'] = 'the-api-key';

let server: Server;
let baseUrl: string;

async function call(path: string, init: RequestInit = {}) {
  const res = await fetch(`${baseUrl}${path}`, init);
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

describe('API key access switch and usage log', () => {
  beforeAll(async () => {
    initializeDatabase();
    // Login off: the historical mode, where only requests that present a key are checked.
    setAuthConfigForTests(loadAuthConfig({}));

    const app = express();
    app.use('/api', apiAuthMiddleware);
    app.get('/api/library', (_req, res) => res.json({ ok: true }));
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDatabase();
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* ignore */ }
    }
  });

  it('is enabled by default and records accepted and refused uses', async () => {
    clearApiKeyUsage();
    expect(isApiKeyEnabled()).toBe(true);

    const ok = await call('/api/library', { headers: { 'X-Api-Key': 'the-api-key', 'User-Agent': 'nzb360/1.0' } });
    expect(ok.status).toBe(200);
    const bad = await call('/api/library', { headers: { 'X-Api-Key': 'nope', 'User-Agent': 'curl/8' } });
    expect(bad.status).toBe(401);
    expect(bad.json.code).toBe('INVALID_API_KEY');

    const summary = getApiKeyUsageSummary();
    expect(summary.totalRequests).toBe(1);
    expect(summary.requestsLast24h).toBe(1);
    expect(summary.refusedLast24h).toBe(1);
    expect(summary.lastUsedAt).not.toBeNull();
    expect(summary.lastRefusedAt).not.toBeNull();
    expect(summary.clients).toEqual([
      expect.objectContaining({ userAgent: 'nzb360/1.0', requests: 1 }),
    ]);
    expect(summary.recent).toHaveLength(2);
    expect(summary.recent[0]).toMatchObject({ outcome: 'invalid', source: 'api', method: 'GET', path: '/api/library', userAgent: 'curl/8' });
    expect(summary.recent[1]).toMatchObject({ outcome: 'ok', source: 'api' });
  });

  it('does not log requests that never present a key', async () => {
    clearApiKeyUsage();
    const res = await call('/api/library');
    expect(res.status).toBe(200);
    expect(getApiKeyUsageSummary().recent).toHaveLength(0);
  });

  it('refuses the right key while access is switched off, and logs that too', async () => {
    clearApiKeyUsage();
    setApiKeyEnabled(false);
    expect(isApiKeyEnabled()).toBe(false);

    const res = await call('/api/library', { headers: { 'X-Api-Key': 'the-api-key' } });
    expect(res.status).toBe(401);
    expect(res.json.code).toBe('API_KEY_DISABLED');

    // The web UI (no key) is unaffected while login is off.
    expect((await call('/api/library')).status).toBe(200);

    const summary = getApiKeyUsageSummary();
    expect(summary.totalRequests).toBe(0);
    expect(summary.refusedLast24h).toBe(1);
    expect(summary.recent[0]?.outcome).toBe('disabled');

    setApiKeyEnabled(true);
    expect((await call('/api/library', { headers: { 'X-Api-Key': 'the-api-key' } })).status).toBe(200);
  });

  it('prunes rows past retention and beyond the cap', () => {
    clearApiKeyUsage();
    const db = getDatabase();
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(
      `INSERT INTO api_key_usage (used_at, outcome, source, method, path) VALUES (?, 'ok', 'api', 'GET', '/api/old')`
    ).run(old);
    recordApiKeyUse({ outcome: 'ok', source: 'mcp', method: 'post', path: '/mcp' });
    pruneApiKeyUsage();

    const summary = getApiKeyUsageSummary();
    expect(summary.recent).toHaveLength(1);
    expect(summary.recent[0]).toMatchObject({ source: 'mcp', method: 'POST', path: '/mcp' });
  });
});
