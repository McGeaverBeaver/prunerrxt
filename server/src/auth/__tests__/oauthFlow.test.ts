import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import crypto from 'crypto';
import express from 'express';
import type { Server } from 'http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const { tmpDbPath } = vi.hoisted(() => {
  const osMod = require('os');
  const pathMod = require('path');
  return {
    tmpDbPath: pathMod.join(osMod.tmpdir(), `prunerr-oauth-test-${process.pid}-${Date.now()}.db`),
  };
});

vi.mock('../../config', () => ({
  default: { dbPath: tmpDbPath, nodeEnv: 'test', mediaServer: { type: 'plex' }, plex: { url: '', token: '' }, jellyfin: { url: '', apiKey: '' } },
}));
vi.mock('../../utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../services/init', () => ({
  getSonarrService: () => null,
  getRadarrService: () => null,
  getOverseerrService: () => null,
  getPlexService: () => null,
  getTautulliService: () => null,
  getTracearrService: () => null,
}));
vi.mock('../../services/deletion', () => ({
  getDeletionService: () => ({ executeDelete: vi.fn(async () => ({ success: true })) }),
}));
vi.mock('../../notifications', () => ({
  getNotificationService: () => ({ notify: vi.fn(async () => undefined) }),
}));
vi.mock('../../scheduler', () => ({
  getScheduler: () => ({
    getStatus: () => [],
    getJobStatus: () => undefined,
    getConfig: () => ({ timezone: 'UTC', schedules: { scanLibraries: '0 3 * * *', syncPlexLibrary: '0 2 * * *' } }),
    isSchedulerRunning: () => true,
  }),
}));
vi.mock('../../scheduler/tasks', () => ({
  scanLibraries: vi.fn(async () => ({ success: true })),
  queueItemForDeletion: vi.fn(() => ({ deleteAfter: new Date().toISOString() })),
  notifyItemsQueued: vi.fn(async () => undefined),
}));

import { initializeDatabase, closeDatabase } from '../../db/index';
import { setAuthConfigForTests, loadAuthConfig } from '../config';
import { apiAuthMiddleware } from '../../middleware/apiAuth';
import authRouter from '../routes';
import oauthRouter from '../oauthRoutes';
import { createMcpRouter, closeAllMcpSessions } from '../../mcp/http';

process.env['PRUNERR_API_KEY'] = 'the-api-key';

let server: Server;
let baseUrl: string;

async function call(path: string, init: RequestInit = {}) {
  const res = await fetch(`${baseUrl}${path}`, { redirect: 'manual', ...init });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json: json as any, text, headers: res.headers };
}

