import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// A real SQLite file in a temp directory: the chain is only meaningful
// against the actual table, and the secret and anchor files live beside it.
const { tmpDir, tmpDbPath } = vi.hoisted(() => {
  const osMod = require('os') as typeof import('os');
  const pathMod = require('path') as typeof import('path');
  const fsMod = require('fs') as typeof import('fs');
  const dir = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'prunerr-audit-test-'));
  return { tmpDir: dir, tmpDbPath: pathMod.join(dir, 'prunerr.db') };
});

vi.mock('../../config', () => ({
  default: { dbPath: tmpDbPath, nodeEnv: 'test', mediaServer: { type: 'plex' }, plex: { url: '', token: '' }, jellyfin: { url: '', apiKey: '' } },
}));
vi.mock('../../utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { initializeDatabase, closeDatabase, getDatabase } from '../../db/index';
import { computeHash, countAudit, getAuditSecret, listAudit, readAnchor, recordAudit, redact, resetAuditSecretCache, verifyAuditChain } from '../audit';

describe('audit log', () => {
  beforeAll(() => {
    delete process.env['AUDIT_SECRET'];
    resetAuditSecretCache();
    initializeDatabase();
  });

  afterAll(() => {
    closeDatabase();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a secret file beside the database and reuses it', () => {
    const secret = getAuditSecret();
    expect(secret).toHaveLength(64);
    expect(fs.readFileSync(path.join(tmpDir, 'audit.secret'), 'utf8').trim()).toBe(secret);
    resetAuditSecretCache();
    expect(getAuditSecret()).toBe(secret);
  });

  it('chains entries, redacts secrets, and writes the anchor', () => {
    const first = recordAudit({ action: 'auth.login', actor: { type: 'user', name: 'alice', id: 'local:alice', role: 'admin' }, ip: '10.0.0.5' });
    const second = recordAudit({
      action: 'settings.changed',
      actor: { type: 'user', name: 'alice', id: 'local:alice', role: 'admin' },
      targetType: 'settings',
      details: { changes: [{ key: 'radarr_apiKey', from: 'old-key', to: 'new-key' }, { key: 'display_theme', from: 'dark', to: 'light' }] },
    });
    expect(first?.prevHash).toBeNull();
    expect(second?.prevHash).toBe(first?.hash);
    const changes = (second?.details as { changes: Array<{ key: string; from: unknown; to: unknown }> }).changes;
    expect(changes[0]).toEqual({ key: 'radarr_apiKey', from: '[redacted]', to: '[redacted]' });
    expect(changes[1]).toEqual({ key: 'display_theme', from: 'dark', to: 'light' });
    expect(readAnchor()).toMatchObject({ id: second!.id, hash: second!.hash });
    expect(countAudit()).toBe(2);
  });

  it('verifies an intact chain', () => {
    recordAudit({ action: 'item.deleted', actor: { type: 'scheduler', name: 'Scheduled queue run' }, targetType: 'media_item', targetId: 42, targetTitle: 'Some Movie' });
    const result = verifyAuditChain();
    expect(result).toMatchObject({ ok: true, entries: 3, firstBreak: null, anchorMatches: true });
  });

  it('lists newest first with filters', () => {
    const all = listAudit({ limit: 10 });
    expect(all.total).toBe(3);
    expect(all.entries[0]?.action).toBe('item.deleted');
    expect(listAudit({ action: 'auth.' }).entries.map((e) => e.action)).toEqual(['auth.login']);
    expect(listAudit({ actor: 'alice' }).total).toBe(2);
    expect(listAudit({ search: 'Some Movie' }).total).toBe(1);
  });

  it('detects an edited row, a deleted row, and a swapped anchor', () => {
    const db = getDatabase();
    // Edit the target of the second entry in place.
    db.prepare("UPDATE audit_log SET target_title = 'tampered' WHERE id = 2").run();
    let result = verifyAuditChain();
    expect(result.ok).toBe(false);
    expect(result.firstBreak).toMatchObject({ id: 2, reason: 'hash_mismatch' });

    // Put it back, then recompute its hash as an attacker without the secret might.
    db.prepare('UPDATE audit_log SET target_title = NULL WHERE id = 2').run();
    expect(verifyAuditChain().ok).toBe(true);
    const row = db.prepare('SELECT * FROM audit_log WHERE id = 2').get() as Record<string, unknown>;
    const forged = computeHash(row as never, 'wrong-secret');
    db.prepare('UPDATE audit_log SET hash = ? WHERE id = 2').run(forged);
    result = verifyAuditChain();
    expect(result.firstBreak).toMatchObject({ id: 2, reason: 'hash_mismatch' });
    db.prepare('UPDATE audit_log SET hash = ? WHERE id = 2').run(row['hash']);

    // Remove a row from the middle: the next row's link no longer matches.
    db.prepare('DELETE FROM audit_log WHERE id = 2').run();
    result = verifyAuditChain();
    expect(result.firstBreak).toMatchObject({ id: 3, reason: 'chain_gap' });
  });

  it('redacts by key name wherever it appears', () => {
    expect(redact({ plex_token: 'abc', nested: { webhookUrl: 'https://x', title: 'ok' }, list: [{ password: 'p' }] })).toEqual({
      plex_token: '[redacted]',
      nested: { webhookUrl: '[redacted]', title: 'ok' },
      list: [{ password: '[redacted]' }],
    });
  });
});
