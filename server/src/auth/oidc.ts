/**
 * OpenID Connect login (authorization code flow with PKCE).
 *
 * Written against Authentik but provider-neutral: discovery from the issuer,
 * a signed state + nonce + PKCE verifier kept server-side, the code exchanged
 * for tokens, and the ID token verified against the provider's JWKS with
 * Node's own crypto. Groups come from the configured claim on the ID token,
 * falling back to the userinfo endpoint when the provider leaves them out.
 */
import crypto from 'crypto';
import logger from '../utils/logger';
import { getAuthConfig, normalizeIssuer, type OidcConfig } from './config';

// ============================================================================
// Types
// ============================================================================

export interface DiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
  end_session_endpoint?: string;
  id_token_signing_alg_values_supported?: string[];
}

export interface Jwk {
  kty: string;
  kid?: string;
  alg?: string;
  use?: string;
  [key: string]: unknown;
}

export interface JwtClaims {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
  nbf?: number;
  nonce?: string;
  azp?: string;
  [claim: string]: unknown;
}

export interface OidcIdentity {
  subject: string;
  username: string;
  displayName: string | null;
  email: string | null;
  groups: string[];
  claims: JwtClaims;
}

export class OidcError extends Error {
  constructor(
    public readonly code: 'state' | 'exchange' | 'token' | 'provider' | 'config',
    message: string
  ) {
    super(message);
  }
}

// ============================================================================
// Fetch helpers
// ============================================================================

const FETCH_TIMEOUT_MS = 10_000;

async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`${init.method ?? 'GET'} ${url} returned HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}`);
    }
    return JSON.parse(text) as T;
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================================
// Discovery and JWKS (cached)
// ============================================================================

const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const JWKS_TTL_MS = 60 * 60 * 1000;
const JWKS_MIN_REFRESH_MS = 60 * 1000;

let discoveryCache: { issuer: string; doc: DiscoveryDocument; fetchedAt: number } | null = null;
let jwksCache: { uri: string; keys: Jwk[]; fetchedAt: number } | null = null;

export function discoveryUrl(issuer: string): string {
  return `${normalizeIssuer(issuer)}/.well-known/openid-configuration`;
}

