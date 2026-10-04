/**
 * Prunerr as an OAuth 2.1 authorization server, for MCP clients.
 *
 * Hosted MCP clients (claude.ai, Claude Desktop connectors, ChatGPT, …)
 * cannot be given an API-key header. They follow the MCP authorization spec
 * instead: read `/.well-known/oauth-protected-resource`, register themselves
 * (RFC 7591), send the user through `/oauth/authorize`, exchange the code
 * for tokens with PKCE, and present the access token as a Bearer header.
 *
 * The user signs in with Prunerr's normal login (so Authentik users go
 * through Authentik and get their mapped role), approves the client once,
 * and the token carries that role. Everything is stored in SQLite; tokens
 * and codes are stored hashed.
 */
import crypto from 'crypto';
import { getDatabase } from '../db';
import logger from '../utils/logger';
import type { Role } from './config';

// ============================================================================
// Types
// ============================================================================

export interface OAuthClient {
  client_id: string;
  client_secret_hash: string | null;
  client_name: string | null;
  redirect_uris: string[];
  token_endpoint_auth_method: 'none' | 'client_secret_post' | 'client_secret_basic';
  created_at: string;
}

export interface TokenUser {
  key: string;
  username: string;
  role: Role;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
}

export interface ResolvedAccessToken extends TokenUser {
  clientId: string;
  scope: string;
  expiresAt: string;
}

export class OAuthError extends Error {
  constructor(
    public readonly code:
      | 'invalid_request'
      | 'invalid_client'
      | 'invalid_grant'
      | 'unauthorized_client'
      | 'unsupported_grant_type'
      | 'invalid_scope'
      | 'access_denied'
      | 'server_error',
    description: string,
    public readonly status: number = 400
  ) {
    super(description);
  }
}

export const SCOPE = 'prunerr';
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const CODE_TTL_MS = 10 * 60 * 1000;

// ============================================================================
// Helpers
// ============================================================================

