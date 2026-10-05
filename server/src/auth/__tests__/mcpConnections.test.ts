import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';

// A real SQLite file: the grant listing is SQL over the token and client tables.
const { tmpDbPath } = vi.hoisted(() => {
  const osMod = require('os') as typeof import('os');
  const pathMod = require('path') as typeof import('path');
  return { tmpDbPath: pathMod.join(osMod.tmpdir(), `prunerr-mcp-conn-test-${process.pid}-${Date.now()}.db`) };
});

vi.mock('../../config', () => ({
  default: { dbPath: tmpDbPath, nodeEnv: 'test', mediaServer: { type: 'plex' }, plex: { url: '', token: '' }, jellyfin: { url: '', apiKey: '' } },
}));
vi.mock('../../utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { initializeDatabase, closeDatabase, getDatabase } from '../../db/index';
import { deleteClient, hasConsent, issueTokens, listConnections, recordConsent, registerClient, resolveAccessToken, revokeConnection } from '../oauthServer';

describe('MCP connections (OAuth grants as Settings sees them)', () => {
  let clientId = '';

  beforeAll(() => {
    initializeDatabase();
    clientId = registerClient({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], client_name: 'Claude', token_endpoint_auth_method: 'none' }).client.client_id;
  });

  afterAll(() => {
    closeDatabase();
    fs.rmSync(tmpDbPath, { force: true });
  });

  it('lists one grant per token pair with the client name, and records use', () => {
    recordConsent('local:alice', clientId);
    const first = issueTokens({ clientId, user: { key: 'local:alice', username: 'alice', role: 'admin' }, scope: 'prunerr', resource: null });
    const second = issueTokens({ clientId, user: { key: 'oidc:bob', username: 'bob', role: 'viewer' }, scope: 'prunerr', resource: null });

    let grants = listConnections();
    expect(grants).toHaveLength(2);
    expect(grants.map((g) => g.username).sort()).toEqual(['alice', 'bob']);
    expect(grants.every((g) => g.clientName === 'Claude' && g.lastUsedAt === null)).toBe(true);

    const resolved = resolveAccessToken(first.accessToken);
    expect(resolved?.username).toBe('alice');
    grants = listConnections();
    const alice = grants.find((g) => g.username === 'alice')!;
    expect(alice.lastUsedAt).not.toBeNull();
    expect(alice.pairId).toBe(resolved!.pairId);
    expect(grants.find((g) => g.username === 'bob')!.lastUsedAt).toBeNull();
    expect(resolveAccessToken(second.accessToken)?.username).toBe('bob');
  });

  it('revokes one grant, kills both its tokens, and drops the consent with the last grant', () => {
    const alice = listConnections().find((g) => g.username === 'alice')!;
    const revoked = revokeConnection(alice.pairId);
    expect(revoked?.username).toBe('alice');
    expect(listConnections().map((g) => g.username)).toEqual(['bob']);
    expect(getDatabase().prepare<[string], { c: number }>('SELECT COUNT(*) AS c FROM oauth_tokens WHERE pair_id = ?').get(alice.pairId)?.c).toBe(0);
    expect(hasConsent('local:alice', clientId)).toBe(false);
    expect(revokeConnection(alice.pairId)).toBeNull();
  });

  it('forgetting the client removes its remaining grants and registration', () => {
    expect(deleteClient(clientId)).toBe(true);
    expect(listConnections()).toEqual([]);
    expect(getDatabase().prepare<[string], { c: number }>('SELECT COUNT(*) AS c FROM oauth_tokens WHERE client_id = ?').get(clientId)?.c).toBe(0);
  });
});
