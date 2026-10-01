/**
 * Login sessions.
 *
 * A session is a row in `auth_sessions`; the browser holds only a signed
 * session id in an HttpOnly cookie. Signing means a forged or truncated cookie
 * is rejected before the database is consulted, and rotating the secret
 * logs everyone out at once.
 */
import crypto from 'crypto';
import type { Request, Response } from 'express';
import { getDatabase } from '../db';
import settingsRepo from '../db/repositories/settings';
import logger from '../utils/logger';
import { getAuthConfig, type Role } from './config';

export const SESSION_COOKIE = 'prunerr_session';
const SECRET_SETTING = 'auth_session_secret';
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export type AuthProvider = 'oidc' | 'local';

export interface SessionUser {
  /** Stable identity: `oidc:<sub>` or `local:<username>`. */
  key: string;
  username: string;
  displayName: string | null;
  email: string | null;
  role: Role;
  provider: AuthProvider;
  groups: string[];
}

export interface AuthSession extends SessionUser {
  id: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
}

interface SessionRow {
  id: string;
  user_key: string;
  username: string;
  display_name: string | null;
  email: string | null;
  role: string;
  provider: string;
  groups: string | null;
  created_at: string;
  expires_at: string;
  last_seen_at: string;
}

function rowToSession(row: SessionRow): AuthSession {
  let groups: string[] = [];
  if (row.groups) {
    try {
      const parsed = JSON.parse(row.groups);
      if (Array.isArray(parsed)) groups = parsed.map(String);
    } catch {
      groups = [];
    }
  }
  return {
    id: row.id,
    key: row.user_key,
    username: row.username,
    displayName: row.display_name,
    email: row.email,
    role: row.role as Role,
    provider: row.provider as AuthProvider,
    groups,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastSeenAt: row.last_seen_at,
  };
}

// ============================================================================
// Secret
// ============================================================================

let cachedSecret: string | null = null;

/**
 * The cookie-signing secret: AUTH_SESSION_SECRET when set, otherwise one
 * generated on first use and kept in the settings table so it survives
 * restarts (and so a restored backup keeps its logins).
 */
export function getSessionSecret(): string {
  if (cachedSecret) return cachedSecret;
  const fromEnv = getAuthConfig().sessionSecret;
  if (fromEnv) {
    cachedSecret = fromEnv;
    return cachedSecret;
  }
  const stored = settingsRepo.getValue(SECRET_SETTING);
  if (stored) {
    cachedSecret = stored;
    return cachedSecret;
  }
  const generated = crypto.randomBytes(32).toString('hex');
  settingsRepo.set({ key: SECRET_SETTING, value: generated });
  cachedSecret = generated;
  logger.info('Generated a new session signing secret');
  return generated;
}

/** Test seam. */
export function resetSessionSecretCache(): void {
  cachedSecret = null;
}

function sign(id: string): string {
  return crypto.createHmac('sha256', getSessionSecret()).update(id).digest('base64url');
}

function encodeToken(id: string): string {
  return `${id}.${sign(id)}`;
}

/** The session id inside a token, or null when the signature does not match. */
export function decodeToken(token: string): string | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const id = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]{20,}$/.test(id)) return null;
  const expected = sign(id);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  return crypto.timingSafeEqual(a, b) ? id : null;
}

// ============================================================================
// Store
// ============================================================================

export function createSession(user: SessionUser, ttlHours: number = getAuthConfig().sessionTtlHours): { token: string; session: AuthSession } {
  const db = getDatabase();
  const id = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  const expires = new Date(now.getTime() + ttlHours * 60 * 60 * 1000);

  db.prepare(
    `INSERT INTO auth_sessions (id, user_key, username, display_name, email, role, provider, groups, created_at, expires_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    user.key,
    user.username,
    user.displayName,
    user.email,
    user.role,
    user.provider,
    JSON.stringify(user.groups),
    now.toISOString(),
    expires.toISOString(),
    now.toISOString()
  );

  const session: AuthSession = {
    ...user,
    id,
    createdAt: now.toISOString(),
    expiresAt: expires.toISOString(),
    lastSeenAt: now.toISOString(),
  };
  return { token: encodeToken(id), session };
}

export function getSessionById(id: string): AuthSession | null {
  const row = getDatabase().prepare<[string], SessionRow>('SELECT * FROM auth_sessions WHERE id = ?').get(id);
  if (!row) return null;
  const session = rowToSession(row);
  if (new Date(session.expiresAt).getTime() <= Date.now()) {
    deleteSession(id);
    return null;
  }
  return session;
}

/** Resolve a cookie token to a live session, refreshing last_seen occasionally. */
export function readSession(token: string): AuthSession | null {
  const id = decodeToken(token);
  if (!id) return null;
  const session = getSessionById(id);
  if (!session) return null;

  if (Date.now() - new Date(session.lastSeenAt).getTime() > TOUCH_INTERVAL_MS) {
    const now = new Date().toISOString();
    getDatabase().prepare('UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?').run(now, id);
    session.lastSeenAt = now;
  }
  return session;
}

export function deleteSession(id: string): void {
  getDatabase().prepare('DELETE FROM auth_sessions WHERE id = ?').run(id);
}

export function deleteSessionsForUser(userKey: string): number {
  return getDatabase().prepare('DELETE FROM auth_sessions WHERE user_key = ?').run(userKey).changes;
}

export function purgeExpiredSessions(): number {
  const changes = getDatabase().prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(new Date().toISOString()).changes;
  if (changes > 0) logger.debug(`Purged ${changes} expired login session(s)`);
  return changes;
}

export function countSessions(): number {
  return getDatabase().prepare<[], { count: number }>('SELECT COUNT(*) as count FROM auth_sessions').get()?.count ?? 0;
}

// ============================================================================
// Cookies
// ============================================================================

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

/** Whether the client reached us over HTTPS, directly or through a proxy. */
export function requestIsSecure(req: Request): boolean {
  const forwarded = req.headers['x-forwarded-proto'];
  if (typeof forwarded === 'string' && forwarded.split(',')[0]?.trim().toLowerCase() === 'https') return true;
  return req.secure || req.protocol === 'https';
}

function cookieSecureFor(req: Request): boolean {
  const setting = getAuthConfig().cookieSecure;
  return setting === 'auto' ? requestIsSecure(req) : setting;
}

export function setSessionCookie(req: Request, res: Response, token: string, expiresAt: string): void {
  const maxAge = Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (cookieSecureFor(req)) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(req: Request, res: Response): void {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (cookieSecureFor(req)) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

/** The live session on a request, or null. */
export function sessionFromRequest(req: Request): AuthSession | null {
  const cookies = parseCookies(req.headers['cookie']);
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  try {
    return readSession(token);
  } catch (error) {
    logger.warn('Failed to read session:', error);
    return null;
  }
}