function token(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(32).toString('base64url')}`;
}

export function hashToken(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function nowIso(): string {
  return new Date().toISOString();
}

function futureIso(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

/** PKCE S256: base64url(sha256(verifier)) must equal the challenge. */
export function verifyPkce(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const computed = crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');
  const a = Buffer.from(computed);
  const b = Buffer.from(challenge);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Redirect URIs a client may register. HTTPS anywhere, or plain HTTP only on
 * the local machine (desktop clients listening on a loopback port).
 */
export function isAcceptableRedirectUri(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.hash) return false;
  if (parsed.protocol === 'https:') return true;
  if (parsed.protocol === 'http:') {
    return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
  }
  // Custom schemes (e.g. app://callback) are allowed for native clients.
  return /^[a-z][a-z0-9+.-]*:$/i.test(parsed.protocol) && parsed.protocol !== 'javascript:' && parsed.protocol !== 'data:';
}

// ============================================================================
// Clients (RFC 7591 dynamic registration)
// ============================================================================

interface ClientRow {
  client_id: string;
  client_secret_hash: string | null;
  client_name: string | null;
  redirect_uris: string;
  token_endpoint_auth_method: string;
  created_at: string;
}

function rowToClient(row: ClientRow): OAuthClient {
  let uris: string[] = [];
  try {
    const parsed = JSON.parse(row.redirect_uris);
    if (Array.isArray(parsed)) uris = parsed.map(String);
  } catch {
    uris = [];
  }
  return {
    client_id: row.client_id,
    client_secret_hash: row.client_secret_hash,
    client_name: row.client_name,
    redirect_uris: uris,
    token_endpoint_auth_method: row.token_endpoint_auth_method as OAuthClient['token_endpoint_auth_method'],
    created_at: row.created_at,
  };
}

export interface RegisterClientInput {
  redirect_uris: string[];
  client_name?: string | null;
  token_endpoint_auth_method?: string | null;
  grant_types?: string[] | null;
  response_types?: string[] | null;
}

export function registerClient(input: RegisterClientInput): { client: OAuthClient; clientSecret: string | null } {
  if (!Array.isArray(input.redirect_uris) || input.redirect_uris.length === 0) {
    throw new OAuthError('invalid_request', 'redirect_uris is required');
  }
  if (input.redirect_uris.length > 20) {
    throw new OAuthError('invalid_request', 'Too many redirect_uris');
  }
  for (const uri of input.redirect_uris) {
    if (typeof uri !== 'string' || !isAcceptableRedirectUri(uri)) {
      throw new OAuthError('invalid_request', `Unacceptable redirect_uri: ${String(uri)}`);
    }
  }
  const grantTypes = input.grant_types ?? ['authorization_code'];
  for (const grant of grantTypes) {
    if (grant !== 'authorization_code' && grant !== 'refresh_token') {
      throw new OAuthError('invalid_request', `Unsupported grant_type: ${grant}`);
    }
  }
  const responseTypes = input.response_types ?? ['code'];
  if (responseTypes.some((r) => r !== 'code')) {
    throw new OAuthError('invalid_request', 'Only response_type "code" is supported');
  }

  const requestedMethod = input.token_endpoint_auth_method ?? 'client_secret_basic';
  if (!['none', 'client_secret_post', 'client_secret_basic'].includes(requestedMethod)) {
    throw new OAuthError('invalid_request', `Unsupported token_endpoint_auth_method: ${requestedMethod}`);
  }
  const method = requestedMethod as OAuthClient['token_endpoint_auth_method'];

  const clientId = token('prn_ci');
  const clientSecret = method === 'none' ? null : token('prn_cs');
  const name = typeof input.client_name === 'string' ? input.client_name.trim().slice(0, 120) || null : null;
  const createdAt = nowIso();

  getDatabase()
    .prepare(
      `INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris, token_endpoint_auth_method, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(clientId, clientSecret ? hashToken(clientSecret) : null, name, JSON.stringify(input.redirect_uris), method, createdAt);

  logger.info(`OAuth client registered: ${name ?? clientId}`);

  return {
    client: {
      client_id: clientId,
      client_secret_hash: clientSecret ? hashToken(clientSecret) : null,
      client_name: name,
      redirect_uris: input.redirect_uris,
      token_endpoint_auth_method: method,
      created_at: createdAt,
    },
    clientSecret,
  };
}

export function getClient(clientId: string): OAuthClient | null {
  const row = getDatabase().prepare<[string], ClientRow>('SELECT * FROM oauth_clients WHERE client_id = ?').get(clientId);
  return row ? rowToClient(row) : null;
}

export function listClients(): OAuthClient[] {
  return getDatabase().prepare<[], ClientRow>('SELECT * FROM oauth_clients ORDER BY created_at DESC').all().map(rowToClient);
}

export function deleteClient(clientId: string): boolean {
  const db = getDatabase();
  db.prepare('DELETE FROM oauth_tokens WHERE client_id = ?').run(clientId);
  db.prepare('DELETE FROM oauth_consents WHERE client_id = ?').run(clientId);
  return db.prepare('DELETE FROM oauth_clients WHERE client_id = ?').run(clientId).changes > 0;
}

/** Authenticate a client at the token endpoint. Public clients need PKCE instead. */
export function authenticateClient(client: OAuthClient, providedSecret: string | null): void {
  if (client.token_endpoint_auth_method === 'none') {
    return;
  }
  if (!providedSecret || !client.client_secret_hash) {
    throw new OAuthError('invalid_client', 'Client authentication failed', 401);
  }
  const a = Buffer.from(hashToken(providedSecret));
  const b = Buffer.from(client.client_secret_hash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new OAuthError('invalid_client', 'Client authentication failed', 401);
  }
}

// ============================================================================
// Consent
// ============================================================================

