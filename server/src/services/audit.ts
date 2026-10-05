/**
 * The audit log: who changed what, in a form that cannot be quietly edited.
 *
 * Every entry carries an HMAC-SHA256 over its own content and the previous
 * entry's hash, so the table is a chain: alter or remove any row and every
 * hash after it stops matching. Nothing updates or deletes rows (there is no
 * route or tool for it, and retention never touches the table). The key is
 * AUDIT_SECRET from the environment or, failing that, a random secret kept
 * in a file beside the database, so a copy of the database alone cannot be
 * rewritten and re-chained. The newest hash is also written to an anchor
 * file beside the database after every entry, so a chain rebuilt from
 * scratch does not match the anchor either.
 *
 * What this does and does not promise: tampering is detectable, and without
 * the secret it is not forgeable. Someone with root on the box and the secret
 * can still rewrite history; no log stored on the same machine can prevent
 * that. The daily verification (scheduler task verifyAuditLog) and stack
 * health surface a broken chain as a critical finding.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Request, Response } from 'express';
import config from '../config';
import { getDatabase } from '../db';
import logger from '../utils/logger';
import { getRequestAuth } from '../auth/middleware';

export type AuditActorType = 'user' | 'apiKey' | 'mcp' | 'scheduler' | 'rule' | 'system';
export type AuditSource = 'web' | 'api' | 'mcp' | 'scheduler' | 'system';

export interface AuditActor {
  type: AuditActorType;
  name: string;
  /** Stable identity when known: the session's user key, the rule id, the tool name. */
  id?: string | null;
  role?: string | null;
}

export interface AuditInput {
  action: string;
  actor: AuditActor;
  source?: AuditSource;
  targetType?: string | null;
  targetId?: string | number | null;
  targetTitle?: string | null;
  /** Anything worth keeping about the change. Secrets must be redacted by the caller. */
  details?: Record<string, unknown> | null;
  ip?: string | null;
}

export interface AuditEntry {
  id: number;
  at: string;
  actorType: AuditActorType;
  actorName: string;
  actorId: string | null;
  actorRole: string | null;
  source: AuditSource;
  action: string;
  targetType: string | null;
  targetId: string | null;
  targetTitle: string | null;
  details: Record<string, unknown> | null;
  ip: string | null;
  prevHash: string | null;
  hash: string;
}

interface AuditRow {
  id: number;
  at: string;
  actor_type: string;
  actor_name: string;
  actor_id: string | null;
  actor_role: string | null;
  source: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  target_title: string | null;
  details: string | null;
  ip: string | null;
  prev_hash: string | null;
  hash: string;
}

const GENESIS = 'genesis';
const SECRET_FILE = 'audit.secret';
const ANCHOR_FILE = 'audit.anchor.json';

let secretCache: string | null = null;

function dataDir(): string {
  return path.dirname(path.resolve(config.dbPath));
}

/** Tests only. */
export function resetAuditSecretCache(): void {
  secretCache = null;
}

/**
 * The HMAC key. AUDIT_SECRET wins; otherwise a random secret is created once
 * in a mode-600 file beside the database. Losing that file does not lose the
 * log, but the chain can no longer be verified, so back it up with the data
 * directory.
 */
export function getAuditSecret(): string {
  if (secretCache) return secretCache;
  const fromEnv = process.env['AUDIT_SECRET']?.trim();
  if (fromEnv) {
    secretCache = fromEnv;
    return secretCache;
  }
  const file = path.join(dataDir(), SECRET_FILE);
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) {
      secretCache = existing;
      return secretCache;
    }
  } catch {
    /* created below */
  }
  const generated = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(file, `${generated}\n`, { mode: 0o600 });
    logger.info(`Audit log secret created at ${file}; set AUDIT_SECRET to manage it yourself`);
  } catch (error) {
    logger.warn(`Could not write the audit secret file (${(error as Error).message}); the chain will not verify across restarts unless AUDIT_SECRET is set`);
  }
  secretCache = generated;
  return secretCache;
}