export async function getDiscovery(issuer: string): Promise<DiscoveryDocument> {
  const normalized = normalizeIssuer(issuer);
  if (discoveryCache && discoveryCache.issuer === normalized && Date.now() - discoveryCache.fetchedAt < DISCOVERY_TTL_MS) {
    return discoveryCache.doc;
  }
  let doc: DiscoveryDocument;
  try {
    doc = await fetchJson<DiscoveryDocument>(discoveryUrl(normalized), { headers: { Accept: 'application/json' } });
  } catch (error) {
    throw new OidcError('provider', `Could not load OpenID configuration from ${discoveryUrl(normalized)}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
    throw new OidcError('provider', 'OpenID configuration is missing authorization_endpoint, token_endpoint or jwks_uri');
  }
  discoveryCache = { issuer: normalized, doc, fetchedAt: Date.now() };
  return doc;
}

async function getJwks(uri: string, forceRefresh = false): Promise<Jwk[]> {
  const fresh = jwksCache && jwksCache.uri === uri && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS;
  const recentlyRefreshed = jwksCache && jwksCache.uri === uri && Date.now() - jwksCache.fetchedAt < JWKS_MIN_REFRESH_MS;
  if (jwksCache && jwksCache.uri === uri && (fresh && !forceRefresh || recentlyRefreshed)) {
    return jwksCache.keys;
  }
  let body: { keys?: Jwk[] };
  try {
    body = await fetchJson<{ keys?: Jwk[] }>(uri, { headers: { Accept: 'application/json' } });
  } catch (error) {
    if (jwksCache && jwksCache.uri === uri) return jwksCache.keys;
    throw new OidcError('provider', `Could not load signing keys from ${uri}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const keys = Array.isArray(body.keys) ? body.keys : [];
  jwksCache = { uri, keys, fetchedAt: Date.now() };
  return keys;
}

/** Test seam. */
export function resetOidcCaches(): void {
  discoveryCache = null;
  jwksCache = null;
  pendingLogins.clear();
}

// ============================================================================
// JWT verification (RS*, PS*, ES*, EdDSA) with node:crypto
// ============================================================================

function b64urlDecode(input: string): Buffer {
  return Buffer.from(input, 'base64url');
}

function verifySignature(alg: string, jwk: Jwk, signingInput: string, signature: Buffer): boolean {
  let key: crypto.KeyObject;
  try {
    key = crypto.createPublicKey({ key: jwk, format: 'jwk' } as unknown as crypto.JsonWebKeyInput);
  } catch {
    return false;
  }
  const data = Buffer.from(signingInput, 'utf8');
  try {
    switch (alg) {
      case 'RS256':
        return crypto.verify('sha256', data, key, signature);
      case 'RS384':
        return crypto.verify('sha384', data, key, signature);
      case 'RS512':
        return crypto.verify('sha512', data, key, signature);
      case 'PS256':
        return crypto.verify('sha256', data, { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST }, signature);
      case 'PS384':
        return crypto.verify('sha384', data, { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST }, signature);
      case 'PS512':
        return crypto.verify('sha512', data, { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST }, signature);
      case 'ES256':
        return crypto.verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, signature);
      case 'ES384':
        return crypto.verify('sha384', data, { key, dsaEncoding: 'ieee-p1363' }, signature);
      case 'ES512':
        return crypto.verify('sha512', data, { key, dsaEncoding: 'ieee-p1363' }, signature);
      case 'EdDSA':
        return crypto.verify(null, data, key, signature);
      default:
        return false;
    }
  } catch {
    return false;
  }
}

const ALG_KTY: Record<string, string> = {
  RS256: 'RSA', RS384: 'RSA', RS512: 'RSA',
  PS256: 'RSA', PS384: 'RSA', PS512: 'RSA',
  ES256: 'EC', ES384: 'EC', ES512: 'EC',
  EdDSA: 'OKP',
};

export interface VerifyOptions {
  issuer: string;
  audience: string;
  nonce?: string;
  /** Seconds of leeway on exp/nbf/iat. */
  clockToleranceSeconds?: number;
  now?: Date;
}

/**
 * Verify a compact JWS and its standard claims against a set of JWKs.
 * Throws an OidcError('token') with a reason on any failure.
 */
export function verifyJwt(token: string, keys: Jwk[], options: VerifyOptions): JwtClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new OidcError('token', 'ID token is not a compact JWS');
  const [h, p, s] = parts as [string, string, string];

  let header: { alg?: string; kid?: string; typ?: string };
  let payload: JwtClaims;
  try {
    header = JSON.parse(b64urlDecode(h).toString('utf8'));
    payload = JSON.parse(b64urlDecode(p).toString('utf8'));
  } catch {
    throw new OidcError('token', 'ID token header or payload is not valid JSON');
  }

  const alg = header.alg ?? '';
  const wantKty = ALG_KTY[alg];
  if (!wantKty) throw new OidcError('token', `Unsupported or forbidden ID token algorithm "${alg}"`);

  const candidates = keys.filter((k) => k.kty === wantKty && (!header.kid || k.kid === header.kid) && (!k.use || k.use === 'sig') && (!k.alg || k.alg === alg));
  if (candidates.length === 0) throw new OidcError('token', `No signing key matches kid "${header.kid ?? '(none)'}"`);

  const signature = b64urlDecode(s);
  const signingInput = `${h}.${p}`;
  if (!candidates.some((jwk) => verifySignature(alg, jwk, signingInput, signature))) {
    throw new OidcError('token', 'ID token signature is invalid');
  }

  const tolerance = options.clockToleranceSeconds ?? 60;
  const nowSec = Math.floor((options.now ?? new Date()).getTime() / 1000);

  if (typeof payload.iss !== 'string' || normalizeIssuer(payload.iss) !== normalizeIssuer(options.issuer)) {
    throw new OidcError('token', `ID token issuer "${payload.iss ?? ''}" does not match ${options.issuer}`);
  }
  const audiences = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
  if (!audiences.includes(options.audience)) {
    throw new OidcError('token', 'ID token audience does not include this client');
  }
  if (audiences.length > 1 && payload.azp && payload.azp !== options.audience) {
    throw new OidcError('token', 'ID token authorized party does not match this client');
  }
  if (typeof payload.exp !== 'number' || payload.exp + tolerance <= nowSec) {
    throw new OidcError('token', 'ID token has expired');
  }
  if (typeof payload.nbf === 'number' && payload.nbf - tolerance > nowSec) {
    throw new OidcError('token', 'ID token is not yet valid');
  }
  if (typeof payload.iat === 'number' && payload.iat - tolerance > nowSec) {
    throw new OidcError('token', 'ID token was issued in the future');
  }
  if (options.nonce !== undefined && payload.nonce !== options.nonce) {
    throw new OidcError('token', 'ID token nonce does not match this login');
  }
  if (typeof payload.sub !== 'string' || !payload.sub) {
    throw new OidcError('token', 'ID token has no subject');
  }
  return payload;
}

