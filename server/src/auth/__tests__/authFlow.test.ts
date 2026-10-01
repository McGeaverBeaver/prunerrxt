import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import express from 'express';
import type { Server } from 'http';

const { tmpDbPath } = vi.hoisted(() => {
  const osMod = require('os');
  const pathMod = require('path');
  return {
    tmpDbPath: pathMod.join(osMod.tmpdir(), `prunerr-auth-test-${process.pid}-${Date.now()}.db`),
  };
});

vi.mock('../../config', () => ({
  default: { dbPath: tmpDbPath, nodeEnv: 'test', mediaServer: { type: 'plex' }, plex: { url: '', token: '' }, jellyfin: { url: '', apiKey: '' } },
}));
vi.mock('../../utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { initializeDatabase, closeDatabase } from '../../db/index';
import { setAuthConfigForTests, loadAuthConfig } from '../config';
import { hashPassword, verifyPasswordHash, verifyLocalCredentials } from '../local';
import { apiAuthMiddleware } from '../../middleware/apiAuth';
import authRouter from '../routes';
import { getRequestAuth } from '../middleware';

process.env['PRUNERR_API_KEY'] = 'the-api-key';

let server: Server;
let baseUrl: string;

const INIT_BODY = { method: 'POST', headers: { 'Content-Type': 'application/json' } } as const;

async function call(path: string, init: RequestInit = {}) {
  const res = await fetch(`${baseUrl}${path}`, { redirect: 'manual', ...init });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json: json as any, headers: res.headers };
}

function cookieFrom(headers: Headers): string {
  const setCookie = headers.get('set-cookie') ?? '';
  return setCookie.split(';')[0] ?? '';
}

describe('login flow', () => {
  beforeAll(async () => {
    initializeDatabase();
    setAuthConfigForTests(
      loadAuthConfig({
        AUTH_ENABLED: 'true',
        AUTH_LOCAL_ENABLED: 'true',
        AUTH_LOCAL_USERNAME: 'admin',
        AUTH_LOCAL_PASSWORD_HASH: hashPassword('open sesame'),
        AUTH_LOCAL_ROLE: 'operator',
      })
    );

    const app = express();
    app.use(express.json());
    app.use('/api', apiAuthMiddleware);
    app.use('/api/auth', authRouter);
    app.get('/api/health/ping', (_req, res) => res.json({ pong: true }));
    app.get('/api/library', (_req, res) => res.json({ ok: true, role: getRequestAuth(res)?.role }));
    app.post('/api/library/1/mark-deletion', (_req, res) => res.json({ ok: true }));
    app.get('/api/settings', (_req, res) => res.json({ secret: true }));
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

  it('hashes and verifies passwords', () => {
    const hash = hashPassword('secret-value');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(verifyPasswordHash('secret-value', hash)).toBe(true);
    expect(verifyPasswordHash('wrong', hash)).toBe(false);
    expect(verifyPasswordHash('secret-value', 'garbage')).toBe(false);
    expect(verifyLocalCredentials('ADMIN', 'open sesame')).toEqual({ username: 'admin', role: 'operator' });
    expect(verifyLocalCredentials('admin', 'nope')).toBeNull();
  });

  it('keeps health probes and the auth endpoints public', async () => {
    expect((await call('/api/health/ping')).status).toBe(200);
    const me = await call('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.json.data.enabled).toBe(true);
    expect(me.json.data.user).toBeNull();
    expect(me.json.data.methods.local.enabled).toBe(true);
    expect(me.json.data.methods.oidc.enabled).toBe(false);
  });

  it('requires a login for everything else', async () => {
    const res = await call('/api/library');
    expect(res.status).toBe(401);
    expect(res.json.code).toBe('AUTH_REQUIRED');
  });

  it('still accepts the API key as admin', async () => {
    const res = await call('/api/settings', { headers: { 'X-Api-Key': 'the-api-key' } });
    expect(res.status).toBe(200);
    const bad = await call('/api/settings', { headers: { 'X-Api-Key': 'wrong' } });
    expect(bad.status).toBe(401);
  });

  it('logs in locally, enforces the role, and logs out', async () => {
    const wrong = await call('/api/auth/login/local', { ...INIT_BODY, body: JSON.stringify({ username: 'admin', password: 'nope' }) });
    expect(wrong.status).toBe(401);

    const login = await call('/api/auth/login/local', { ...INIT_BODY, body: JSON.stringify({ username: 'admin', password: 'open sesame' }) });
    expect(login.status).toBe(200);
    expect(login.json.data.user.role).toBe('operator');
    const cookie = cookieFrom(login.headers);
    expect(cookie.startsWith('prunerr_session=')).toBe(true);
    expect(login.headers.get('set-cookie')).toContain('HttpOnly');

    const me = await call('/api/auth/me', { headers: { Cookie: cookie } });
    expect(me.json.data.user.username).toBe('admin');

    const library = await call('/api/library', { headers: { Cookie: cookie } });
    expect(library.status).toBe(200);
    expect(library.json.role).toBe('operator');

    const mutate = await call('/api/library/1/mark-deletion', { method: 'POST', headers: { Cookie: cookie } });
    expect(mutate.status).toBe(200);

    const settings = await call('/api/settings', { headers: { Cookie: cookie } });
    expect(settings.status).toBe(403);
    expect(settings.json.code).toBe('FORBIDDEN');

    const crossSite = await call('/api/library/1/mark-deletion', { method: 'POST', headers: { Cookie: cookie, 'Sec-Fetch-Site': 'cross-site' } });
    expect(crossSite.status).toBe(403);
    expect(crossSite.json.code).toBe('CSRF');

    const forged = await call('/api/library', { headers: { Cookie: `${cookie}x` } });
    expect(forged.status).toBe(401);

    const logout = await call('/api/auth/logout', { method: 'POST', headers: { Cookie: cookie } });
    expect(logout.status).toBe(200);
    const after = await call('/api/library', { headers: { Cookie: cookie } });
    expect(after.status).toBe(401);
  });

  it('redirects to the login page when SSO is not configured', async () => {
    const res = await call('/api/auth/oidc/start');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login?error=oidc_unavailable');
  });

  it('behaves as before when login is disabled', async () => {
    setAuthConfigForTests(loadAuthConfig({}));
    try {
      const res = await call('/api/library');
      expect(res.status).toBe(200);
      expect(res.json.role).toBe('admin');
      const me = await call('/api/auth/me');
      expect(me.json.data.enabled).toBe(false);
      expect(me.json.data.mcpEnabled).toBe(false);
    } finally {
      setAuthConfigForTests(null);
    }
  });
});