function canonical(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

type Hashable = Omit<AuditRow, 'id' | 'hash'>;

export function computeHash(row: Hashable, secret: string = getAuditSecret()): string {
  const payload = canonical({
    prev: row.prev_hash ?? GENESIS,
    at: row.at,
    actorType: row.actor_type,
    actorName: row.actor_name,
    actorId: row.actor_id,
    actorRole: row.actor_role,
    source: row.source,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    targetTitle: row.target_title,
    details: row.details,
    ip: row.ip,
  });
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function rowToEntry(row: AuditRow): AuditEntry {
  let details: Record<string, unknown> | null = null;
  if (row.details) {
    try {
      details = JSON.parse(row.details);
    } catch {
      details = { raw: row.details };
    }
  }
  return {
    id: row.id,
    at: row.at,
    actorType: row.actor_type as AuditActorType,
    actorName: row.actor_name,
    actorId: row.actor_id,
    actorRole: row.actor_role,
    source: row.source as AuditSource,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    targetTitle: row.target_title,
    details,
    ip: row.ip,
    prevHash: row.prev_hash,
    hash: row.hash,
  };
}

function writeAnchor(id: number, hash: string, at: string): void {
  try {
    fs.writeFileSync(path.join(dataDir(), ANCHOR_FILE), JSON.stringify({ id, hash, at }), { mode: 0o600 });
  } catch (error) {
    logger.debug(`Could not write the audit anchor: ${(error as Error).message}`);
  }
}

export function readAnchor(): { id: number; hash: string; at: string } | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dataDir(), ANCHOR_FILE), 'utf8'));
    return parsed && typeof parsed.id === 'number' && typeof parsed.hash === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/** Keys whose values never go into the log in the clear. */
const SECRET_KEY = /(apikey|api_key|token|password|secret|webhook)/i;

/** Fields of a `{ key, from, to }` change record that hold the value. */
const CHANGE_VALUE_FIELDS = new Set(['from', 'to', 'value', 'before', 'after']);

/**
 * Replace secret-looking values with a marker; everything else passes
 * through. A property named like a secret is redacted; so are the value
 * fields of a change record whose `key` is named like one.
 */
export function redact<T>(value: T, keyHint: string = ''): T {
  if (SECRET_KEY.test(keyHint)) return (value === null || value === undefined || value === '' ? value : '[redacted]') as T;
  if (Array.isArray(value)) return value.map((v) => redact(v)) as T;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const secretRecord = typeof obj['key'] === 'string' && SECRET_KEY.test(obj['key']);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = redact(v, secretRecord && CHANGE_VALUE_FIELDS.has(k) ? obj['key'] as string : k);
    return out as T;
  }
  return value;
}

/**
 * Append one entry. Synchronous (better-sqlite3), so two writers cannot
 * interleave and break the chain. Never throws: a failure to audit is logged,
 * never allowed to stop the action being audited.
 */
