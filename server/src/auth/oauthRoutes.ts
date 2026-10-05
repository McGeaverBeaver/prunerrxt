/**
 * The OAuth 2.1 endpoints MCP clients talk to. Mounted at the app root
 * (not under /api) because the well-known paths are fixed by the spec.
 */
import { Router, type Request, type Response } from 'express';
import { getAuthConfig } from './config';
import { requestIsSecure, sessionFromRequest } from './sessions';
import {
  authenticateClient,
  authorizationServerMetadata,
  consumeAuthorizationCode,
  createAuthorizationCode,
  getClient,
  hasConsent,
  issueTokens,
  OAuthError,
  protectedResourceMetadata,
  recordConsent,
  refreshTokens,
  registerClient,
  revokeToken,
  SCOPE,
  storePendingAuthorization,
  takePendingAuthorization,
  verifyPkce,
} from './oauthServer';
import { isMcpEnabled, mcpDisabledReason } from '../mcp/config';
import logger from '../utils/logger';

const router = Router();

// ============================================================================
// Helpers
// ============================================================================

/** The public origin, as the client sees it. APP_URL wins; else the request's own host. */
export function publicBaseUrl(req: Request): string {
  const appUrl = getAuthConfig().appUrl;
  if (appUrl) return appUrl;
  const proto = requestIsSecure(req) ? 'https' : 'http';
  const forwardedHost = req.headers['x-forwarded-host'];
  const host = (typeof forwardedHost === 'string' && forwardedHost.split(',')[0]?.trim()) || req.headers['host'] || 'localhost:3000';
  return `${proto}://${host}`;
}

function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
}