export function hasConsent(userKey: string, clientId: string): boolean {
  const row = getDatabase()
    .prepare<[string, string], { c: number }>('SELECT COUNT(*) as c FROM oauth_consents WHERE user_key = ? AND client_id = ?')
    .get(userKey, clientId);
  return (row?.c ?? 0) > 0;
}

export function recordConsent(userKey: string, clientId: string): void {
  getDatabase()
    .prepare('INSERT OR REPLACE INTO oauth_consents (user_key, client_id, created_at) VALUES (?, ?, ?)')
    .run(userKey, clientId, nowIso());
}

export function revokeConsent(userKey: string, clientId: string): void {
  const db = getDatabase();
  db.prepare('DELETE FROM oauth_consents WHERE user_key = ? AND client_id = ?').run(userKey, clientId);
  db.prepare('DELETE FROM oauth_tokens WHERE user_key = ? AND client_id = ?').run(userKey, clientId);
}

// ============================================================================
// Authorization codes
// ============================================================================

export interface CreateCodeInput {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  user: TokenUser;
  resource: string | null;
}

export function createAuthorizationCode(input: CreateCodeInput): string {
  const code = token('prn_ac');
  getDatabase()
    .prepare(
      `INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, code_challenge, scope, user_key, username, role, resource, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      hashToken(code),
      input.clientId,
      input.redirectUri,
      input.codeChallenge,
      input.scope,
      input.user.key,
      input.user.username,
      input.user.role,
      input.resource,
      new Date(Date.now() + CODE_TTL_MS).toISOString(),
      nowIso()
    );
  return code;
}

interface CodeRow {
  code_hash: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scope: string;
  user_key: string;
  username: string;
  role: string;
  resource: string | null;
  expires_at: string;
}

/** One-shot: the code is deleted whether or not it turns out to be valid. */
export function consumeAuthorizationCode(code: string): CodeRow | null {
  const db = getDatabase();
  const hash = hashToken(code);
  const row = db.prepare<[string], CodeRow>('SELECT * FROM oauth_codes WHERE code_hash = ?').get(hash);
  db.prepare('DELETE FROM oauth_codes WHERE code_hash = ?').run(hash);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;
  return row;
}

// ============================================================================
// Tokens
// ============================================================================

interface TokenRow {
  token_hash: string;
  kind: 'access' | 'refresh';
  pair_id: string;
  client_id: string;
  user_key: string;
  username: string;
  role: string;
  scope: string;
  resource: string | null;
  expires_at: string;
  created_at: string;
}

export function issueTokens(input: { clientId: string; user: TokenUser; scope: string; resource: string | null }): IssuedTokens {
  const db = getDatabase();
  const pairId = crypto.randomBytes(16).toString('hex');
  const accessToken = token('prn_at');
  const refreshToken = token('prn_rt');
  const insert = db.prepare(
    `INSERT INTO oauth_tokens (token_hash, kind, pair_id, client_id, user_key, username, role, scope, resource, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const createdAt = nowIso();
  db.transaction(() => {
    insert.run(hashToken(accessToken), 'access', pairId, input.clientId, input.user.key, input.user.username, input.user.role, input.scope, input.resource, futureIso(ACCESS_TOKEN_TTL_SECONDS), createdAt);
    insert.run(hashToken(refreshToken), 'refresh', pairId, input.clientId, input.user.key, input.user.username, input.user.role, input.scope, input.resource, futureIso(REFRESH_TOKEN_TTL_SECONDS), createdAt);
  })();
  return { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS, scope: input.scope };
}

/** Rotate: the old pair is revoked and a new one issued. */
export function refreshTokens(refreshToken: string, clientId: string): IssuedTokens | null {
  const db = getDatabase();
  const row = db
    .prepare<[string], TokenRow>("SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'")
    .get(hashToken(refreshToken));
  if (!row) return null;
  // A reused or foreign refresh token revokes the whole family.
  db.prepare('DELETE FROM oauth_tokens WHERE pair_id = ?').run(row.pair_id);
  if (row.client_id !== clientId) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;
  return issueTokens({
    clientId,
    user: { key: row.user_key, username: row.username, role: row.role as Role },
    scope: row.scope,
    resource: row.resource,
  });
}

export function resolveAccessToken(accessToken: string): ResolvedAccessToken | null {
  const row = getDatabase()
    .prepare<[string], TokenRow>("SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'access'")
    .get(hashToken(accessToken));
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;
  return {
    key: row.user_key,
    username: row.username,
    role: row.role as Role,
    clientId: row.client_id,
    scope: row.scope,
    expiresAt: row.expires_at,
  };
}

/** RFC 7009: revoking either token of a pair revokes both. */
export function revokeToken(value: string): void {
  const db = getDatabase();
  const row = db.prepare<[string], { pair_id: string }>('SELECT pair_id FROM oauth_tokens WHERE token_hash = ?').get(hashToken(value));
  if (row) db.prepare('DELETE FROM oauth_tokens WHERE pair_id = ?').run(row.pair_id);
}

export function purgeExpiredOAuth(): void {
  const db = getDatabase();
  const now = nowIso();
  db.prepare('DELETE FROM oauth_codes WHERE expires_at <= ?').run(now);
  db.prepare("DELETE FROM oauth_tokens WHERE kind = 'refresh' AND expires_at <= ?").run(now);
  // Access tokens whose refresh twin is gone are dead weight.
  db.prepare("DELETE FROM oauth_tokens WHERE kind = 'access' AND expires_at <= ? AND pair_id NOT IN (SELECT pair_id FROM oauth_tokens WHERE kind = 'refresh')").run(now);
}

export function countActiveTokens(): number {
  return (
    getDatabase()
      .prepare<[string], { c: number }>("SELECT COUNT(*) as c FROM oauth_tokens WHERE kind = 'refresh' AND expires_at > ?")
      .get(nowIso())?.c ?? 0
  );
}

// ============================================================================
// Pending authorizations (between the authorize request and the consent click)
// ============================================================================

export interface PendingAuthorization {
  id: string;
  clientId: string;
  clientName: string | null;
  redirectUri: string;
  scope: string;
  state: string | null;
  codeChallenge: string;
  resource: string | null;
  userKey: string;
  createdAt: number;
}

const pending = new Map<string, PendingAuthorization>();
const PENDING_TTL_MS = 10 * 60 * 1000;

export function storePendingAuthorization(input: Omit<PendingAuthorization, 'id' | 'createdAt'>): PendingAuthorization {
  const cutoff = Date.now() - PENDING_TTL_MS;
  for (const [id, entry] of pending) if (entry.createdAt < cutoff) pending.delete(id);
  const entry: PendingAuthorization = { ...input, id: crypto.randomBytes(24).toString('base64url'), createdAt: Date.now() };
  pending.set(entry.id, entry);
  return entry;
}

export function takePendingAuthorization(id: string): PendingAuthorization | null {
  const entry = pending.get(id);
  pending.delete(id);
  if (!entry || Date.now() - entry.createdAt > PENDING_TTL_MS) return null;
  return entry;
}

// ============================================================================
// Metadata documents
// ============================================================================

export function protectedResourceMetadata(baseUrl: string) {
  return {
    resource: `${baseUrl}/mcp`,
    authorization_servers: [baseUrl],
    bearer_methods_supported: ['header'],
    scopes_supported: [SCOPE],
    resource_name: 'Prunerr',
    resource_documentation: 'https://github.com/McGeaverBeaver/prunerr/blob/main/docs/mcp.md',
  };
}

export function authorizationServerMetadata(baseUrl: string) {
  return {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    registration_endpoint: `${baseUrl}/oauth/register`,
    revocation_endpoint: `${baseUrl}/oauth/revoke`,
    scopes_supported: [SCOPE],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
    revocation_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
    code_challenge_methods_supported: ['S256'],
    service_documentation: 'https://github.com/McGeaverBeaver/prunerr/blob/main/docs/mcp.md',
  };
}