export function recordAudit(input: AuditInput): AuditEntry | null {
  try {
    const db = getDatabase();
    const at = new Date().toISOString();
    const details = input.details ? JSON.stringify(redact(input.details)) : null;
    const insert = db.transaction(() => {
      const last = db.prepare<[], { hash: string } | undefined>('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1').get();
      const row: Hashable = {
        at,
        actor_type: input.actor.type,
        actor_name: input.actor.name,
        actor_id: input.actor.id ?? null,
        actor_role: input.actor.role ?? null,
        source: input.source ?? sourceFor(input.actor.type),
        action: input.action,
        target_type: input.targetType ?? null,
        target_id: input.targetId === null || input.targetId === undefined ? null : String(input.targetId),
        target_title: input.targetTitle ?? null,
        details,
        ip: input.ip ?? null,
        prev_hash: last?.hash ?? null,
      };
      const hash = computeHash(row);
      const result = db
        .prepare(
          `INSERT INTO audit_log (at, actor_type, actor_name, actor_id, actor_role, source, action, target_type, target_id, target_title, details, ip, prev_hash, hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(row.at, row.actor_type, row.actor_name, row.actor_id, row.actor_role, row.source, row.action, row.target_type, row.target_id, row.target_title, row.details, row.ip, row.prev_hash, hash);
      return { id: Number(result.lastInsertRowid), hash };
    });
    const { id, hash } = insert();
    writeAnchor(id, hash, at);
    const row = db.prepare<[number], AuditRow>('SELECT * FROM audit_log WHERE id = ?').get(id);
    return row ? rowToEntry(row) : null;
  } catch (error) {
    logger.error(`Audit entry could not be written (${input.action}): ${(error as Error).message}`);
    return null;
  }
}

function sourceFor(type: AuditActorType): AuditSource {
  switch (type) {
    case 'apiKey':
      return 'api';
    case 'mcp':
      return 'mcp';
    case 'scheduler':
    case 'rule':
      return 'scheduler';
    case 'system':
      return 'system';
    default:
      return 'web';
  }
}

/** The actor behind an HTTP request: the signed-in user, the API key, or nobody (login off). */
export function actorFromRequest(req: Request, res: Response): AuditActor & { ip: string | null } {
  const ip = req.ip ?? null;
  const auth = getRequestAuth(res);
  if (auth?.kind === 'session') {
    return { type: 'user', name: auth.session.displayName || auth.session.username, id: auth.session.key, role: auth.session.role, ip };
  }
  if (auth?.kind === 'apiKey') return { type: 'apiKey', name: 'API key', id: null, role: 'admin', ip };
  return { type: 'user', name: 'anonymous (login off)', id: null, role: 'admin', ip };
}

/** Record an entry attributed to the request's actor. */
export function auditRequest(req: Request, res: Response, input: Omit<AuditInput, 'actor' | 'ip'>): AuditEntry | null {
  const { ip, ...actor } = actorFromRequest(req, res);
  return recordAudit({ ...input, actor, ip, source: actor.type === 'apiKey' ? 'api' : 'web' });
}

/** An actor given only by name, as the shared services receive it. */
export function namedActor(name: string | null | undefined, fallback: AuditActorType = 'system'): AuditActor {
  if (!name) return { type: fallback, name: fallback === 'scheduler' ? 'Scheduler' : 'System' };
  if (/^mcp\b/i.test(name)) return { type: 'mcp', name };
  if (/^(scheduler|scheduled|archive|automatic)/i.test(name)) return { type: 'scheduler', name };
  return { type: 'user', name };
}

export interface AuditListOptions {
  limit?: number;
  offset?: number;
  action?: string;
  actor?: string;
  search?: string;
  since?: string;
}

export function listAudit(options: AuditListOptions = {}): { entries: AuditEntry[]; total: number } {
  const db = getDatabase();
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (options.action) {
    where.push('action LIKE ?');
    params.push(`${options.action}%`);
  }
  if (options.actor) {
    where.push('(actor_name LIKE ? OR actor_id LIKE ?)');
    params.push(`%${options.actor}%`, `%${options.actor}%`);
  }
  if (options.search) {
    where.push('(target_title LIKE ? OR action LIKE ? OR details LIKE ?)');
    params.push(`%${options.search}%`, `%${options.search}%`, `%${options.search}%`);
  }
  if (options.since) {
    where.push('at >= ?');
    params.push(options.since);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare<(string | number)[], { count: number }>(`SELECT COUNT(*) as count FROM audit_log ${clause}`).get(...params)?.count ?? 0;
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
  const offset = Math.max(options.offset ?? 0, 0);
  const rows = db.prepare<(string | number)[], AuditRow>(`SELECT * FROM audit_log ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
  return { entries: rows.map(rowToEntry), total };
}

export function countAudit(): number {
  return getDatabase().prepare<[], { count: number }>('SELECT COUNT(*) as count FROM audit_log').get()?.count ?? 0;
}

/** Every entry oldest first, for export. */
export function* iterateAudit(): Generator<AuditEntry> {
  const stmt = getDatabase().prepare<[], AuditRow>('SELECT * FROM audit_log ORDER BY id ASC');
  for (const row of stmt.iterate()) yield rowToEntry(row);
}

export interface AuditVerification {
  ok: boolean;
  entries: number;
  checkedAt: string;
  /** The first entry whose hash does not match, or whose link to the previous entry is broken. */
  firstBreak: { id: number; at: string; reason: 'hash_mismatch' | 'chain_gap' } | null;
  anchor: { id: number; hash: string; at: string } | null;
  /** Whether the stored anchor agrees with the chain (null when no anchor exists yet). */
  anchorMatches: boolean | null;
  lastHash: string | null;
}

/**
 * Walk the whole chain and recompute every hash. Thousands of entries take
 * well under a second; the result is what the Audit page's Verify button,
 * the MCP tool, the daily task and stack health all show.
 */
export function verifyAuditChain(): AuditVerification {
  const db = getDatabase();
  const secret = getAuditSecret();
  const stmt = db.prepare<[], AuditRow>('SELECT * FROM audit_log ORDER BY id ASC');
  let prev: string | null = null;
  let entries = 0;
  let firstBreak: AuditVerification['firstBreak'] = null;
  let lastHash: string | null = null;
  const anchor = readAnchor();
  let anchorMatches: boolean | null = anchor ? false : null;
  for (const row of stmt.iterate()) {
    entries += 1;
    if (!firstBreak) {
      if ((row.prev_hash ?? null) !== prev) {
        firstBreak = { id: row.id, at: row.at, reason: 'chain_gap' };
      } else if (computeHash(row, secret) !== row.hash) {
        firstBreak = { id: row.id, at: row.at, reason: 'hash_mismatch' };
      }
    }
    if (anchor && row.id === anchor.id) anchorMatches = row.hash === anchor.hash;
    prev = row.hash;
    lastHash = row.hash;
  }
  return { ok: firstBreak === null && anchorMatches !== false, entries, checkedAt: new Date().toISOString(), firstBreak, anchor, anchorMatches, lastHash };
}

let lastVerification: AuditVerification | null = null;

/** The most recent verification, re-run when older than `maxAgeMs`. */
export function verifyAuditChainCached(maxAgeMs: number = 24 * 60 * 60 * 1000): AuditVerification {
  if (lastVerification && Date.now() - new Date(lastVerification.checkedAt).getTime() < maxAgeMs) return lastVerification;
  lastVerification = verifyAuditChain();
  return lastVerification;
}
