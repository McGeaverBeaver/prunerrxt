import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import express from 'express';
import type { Server } from 'http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// Real on-disk SQLite so the migrations run; same temp-db + hoisting trick as
// the route tests.
const { tmpDbPath } = vi.hoisted(() => {
  const osMod = require('os');
  const pathMod = require('path');
  return {
    tmpDbPath: pathMod.join(osMod.tmpdir(), `prunerr-mcp-test-${process.pid}-${Date.now()}.db`),
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
  getDeletionService: () => ({
    executeDelete: vi.fn(async () => ({ success: true, fileSizeFreed: 1_000 })),
  }),
}));
vi.mock('../../notifications', () => ({
  getNotificationService: () => ({ notify: vi.fn(async () => undefined) }),
}));
// The scheduler spins up timers on import.
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
import { createMediaItem, updateMediaItem, getMediaItemById } from '../../db/repositories/mediaItems';
import settingsRepo from '../../db/repositories/settings';
import { setAuthConfigForTests, loadAuthConfig } from '../../auth/config';
import { createMcpRouter, closeAllMcpSessions } from '../http';
import { MCP_SETTING_ALLOW_IMMEDIATE_DELETION, MCP_SETTING_ENABLED } from '../config';

const API_KEY = 'test-api-key-0123456789abcdef';
process.env['PRUNERR_API_KEY'] = API_KEY;

let server: Server;
let baseUrl: string;

function textOf(result: unknown): string {
  const content = ((result as { content?: unknown }).content ?? []) as Array<{ type: string; text?: string }>;
  return content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
}

async function connect(key: string | null = API_KEY): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: key ? { headers: { Authorization: `Bearer ${key}` } } : {},
  });
  await client.connect(transport);
  return client;
}

function seedMovie(title: string, overrides: Partial<{ file_size: number; play_count: number; is_protected: boolean }> = {}) {
  const item = createMediaItem({
    type: 'movie',
    title,
    plex_id: `rk-${title}`,
    file_size: overrides.file_size ?? 5_000_000_000,
    play_count: overrides.play_count ?? 0,
    added_at: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString(),
  } as never);
  if (overrides.is_protected) updateMediaItem(item.id, { is_protected: true, protection_reason: 'test', status: 'protected' });
  return item;
}

