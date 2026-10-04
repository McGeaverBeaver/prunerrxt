/**
 * Who is using the API key, and whether it is being used at all.
 *
 * Every request that presents the key — REST calls with X-Api-Key and MCP
 * calls with either header — leaves one row here, including the ones that
 * were refused because the key was wrong or switched off. The Settings page
 * reads a summary of it: last use, request counts, the clients seen (user
 * agent and address) and the most recent requests.
 *
 * The web UI never sends the key, so nothing it does ends up in here.
 *
 * The table is pruned on the way in: rows older than RETENTION_DAYS go, and
 * the newest MAX_ROWS are kept beyond that, so a client polling every few
 * seconds cannot grow the database without bound.
 */
import { getDatabase } from '../db';
import logger from '../utils/logger';

export type ApiKeyUseOutcome = 'ok' | 'invalid' | 'disabled';
export type ApiKeyUseSource = 'api' | 'mcp';

export interface ApiKeyUse {
  outcome: ApiKeyUseOutcome;
  source: ApiKeyUseSource;
  method: string;
  path: string;
  ip?: string | null;
  userAgent?: string | null;
}

export interface ApiKeyUsageEntry {
  id: number;
  usedAt: string;
  outcome: ApiKeyUseOutcome;
  source: ApiKeyUseSource;
  method: string;
  path: string;
  ip: string | null;
  userAgent: string | null;
}

export interface ApiKeyUsageClient {
  userAgent: string | null;
  ip: string | null;
  requests: number;
  lastUsedAt: string;
}

export interface ApiKeyUsageSummary {
  /** When the key was last accepted, null if never. */
  lastUsedAt: string | null;
  /** Accepted requests, all time within retention. */
  totalRequests: number;
  /** Accepted requests in the last 24 hours. */
  requestsLast24h: number;
  /** Accepted requests in the last 7 days. */
  requestsLast7d: number;
  /** Refused requests (wrong key, or key switched off) in the last 24 hours. */
  refusedLast24h: number;
  /** When a wrong or disabled key was last presented, null if never. */
  lastRefusedAt: string | null;
  /** Distinct clients (user agent + address) that used the key, most recent first. */
  clients: ApiKeyUsageClient[];
  /** The most recent requests, newest first. */
  recent: ApiKeyUsageEntry[];
  /** How long rows are kept, so the page can say what "total" means. */
  retentionDays: number;
}

const RETENTION_DAYS = 30;
const MAX_ROWS = 5000;
const PRUNE_EVERY = 200;
const RECENT_LIMIT = 50;
const CLIENTS_LIMIT = 20;
const USER_AGENT_MAX = 200;
const PATH_MAX = 300;

let insertsSincePrune = 0;

interface UsageRow {
  id: number;
  used_at: string;
  outcome: ApiKeyUseOutcome;
  source: ApiKeyUseSource;
  method: string;
  path: string;
  ip: string | null;
  user_agent: string | null;
}

function toEntry(row: UsageRow): ApiKeyUsageEntry {
  return {
    id: row.id,
    usedAt: row.used_at,
    outcome: row.outcome,
    source: row.source,
    method: row.method,
    path: row.path,
    ip: row.ip,
    userAgent: row.user_agent,
  };
}

function clip(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  return value.length > max ? value.slice(0, max) : value;
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** Delete rows past retention and beyond the row cap. Cheap enough to run inline every PRUNE_EVERY inserts. */
export function pruneApiKeyUsage(): void {
  const db = getDatabase();
  db.prepare('DELETE FROM api_key_usage WHERE used_at < ?').run(isoDaysAgo(RETENTION_DAYS));
  db.prepare(
    'DELETE FROM api_key_usage WHERE id NOT IN (SELECT id FROM api_key_usage ORDER BY id DESC LIMIT ?)'
  ).run(MAX_ROWS);
}

/**
 * Record one request that presented the key. Never throws: a failure to
 * write the audit row must not fail the request it describes.
 */
export function recordApiKeyUse(use: ApiKeyUse): void {
  try {
    const db = getDatabase();
    db.prepare(
      `INSERT INTO api_key_usage (used_at, outcome, source, method, path, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      new Date().toISOString(),
      use.outcome,
      use.source,
      use.method.toUpperCase().slice(0, 10),
      clip(use.path, PATH_MAX) ?? '/',
      clip(use.ip, 64),
      clip(use.userAgent, USER_AGENT_MAX)
    );
    insertsSincePrune += 1;
    if (insertsSincePrune >= PRUNE_EVERY) {
      insertsSincePrune = 0;
      pruneApiKeyUsage();
    }
  } catch (error) {
    logger.debug(`Could not record API key use: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function getApiKeyUsageSummary(): ApiKeyUsageSummary {
  const db = getDatabase();
  const dayAgo = isoDaysAgo(1);
  const weekAgo = isoDaysAgo(7);

  const totals = db
    .prepare<[string, string, string], { total: number; last24h: number; last7d: number; refused24h: number; last_ok: string | null; last_refused: string | null }>(
      `SELECT
         SUM(CASE WHEN outcome = 'ok' THEN 1 ELSE 0 END) AS total,
         SUM(CASE WHEN outcome = 'ok' AND used_at >= ? THEN 1 ELSE 0 END) AS last24h,
         SUM(CASE WHEN outcome = 'ok' AND used_at >= ? THEN 1 ELSE 0 END) AS last7d,
         SUM(CASE WHEN outcome <> 'ok' AND used_at >= ? THEN 1 ELSE 0 END) AS refused24h,
         MAX(CASE WHEN outcome = 'ok' THEN used_at END) AS last_ok,
         MAX(CASE WHEN outcome <> 'ok' THEN used_at END) AS last_refused
       FROM api_key_usage`
    )
    .get(dayAgo, weekAgo, dayAgo);

  const clients = db
    .prepare<[number], { user_agent: string | null; ip: string | null; requests: number; last_used_at: string }>(
      `SELECT user_agent, ip, COUNT(*) AS requests, MAX(used_at) AS last_used_at
       FROM api_key_usage
       WHERE outcome = 'ok'
       GROUP BY user_agent, ip
       ORDER BY last_used_at DESC
       LIMIT ?`
    )
    .all(CLIENTS_LIMIT)
    .map((row) => ({ userAgent: row.user_agent, ip: row.ip, requests: row.requests, lastUsedAt: row.last_used_at }));

  const recent = db
    .prepare<[number], UsageRow>('SELECT * FROM api_key_usage ORDER BY id DESC LIMIT ?')
    .all(RECENT_LIMIT)
    .map(toEntry);

  return {
    lastUsedAt: totals?.last_ok ?? null,
    totalRequests: totals?.total ?? 0,
    requestsLast24h: totals?.last24h ?? 0,
    requestsLast7d: totals?.last7d ?? 0,
    refusedLast24h: totals?.refused24h ?? 0,
    lastRefusedAt: totals?.last_refused ?? null,
    clients,
    recent,
    retentionDays: RETENTION_DAYS,
  };
}

export function clearApiKeyUsage(): void {
  getDatabase().prepare('DELETE FROM api_key_usage').run();
  insertsSincePrune = 0;
}