function pkce() {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

describe('OAuth 2.1 for MCP clients', () => {
  let cookie = '';

  beforeAll(async () => {
    initializeDatabase();
    setAuthConfigForTests(
      loadAuthConfig({
        AUTH_ENABLED: 'true',
        AUTH_LOCAL_ENABLED: 'true',
        AUTH_LOCAL_USERNAME: 'ops',
        AUTH_LOCAL_PASSWORD: 'operator-pass',
        AUTH_LOCAL_ROLE: 'operator',
      })
    );

    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use(oauthRouter);
    app.use('/mcp', createMcpRouter());
    app.use('/api', apiAuthMiddleware);
    app.use('/api/auth', authRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
        resolve();
      });
    });

    const login = await call('/api/auth/login/local', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'ops', password: 'operator-pass' }),
    });
    expect(login.status).toBe(200);
    cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  });

  afterAll(async () => {
    await closeAllMcpSessions();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDatabase();
    setAuthConfigForTests(null);
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* ignore */ }
    }
  });

  it('advertises itself as a protected resource and an authorization server', async () => {
    const unauth = await call('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
    });
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get('www-authenticate')).toContain(`resource_metadata="${baseUrl}/.well-known/oauth-protected-resource/mcp"`);

    const prm = await call('/.well-known/oauth-protected-resource/mcp');
    expect(prm.status).toBe(200);
    expect(prm.json.resource).toBe(`${baseUrl}/mcp`);
    expect(prm.json.authorization_servers).toEqual([baseUrl]);

    const asm = await call('/.well-known/oauth-authorization-server');
    expect(asm.json.issuer).toBe(baseUrl);
    expect(asm.json.registration_endpoint).toBe(`${baseUrl}/oauth/register`);
    expect(asm.json.code_challenge_methods_supported).toEqual(['S256']);
  });

  it('runs the full code + PKCE flow and gates tools by role', async () => {
    // 1. Dynamic client registration (what claude.ai does first)
    const reg = await call('/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], token_endpoint_auth_method: 'none' }),
    });
    expect(reg.status).toBe(201);
    const clientId = reg.json.client_id as string;
    expect(clientId.startsWith('prn_ci_')).toBe(true);
    expect(reg.json.client_secret).toBeUndefined();

    const bad = await call('/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['http://evil.example.com/cb'] }),
    });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe('invalid_request');

    // 2. Authorize: not signed in → sent to the login page, remembering where to return
    const { verifier, challenge } = pkce();
    const authorizeUrl =
      `/oauth/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent('https://claude.ai/api/mcp/auth_callback')}` +
      `&state=xyz&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(`${baseUrl}/mcp`)}`;
    const anon = await call(authorizeUrl);
    expect(anon.status).toBe(302);
    expect(anon.headers.get('location')).toBe(`/login?returnTo=${encodeURIComponent(authorizeUrl)}`);

    // 3. Signed in → consent page
    const consent = await call(authorizeUrl, { headers: { Cookie: cookie } });
    expect(consent.status).toBe(200);
    expect(consent.text).toContain('Allow Claude to use PrunerrXT?');
    const requestId = /name="request_id" value="([^"]+)"/.exec(consent.text)?.[1];
    expect(requestId).toBeTruthy();

    // 4. Allow → redirect back with a code
    const decision = await call('/oauth/authorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: new URLSearchParams({ request_id: requestId!, decision: 'allow' }).toString(),
    });
    expect(decision.status).toBe(302);
    const location = new URL(decision.headers.get('location')!);
    expect(location.origin + location.pathname).toBe('https://claude.ai/api/mcp/auth_callback');
    expect(location.searchParams.get('state')).toBe('xyz');
    const code = location.searchParams.get('code')!;
    expect(code.startsWith('prn_ac_')).toBe(true);

    // 5. Token exchange, PKCE enforced
    const wrongVerifier = await call('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: 'x'.repeat(50), redirect_uri: 'https://claude.ai/api/mcp/auth_callback' }).toString(),
    });
    expect(wrongVerifier.status).toBe(400);
    expect(wrongVerifier.json.error).toBe('invalid_grant');

    // The code is single-use, so approve again (consent is now remembered: no page, straight redirect)
    const again = await call(authorizeUrl, { headers: { Cookie: cookie } });
    expect(again.status).toBe(302);
    const code2 = new URL(again.headers.get('location')!).searchParams.get('code')!;

    const tokenRes = await call('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code: code2, code_verifier: verifier, redirect_uri: 'https://claude.ai/api/mcp/auth_callback' }).toString(),
    });
    expect(tokenRes.status).toBe(200);
    expect(tokenRes.json.token_type).toBe('Bearer');
    const accessToken = tokenRes.json.access_token as string;
    const refreshToken = tokenRes.json.refresh_token as string;

    // 6. Use the token against MCP; the operator role is enforced on tools
    const client = new Client({ name: 'test', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
    await client.connect(transport);
    try {
      const overview = await client.callTool({ name: 'get_overview', arguments: {} });
      expect(overview.isError).toBeFalsy();

      const settings = await client.callTool({ name: 'get_settings_summary', arguments: {} });
      expect(settings.isError).toBe(true);
      const text = (settings.content as Array<{ type: string; text?: string }>).map((c) => c.text).join('');
      expect(text).toMatch(/role \(operator\)/);
    } finally {
      await client.close();
    }

    // 7. Refresh rotates; the old refresh token dies; revoke kills the pair
    const refreshed = await call('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken }).toString(),
    });
    expect(refreshed.status).toBe(200);
    expect(refreshed.json.access_token).not.toBe(accessToken);

    const reuse = await call('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken }).toString(),
    });
    expect(reuse.status).toBe(400);

    const revoked = await call('/oauth/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refreshed.json.access_token, client_id: clientId }).toString(),
    });
    expect(revoked.status).toBe(200);

    const dead = await call('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${refreshed.json.access_token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
    });
    expect(dead.status).toBe(401);
    expect(dead.headers.get('www-authenticate')).toContain('invalid_token');
  });

  it('still accepts the API key as admin', async () => {
    const client = new Client({ name: 'test', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: 'Bearer the-api-key' } },
    });
    await client.connect(transport);
    try {
      const settings = await client.callTool({ name: 'get_settings_summary', arguments: {} });
      expect(settings.isError).toBeFalsy();
    } finally {
      await client.close();
    }
  });
});