describe('MCP connector', () => {
  beforeAll(async () => {
    initializeDatabase();
    setAuthConfigForTests(loadAuthConfig({ AUTH_ENABLED: 'true', AUTH_LOCAL_ENABLED: 'true', AUTH_LOCAL_USERNAME: 'admin', AUTH_LOCAL_PASSWORD: 'correct horse' }));

    const app = express();
    app.use(express.json());
    app.use('/mcp', createMcpRouter());
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await closeAllMcpSessions();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDatabase();
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* ignore */ }
    }
  });

  beforeEach(() => {
    settingsRepo.delete(MCP_SETTING_ENABLED);
    settingsRepo.delete(MCP_SETTING_ALLOW_IMMEDIATE_DELETION);
  });

  it('rejects requests without an API key', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('Bearer');
  });

  it('rejects a wrong API key', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'X-Api-Key': 'nope' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
    });
    expect(res.status).toBe(401);
  });

  it('is off when login is disabled', async () => {
    setAuthConfigForTests(loadAuthConfig({}));
    try {
      const res = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toMatch(/login is disabled/i);
    } finally {
      setAuthConfigForTests(loadAuthConfig({ AUTH_ENABLED: 'true', AUTH_LOCAL_ENABLED: 'true', AUTH_LOCAL_USERNAME: 'admin', AUTH_LOCAL_PASSWORD: 'correct horse' }));
    }
  });

  it('can be switched off in settings', async () => {
    settingsRepo.set({ key: MCP_SETTING_ENABLED, value: 'false' });
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
    });
    expect(res.status).toBe(403);
  });

  it('initializes a session and lists tools, resources and prompts', async () => {
    const client = await connect();
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(['get_overview', 'search_library', 'queue_for_deletion', 'list_queue', 'create_rule', 'preview_rule', 'delete_now']));
      expect(names.length).toBeGreaterThan(40);

      const deleteNow = tools.tools.find((t) => t.name === 'delete_now')!;
      expect(deleteNow.annotations?.destructiveHint).toBe(true);
      const overview = tools.tools.find((t) => t.name === 'get_overview')!;
      expect(overview.annotations?.readOnlyHint).toBe(true);

      const resources = await client.listResources();
      expect(resources.resources.map((r) => r.uri)).toEqual(expect.arrayContaining(['prunerr://overview', 'prunerr://queue', 'prunerr://rules/schema']));

      const prompts = await client.listPrompts();
      expect(prompts.prompts.map((p) => p.name)).toEqual(expect.arrayContaining(['review_queue', 'build_rule']));
    } finally {
      await client.close();
    }
  });

  it('reads the library through tools and resources', async () => {
    const movie = seedMovie('Big Unwatched Movie', { file_size: 40_000_000_000 });
    const client = await connect();
    try {
      const search = await client.callTool({ name: 'search_library', arguments: { query: 'Unwatched' } });
      expect(search.isError).toBeFalsy();
      const structured = search.structuredContent as { total: number; items: Array<{ id: number; title: string; size: string }> };
      expect(structured.total).toBeGreaterThanOrEqual(1);
      expect(structured.items.some((i) => i.id === movie.id)).toBe(true);

      const detail = await client.callTool({ name: 'get_media_item', arguments: { id: movie.id } });
      expect(textOf(detail)).toContain('Big Unwatched Movie');

      const resource = await client.readResource({ uri: `prunerr://media/${movie.id}` });
      const text = resource.contents[0] && 'text' in resource.contents[0] ? String(resource.contents[0].text) : '';
      expect(JSON.parse(text).title).toBe('Big Unwatched Movie');

      const overview = await client.callTool({ name: 'get_overview', arguments: {} });
      expect(overview.isError).toBeFalsy();
    } finally {
      await client.close();
    }
  });

  it('queues items with a grace period and refuses protected ones', async () => {
    const target = seedMovie('Queue Me');
    const shielded = seedMovie('Shielded', { is_protected: true });
    const client = await connect();
    try {
      const result = await client.callTool({ name: 'queue_for_deletion', arguments: { ids: [target.id, shielded.id], gracePeriodDays: 3 } });
      expect(result.isError).toBeFalsy();
      const data = result.structuredContent as { queued: Array<{ id: number }>; skipped: Array<{ id: number; reason: string }> };
      expect(data.queued.map((q) => q.id)).toEqual([target.id]);
      expect(data.skipped[0]?.id).toBe(shielded.id);
      expect(data.skipped[0]?.reason).toMatch(/protected/i);

      const after = getMediaItemById(target.id)!;
      expect(after.status).toBe('pending_deletion');
      expect(after.delete_after).toBeTruthy();

      const queue = await client.callTool({ name: 'list_queue', arguments: {} });
      const listing = queue.structuredContent as { items: Array<{ mediaItemId: number; daysRemaining: number }> };
      const row = listing.items.find((i) => i.mediaItemId === target.id);
      expect(row?.daysRemaining).toBe(3);

      const removed = await client.callTool({ name: 'remove_from_queue', arguments: { queueIds: [String(target.id)] } });
      expect((removed.structuredContent as { removed: unknown[] }).removed).toHaveLength(1);
      expect(getMediaItemById(target.id)!.status).toBe('monitored');
    } finally {
      await client.close();
    }
  });

  it('refuses immediate deletion until the opt-in is set', async () => {
    const victim = seedMovie('Delete Me Now');
    const client = await connect();
    try {
      await client.callTool({ name: 'queue_for_deletion', arguments: { ids: [victim.id], gracePeriodDays: 0 } });

      const refused = await client.callTool({ name: 'delete_now', arguments: { queueId: String(victim.id) } });
      expect(refused.isError).toBe(true);
      expect(textOf(refused)).toMatch(/Allow immediate deletion/);
      expect(getMediaItemById(victim.id)!.status).toBe('pending_deletion');

      const dry = await client.callTool({ name: 'process_queue', arguments: {} });
      expect(dry.isError).toBeFalsy();
      expect((dry.structuredContent as { dryRun: boolean }).dryRun).toBe(true);
      expect(getMediaItemById(victim.id)!.status).toBe('pending_deletion');

      const realRefused = await client.callTool({ name: 'process_queue', arguments: { dryRun: false } });
      expect(realRefused.isError).toBe(true);

      settingsRepo.set({ key: MCP_SETTING_ALLOW_IMMEDIATE_DELETION, value: 'true' });

      // With the opt-in set, Archive's hold is the next gate: the item has no
      // verdict yet, so Delete Now is refused until it has one.
      const held = await client.callTool({ name: 'delete_now', arguments: { queueId: String(victim.id) } });
      expect(held.isError).toBe(true);
      expect(textOf(held)).toMatch(/held by Archive/);
      updateMediaItem(victim.id, { availability: JSON.stringify({ verdict: 'replaceable', reasons: [], checkedAt: new Date().toISOString(), service: 'radarr', releases: 4, best: null, current: null }) });

      const allowed = await client.callTool({ name: 'delete_now', arguments: { queueId: String(victim.id) } });
      expect(allowed.isError).toBeFalsy();
      expect(textOf(allowed)).toContain('Delete Me Now');
    } finally {
      await client.close();
    }
  });

  it('previews and creates rules', async () => {
    seedMovie('Never Watched Old Movie', { play_count: 0 });
    const client = await connect();
    try {
      const root = {
        kind: 'group',
        logic: 'AND',
        children: [
          { kind: 'condition', field: 'never_watched', operator: 'equals', value: true },
          { kind: 'condition', field: 'days_since_added', operator: 'greater_than', value: 30 },
        ],
      };
      const preview = await client.callTool({ name: 'preview_rule', arguments: { mediaType: 'movie', root } });
      expect(preview.isError).toBeFalsy();
      expect((preview.structuredContent as { totalMatches: number }).totalMatches).toBeGreaterThanOrEqual(1);

      const unsafe = await client.callTool({
        name: 'preview_rule',
        arguments: { root: { kind: 'condition', field: 'title', operator: 'regex_match', value: '(a+)+$' } },
      });
      expect(unsafe.isError).toBe(true);

      const created = await client.callTool({ name: 'create_rule', arguments: { name: 'Never watched via MCP', mediaType: 'movie', root, gracePeriodDays: 10 } });
      expect(created.isError).toBeFalsy();
      const rule = created.structuredContent as { id: number; enabled: boolean; gracePeriodDays: number; mediaType: string };
      expect(rule.enabled).toBe(true);
      expect(rule.gracePeriodDays).toBe(10);
      expect(rule.mediaType).toBe('movie');

      const toggled = await client.callTool({ name: 'set_rule_enabled', arguments: { id: rule.id, enabled: false } });
      expect((toggled.structuredContent as { enabled: boolean }).enabled).toBe(false);

      const schema = await client.callTool({ name: 'describe_rule_fields', arguments: {} });
      expect(textOf(schema)).toContain('days_since_watched');
    } finally {
      await client.close();
    }
  });

  it('returns a tool error rather than a protocol error when a tool fails', async () => {
    const client = await connect();
    try {
      const result = await client.callTool({ name: 'get_media_item', arguments: { id: 999999 } });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/not found/);
    } finally {
      await client.close();
    }
  });
});