// ============================================================================
// Claims → identity
// ============================================================================

/** Read a possibly dotted claim path ("realm_access.roles") from a claims object. */
export function readClaim(claims: Record<string, unknown>, path: string): unknown {
  if (path in claims) return claims[path];
  let current: unknown = claims;
  for (const segment of path.split('.')) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function groupsFromClaims(claims: Record<string, unknown>, groupsClaim: string): string[] | null {
  const raw = readClaim(claims, groupsClaim);
  if (raw === undefined || raw === null) return null;
  if (Array.isArray(raw)) return raw.map((g) => String(g)).filter((g) => g.length > 0);
  if (typeof raw === 'string') {
    return raw
      .split(/[,\s]+/)
      .map((g) => g.trim())
      .filter((g) => g.length > 0);
  }
  return null;
}

export function identityFromClaims(claims: JwtClaims, oidc: Pick<OidcConfig, 'groupsClaim' | 'usernameClaim'>, groups: string[]): OidcIdentity {
  const pick = (...names: string[]): string | null => {
    for (const name of names) {
      const value = readClaim(claims, name);
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return null;
  };
  const email = pick('email');
  const username = pick(oidc.usernameClaim, 'preferred_username', 'nickname', 'name') ?? email ?? String(claims.sub);
  return {
    subject: String(claims.sub),
    username,
    displayName: pick('name', 'given_name') ?? username,
    email,
    groups,
    claims,
  };
}

// ============================================================================
// Login flow
// ============================================================================

interface PendingLogin {
  nonce: string;
  codeVerifier: string;
  redirectUri: string;
  returnTo: string;
  createdAt: number;
}

const PENDING_TTL_MS = 10 * 60 * 1000;
const PENDING_MAX = 1000;
const pendingLogins = new Map<string, PendingLogin>();

function prunePending(): void {
  const cutoff = Date.now() - PENDING_TTL_MS;
  for (const [state, pending] of pendingLogins) {
    if (pending.createdAt < cutoff) pendingLogins.delete(state);
  }
  // Oldest-first eviction if someone is hammering the start endpoint.
  while (pendingLogins.size > PENDING_MAX) {
    const oldest = pendingLogins.keys().next().value;
    if (oldest === undefined) break;
    pendingLogins.delete(oldest);
  }
}

function requireOidc(): OidcConfig {
  const oidc = getAuthConfig().oidc;
  if (!oidc) throw new OidcError('config', 'Single sign-on is not configured');
  return oidc;
}

/** Build the provider redirect for a new login. */
export async function beginOidcLogin(input: { redirectUri: string; returnTo: string }): Promise<{ url: string; state: string }> {
  const oidc = requireOidc();
  const discovery = await getDiscovery(oidc.issuer);

  prunePending();
  const state = crypto.randomBytes(24).toString('base64url');
  const nonce = crypto.randomBytes(24).toString('base64url');
  const codeVerifier = crypto.randomBytes(48).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

  pendingLogins.set(state, { nonce, codeVerifier, redirectUri: input.redirectUri, returnTo: input.returnTo, createdAt: Date.now() });

  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', oidc.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('scope', oidc.scopes.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');

  return { url: url.toString(), state };
}

interface TokenResponse {
  id_token?: string;
  access_token?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

/** Finish a login from the provider's redirect. Returns who signed in and where to send them. */
export async function completeOidcLogin(input: { code: string; state: string }): Promise<{ identity: OidcIdentity; returnTo: string }> {
  const oidc = requireOidc();
  const pending = pendingLogins.get(input.state);
  pendingLogins.delete(input.state);
  if (!pending || Date.now() - pending.createdAt > PENDING_TTL_MS) {
    throw new OidcError('state', 'This login attempt has expired or was not started here. Please try again.');
  }

  const discovery = await getDiscovery(oidc.issuer);

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: pending.redirectUri,
    code_verifier: pending.codeVerifier,
  });
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };
  if (oidc.tokenAuthMethod === 'client_secret_post') {
    body.set('client_id', oidc.clientId);
    body.set('client_secret', oidc.clientSecret);
  } else {
    headers['Authorization'] = `Basic ${Buffer.from(`${encodeURIComponent(oidc.clientId)}:${encodeURIComponent(oidc.clientSecret)}`).toString('base64')}`;
  }

  let tokens: TokenResponse;
  try {
    tokens = await fetchJson<TokenResponse>(discovery.token_endpoint, { method: 'POST', headers, body: body.toString() });
  } catch (error) {
    throw new OidcError('exchange', `Token exchange failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (tokens.error) {
    throw new OidcError('exchange', `Token exchange failed: ${tokens.error}${tokens.error_description ? ` (${tokens.error_description})` : ''}`);
  }
  if (!tokens.id_token) {
    throw new OidcError('exchange', 'Token response contained no id_token');
  }

  // Verify, refreshing the key set once if the kid is unknown (key rotation).
  let claims: JwtClaims;
  try {
    claims = verifyJwt(tokens.id_token, await getJwks(discovery.jwks_uri), { issuer: oidc.issuer, audience: oidc.clientId, nonce: pending.nonce });
  } catch (error) {
    if (error instanceof OidcError && /No signing key/.test(error.message)) {
      claims = verifyJwt(tokens.id_token, await getJwks(discovery.jwks_uri, true), { issuer: oidc.issuer, audience: oidc.clientId, nonce: pending.nonce });
    } else {
      throw error;
    }
  }

  // Groups: ID token first, then userinfo. Authentik puts them on the ID token
  // when the profile scope is granted; other providers only expose them via
  // userinfo.
  let groups = groupsFromClaims(claims, oidc.groupsClaim);
  let mergedClaims: JwtClaims = claims;
  if (groups === null && discovery.userinfo_endpoint && tokens.access_token) {
    try {
      const userinfo = await fetchJson<Record<string, unknown>>(discovery.userinfo_endpoint, {
        headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json' },
      });
      if (userinfo['sub'] === claims.sub) {
        mergedClaims = { ...userinfo, ...claims };
        groups = groupsFromClaims(userinfo, oidc.groupsClaim);
      } else {
        logger.warn('OIDC userinfo subject did not match the ID token; ignoring userinfo');
      }
    } catch (error) {
      logger.warn(`OIDC userinfo request failed; continuing with ID token claims only: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    identity: identityFromClaims(mergedClaims, oidc, groups ?? []),
    returnTo: pending.returnTo,
  };
}

/** For the Settings panel: the configured endpoints, without secrets. */
export async function describeOidcProvider(): Promise<{ issuer: string; discovery: string; reachable: boolean; error?: string; endpoints?: Partial<DiscoveryDocument> }> {
  const oidc = requireOidc();
  try {
    const doc = await getDiscovery(oidc.issuer);
    return {
      issuer: oidc.issuer,
      discovery: discoveryUrl(oidc.issuer),
      reachable: true,
      endpoints: {
        authorization_endpoint: doc.authorization_endpoint,
        token_endpoint: doc.token_endpoint,
        userinfo_endpoint: doc.userinfo_endpoint,
        jwks_uri: doc.jwks_uri,
        end_session_endpoint: doc.end_session_endpoint,
      },
    };
  } catch (error) {
    return { issuer: oidc.issuer, discovery: discoveryUrl(oidc.issuer), reachable: false, error: error instanceof Error ? error.message : String(error) };
  }
}