function oauthError(res: Response, error: OAuthError): void {
  noStore(res);
  res.status(error.status).json({ error: error.code, error_description: error.message });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · PrunerrXT</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#030712;color:#e5e7eb;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
  .card{width:min(420px,calc(100% - 32px));background:#0b1120;border:1px solid #1f2937;border-radius:16px;padding:28px;box-shadow:0 20px 60px rgba(0,0,0,.5)}
  h1{font-size:19px;margin:0 0 6px}
  p{margin:0 0 12px;color:#9ca3af}
  .who{margin:16px 0;padding:12px 14px;border-radius:12px;background:#111827;border:1px solid #1f2937;font-size:14px}
  .who b{color:#f9fafb}
  ul{margin:0 0 18px;padding-left:18px;color:#9ca3af;font-size:13.5px}
  .row{display:flex;gap:10px;justify-content:flex-end}
  button{cursor:pointer;border-radius:12px;padding:10px 18px;font:inherit;font-weight:600;border:1px solid #374151;background:#111827;color:#e5e7eb}
  button.primary{background:linear-gradient(90deg,#f59e0b,#d97706);border-color:transparent;color:#1f1300}
  .err{color:#fca5a5}
  code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;color:#fbbf24}
</style></head><body><div class="card">${body}</div></body></html>`;
}

function errorPage(res: Response, status: number, title: string, detail: string): void {
  noStore(res);
  res.status(status).type('html').send(page(title, `<h1>${escapeHtml(title)}</h1><p class="err">${escapeHtml(detail)}</p>`));
}

function redirectWith(res: Response, redirectUri: string, params: Record<string, string | null>): void {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) url.searchParams.set(key, value);
  }
  noStore(res);
  res.redirect(url.toString());
}

function first(value: unknown): string | null {
  if (Array.isArray(value)) value = value[0];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** RFC 8707: a `resource` must name this MCP server, if given at all. */
function resourceMatches(resource: string | null, baseUrl: string): boolean {
  if (!resource) return true;
  const strip = (u: string) => u.replace(/\/+$/, '').toLowerCase();
  return strip(resource) === strip(`${baseUrl}/mcp`) || strip(resource) === strip(baseUrl);
}

/** Client credentials from Basic auth or the form body. */
function clientCredentials(req: Request): { clientId: string | null; clientSecret: string | null } {
  const header = req.headers['authorization'];
  if (typeof header === 'string' && /^Basic\s+/i.test(header)) {
    try {
      const decoded = Buffer.from(header.replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      if (idx > 0) {
        return { clientId: decodeURIComponent(decoded.slice(0, idx)), clientSecret: decodeURIComponent(decoded.slice(idx + 1)) };
      }
    } catch {
      /* fall through to body */
    }
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  return { clientId: first(body['client_id']), clientSecret: first(body['client_secret']) };
}

function requireMcp(req: Request, res: Response): boolean {
  if (isMcpEnabled()) return true;
  const reason = mcpDisabledReason();
  const detail =
    reason === 'auth_disabled'
      ? 'The MCP connector is off because login is disabled on this PrunerrXT (AUTH_ENABLED is not true).'
      : reason === 'env'
        ? 'The MCP connector is disabled by MCP_ENABLED=false.'
        : 'The MCP connector is turned off in Settings → System → AI assistant.';
  if (req.method === 'GET' && !req.path.startsWith('/.well-known')) {
    errorPage(res, 503, 'MCP connector unavailable', detail);
  } else {
    oauthError(res, new OAuthError('server_error', detail, 503));
  }
  return false;
}

// ============================================================================
// Discovery
// ============================================================================

for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
  router.get(path, (req: Request, res: Response) => {
    noStore(res);
    res.json(protectedResourceMetadata(publicBaseUrl(req)));
  });
}

for (const path of [
  '/.well-known/oauth-authorization-server',
  '/.well-known/oauth-authorization-server/mcp',
  '/.well-known/openid-configuration',
  '/.well-known/openid-configuration/mcp',
]) {
  router.get(path, (req: Request, res: Response) => {
    noStore(res);
    res.json(authorizationServerMetadata(publicBaseUrl(req)));
  });
}

// ============================================================================
// Dynamic client registration
// ============================================================================

router.post('/oauth/register', (req: Request, res: Response) => {
  if (!requireMcp(req, res)) return;
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { client, clientSecret } = registerClient({
      redirect_uris: body['redirect_uris'] as string[],
      client_name: typeof body['client_name'] === 'string' ? body['client_name'] : null,
      token_endpoint_auth_method: typeof body['token_endpoint_auth_method'] === 'string' ? body['token_endpoint_auth_method'] : null,
      grant_types: Array.isArray(body['grant_types']) ? (body['grant_types'] as string[]) : null,
      response_types: Array.isArray(body['response_types']) ? (body['response_types'] as string[]) : null,
    });
    noStore(res);
    res.status(201).json({
      client_id: client.client_id,
      ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}),
      client_id_issued_at: Math.floor(new Date(client.created_at).getTime() / 1000),
      client_name: client.client_name ?? undefined,
      redirect_uris: client.redirect_uris,
      token_endpoint_auth_method: client.token_endpoint_auth_method,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: SCOPE,
    });
  } catch (error) {
    if (error instanceof OAuthError) return oauthError(res, error);
    logger.error('OAuth client registration failed:', error);
    oauthError(res, new OAuthError('server_error', 'Registration failed', 500));
  }
});

// ============================================================================
// Authorization
// ============================================================================

interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string | null;
  codeChallenge: string;
  resource: string | null;
  clientName: string | null;
}

/** Validate the authorize request. Throws before anything redirects to a client we cannot trust. */
function parseAuthorizeParams(req: Request, baseUrl: string): AuthorizeParams {
  const q = req.query as Record<string, unknown>;
  const clientId = first(q['client_id']);
  if (!clientId) throw new OAuthError('invalid_request', 'client_id is required');
  const client = getClient(clientId);
  if (!client) throw new OAuthError('invalid_client', 'Unknown client_id. The client must register first.');

  let redirectUri = first(q['redirect_uri']);
  if (!redirectUri) {
    if (client.redirect_uris.length === 1) redirectUri = client.redirect_uris[0]!;
    else throw new OAuthError('invalid_request', 'redirect_uri is required');
  }
  if (!client.redirect_uris.includes(redirectUri)) {
    throw new OAuthError('invalid_request', 'redirect_uri is not registered for this client');
  }

  const responseType = first(q['response_type']);
  if (responseType !== 'code') throw new OAuthError('invalid_request', 'response_type must be "code"');

  const codeChallenge = first(q['code_challenge']);
  const method = first(q['code_challenge_method']) ?? 'plain';
  if (!codeChallenge || method !== 'S256') {
    throw new OAuthError('invalid_request', 'PKCE with code_challenge_method=S256 is required');
  }

  const resource = first(q['resource']);
  if (!resourceMatches(resource, baseUrl)) {
    throw new OAuthError('invalid_request', `resource must be ${baseUrl}/mcp`);
  }

  return {
    clientId,
    redirectUri,
    scope: SCOPE,
    state: first(q['state']),
    codeChallenge,
    resource,
    clientName: client.client_name,
  };
}

router.get('/oauth/authorize', (req: Request, res: Response) => {
  if (!requireMcp(req, res)) return;
  const baseUrl = publicBaseUrl(req);

  let params: AuthorizeParams;
  try {
    params = parseAuthorizeParams(req, baseUrl);
  } catch (error) {
    const err = error instanceof OAuthError ? error : new OAuthError('server_error', 'Invalid request');
    return errorPage(res, err.status, 'Cannot start sign-in', err.message);
  }

  const session = sessionFromRequest(req);
  if (!session) {
    // Sign in with PrunerrXT first (Authentik or the local account), then come back here.
    const returnTo = req.originalUrl;
    noStore(res);
    res.redirect(`/login?returnTo=${encodeURIComponent(returnTo)}`);
    return;
  }

  const user = { key: session.key, username: session.username, role: session.role };
  const appName = params.clientName ?? 'This application';

  if (hasConsent(session.key, params.clientId)) {
    const code = createAuthorizationCode({ ...params, user });
    logger.info(`OAuth: ${session.username} authorized ${appName} (remembered)`);
    return redirectWith(res, params.redirectUri, { code, state: params.state });
  }

  const entry = storePendingAuthorization({ ...params, userKey: session.key });
  noStore(res);
  res.type('html').send(
    page(
      'Allow access',
      `<h1>Allow ${escapeHtml(appName)} to use PrunerrXT?</h1>
       <p>It will act with your account and your role.</p>
       <div class="who">Signed in as <b>${escapeHtml(session.displayName ?? session.username)}</b> · ${escapeHtml(session.role)}</div>
       <ul>
         <li>Browse the library, the deletion queue, rules and history</li>
         <li>${session.role === 'viewer' ? 'Read-only: your role cannot change anything' : 'Queue, protect and manage items and rules as you could in the app'}</li>
         <li>Never delete anything immediately unless an admin enabled that in Settings</li>
       </ul>
       <p>Redirects to <code>${escapeHtml(new URL(params.redirectUri).origin)}</code></p>
       <form method="post" action="/oauth/authorize" class="row">
         <input type="hidden" name="request_id" value="${escapeHtml(entry.id)}">
         <button type="submit" name="decision" value="deny">Cancel</button>
         <button type="submit" name="decision" value="allow" class="primary" autofocus>Allow</button>
       </form>`
    )
  );
});

router.post('/oauth/authorize', (req: Request, res: Response) => {
  if (!requireMcp(req, res)) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const requestId = first(body['request_id']);
  const decision = first(body['decision']);
  const entry = requestId ? takePendingAuthorization(requestId) : null;
  if (!entry) {
    return errorPage(res, 400, 'Sign-in expired', 'This approval request has expired. Go back to the application and connect again.');
  }

  const session = sessionFromRequest(req);
  if (!session || session.key !== entry.userKey) {
    return errorPage(res, 403, 'Session changed', 'The signed-in user changed while approving. Connect again.');
  }

  if (decision !== 'allow') {
    logger.info(`OAuth: ${session.username} denied ${entry.clientName ?? entry.clientId}`);
    return redirectWith(res, entry.redirectUri, { error: 'access_denied', error_description: 'The user declined', state: entry.state });
  }

  recordConsent(session.key, entry.clientId);
  const code = createAuthorizationCode({
    clientId: entry.clientId,
    redirectUri: entry.redirectUri,
    codeChallenge: entry.codeChallenge,
    scope: entry.scope,
    resource: entry.resource,
    user: { key: session.key, username: session.username, role: session.role },
  });
  logger.info(`OAuth: ${session.username} (${session.role}) authorized ${entry.clientName ?? entry.clientId}`);
  redirectWith(res, entry.redirectUri, { code, state: entry.state });
});

// ============================================================================
// Token
// ============================================================================

router.post('/oauth/token', (req: Request, res: Response) => {
  if (!requireMcp(req, res)) return;
  noStore(res);
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { clientId, clientSecret } = clientCredentials(req);
    if (!clientId) throw new OAuthError('invalid_client', 'client_id is required', 401);
    const client = getClient(clientId);
    if (!client) throw new OAuthError('invalid_client', 'Unknown client', 401);
    authenticateClient(client, clientSecret);

    const grantType = first(body['grant_type']);
    if (grantType === 'authorization_code') {
      const code = first(body['code']);
      const verifier = first(body['code_verifier']);
      const redirectUri = first(body['redirect_uri']);
      if (!code) throw new OAuthError('invalid_request', 'code is required');
      if (!verifier) throw new OAuthError('invalid_request', 'code_verifier is required');

      const row = consumeAuthorizationCode(code);
      if (!row) throw new OAuthError('invalid_grant', 'Authorization code is invalid or expired');
      if (row.client_id !== client.client_id) throw new OAuthError('invalid_grant', 'Code was issued to another client');
      if (redirectUri && redirectUri !== row.redirect_uri) throw new OAuthError('invalid_grant', 'redirect_uri does not match');
      if (!verifyPkce(verifier, row.code_challenge)) throw new OAuthError('invalid_grant', 'PKCE verification failed');

      const tokens = issueTokens({
        clientId: client.client_id,
        user: { key: row.user_key, username: row.username, role: row.role as 'admin' | 'operator' | 'viewer' },
        scope: row.scope,
        resource: row.resource,
      });
      res.json({
        access_token: tokens.accessToken,
        token_type: 'Bearer',
        expires_in: tokens.expiresIn,
        refresh_token: tokens.refreshToken,
        scope: tokens.scope,
      });
      return;
    }

    if (grantType === 'refresh_token') {
      const refreshToken = first(body['refresh_token']);
      if (!refreshToken) throw new OAuthError('invalid_request', 'refresh_token is required');
      const tokens = refreshTokens(refreshToken, client.client_id);
      if (!tokens) throw new OAuthError('invalid_grant', 'Refresh token is invalid or expired');
      res.json({
        access_token: tokens.accessToken,
        token_type: 'Bearer',
        expires_in: tokens.expiresIn,
        refresh_token: tokens.refreshToken,
        scope: tokens.scope,
      });
      return;
    }

    throw new OAuthError('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
  } catch (error) {
    if (error instanceof OAuthError) {
      if (error.code === 'invalid_client') res.setHeader('WWW-Authenticate', 'Basic realm="prunerr-oauth"');
      return oauthError(res, error);
    }
    logger.error('OAuth token request failed:', error);
    oauthError(res, new OAuthError('server_error', 'Token request failed', 500));
  }
});

// ============================================================================
// Revocation (RFC 7009)
// ============================================================================

router.post('/oauth/revoke', (req: Request, res: Response) => {
  noStore(res);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const value = first(body['token']);
  if (value) revokeToken(value);
  // The spec says respond 200 whether or not the token existed.
  res.status(200).end();
});

export default router;
