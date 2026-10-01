/**
 * /api/auth — who am I, how can I sign in, sign me in, sign me out.
 *
 * These routes are reachable without a session (the API auth middleware lets
 * /api/auth/* through) and read the session cookie themselves where needed.
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import logger from '../utils/logger';
import { getAuthConfig, type Role } from './config';
import { ROLE_DESCRIPTIONS, roleFromGroups } from './roles';
import {
  clearSessionCookie,
  createSession,
  deleteSession,
  sessionFromRequest,
  setSessionCookie,
  requestIsSecure,
  type AuthSession,
} from './sessions';
import { verifyLocalCredentials } from './local';
import { beginOidcLogin, completeOidcLogin, OidcError } from './oidc';
import { isMcpEnabled } from '../mcp/config';

const router = Router();

// ============================================================================
// Shapes
// ============================================================================

function publicUser(session: AuthSession) {
  return {
    id: session.key,
    username: session.username,
    displayName: session.displayName ?? session.username,
    email: session.email,
    role: session.role,
    provider: session.provider,
    groups: session.groups,
    sessionExpiresAt: session.expiresAt,
  };
}

function authConfigPayload() {
  const config = getAuthConfig();
  return {
    enabled: config.enabled,
    methods: {
      oidc: config.oidc
        ? { enabled: true, providerName: config.oidc.providerName, autoLogin: config.oidc.autoLogin }
        : { enabled: false, providerName: null, autoLogin: false },
      local: { enabled: Boolean(config.local) },
    },
    roles: ROLE_DESCRIPTIONS,
    mcpEnabled: isMcpEnabled(),
  };
}

/** Only ever send users back to a path inside this app. */
function safeReturnTo(raw: unknown): string {
  if (typeof raw !== 'string') return '/';
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  if (raw.startsWith('/api/')) return '/';
  return raw;
}

/** Where the provider should send the browser back to. */
function oidcRedirectUri(req: Request): string {
  const config = getAuthConfig();
  if (config.oidc?.redirectUri) return config.oidc.redirectUri;
  if (config.appUrl) return `${config.appUrl}/api/auth/oidc/callback`;
  const proto = requestIsSecure(req) ? 'https' : 'http';
  const forwardedHost = req.headers['x-forwarded-host'];
  const host = (typeof forwardedHost === 'string' && forwardedHost.split(',')[0]?.trim()) || req.headers['host'] || 'localhost';
  return `${proto}://${host}/api/auth/oidc/callback`;
}

// ============================================================================
// Login attempt throttling (local login)
// ============================================================================

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;
const failures = new Map<string, { count: number; firstAt: number }>();

function throttled(ip: string): boolean {
  const entry = failures.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.firstAt > WINDOW_MS) {
    failures.delete(ip);
    return false;
  }
  return entry.count >= MAX_FAILURES;
}

function recordFailure(ip: string): void {
  const entry = failures.get(ip);
  if (!entry || Date.now() - entry.firstAt > WINDOW_MS) {
    failures.set(ip, { count: 1, firstAt: Date.now() });
  } else {
    entry.count += 1;
  }
}

// ============================================================================
// Routes
// ============================================================================

// GET /api/auth/config - Which login methods exist (public)
router.get('/config', (_req: Request, res: Response) => {
  res.json({ success: true, data: authConfigPayload() });
});

// GET /api/auth/me - The current user, or null (public)
router.get('/me', (req: Request, res: Response) => {
  const config = getAuthConfig();
  const session = config.enabled ? sessionFromRequest(req) : null;
  res.json({
    success: true,
    data: {
      ...authConfigPayload(),
      user: session ? publicUser(session) : null,
    },
  });
});

const LocalLoginSchema = z.object({
  username: z.string().min(1).max(200),
  password: z.string().min(1).max(1000),
});

// POST /api/auth/login/local - Username/password login
router.post('/login/local', (req: Request, res: Response) => {
  const config = getAuthConfig();
  if (!config.enabled) {
    res.status(400).json({ success: false, error: 'Login is disabled on this install.' });
    return;
  }
  if (!config.local) {
    res.status(400).json({ success: false, error: 'Local login is not enabled.' });
    return;
  }

  const ip = req.ip ?? 'unknown';
  if (throttled(ip)) {
    res.status(429).json({ success: false, error: 'Too many failed attempts. Try again in a few minutes.' });
    return;
  }

  const parsed = LocalLoginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'Username and password are required.' });
    return;
  }

  const identity = verifyLocalCredentials(parsed.data.username, parsed.data.password, config.local);
  if (!identity) {
    recordFailure(ip);
    logger.warn(`Local login failed for "${parsed.data.username}" from ${ip}`);
    res.status(401).json({ success: false, error: 'Incorrect username or password.' });
    return;
  }

  failures.delete(ip);
  const { token, session } = createSession({
    key: `local:${identity.username.toLowerCase()}`,
    username: identity.username,
    displayName: identity.username,
    email: null,
    role: identity.role,
    provider: 'local',
    groups: [],
  });
  setSessionCookie(req, res, token, session.expiresAt);
  logger.info(`Local login: ${identity.username} (${identity.role})`);
  res.json({ success: true, data: { user: publicUser(session) } });
});

// GET /api/auth/oidc/start - Redirect to the identity provider
router.get('/oidc/start', async (req: Request, res: Response) => {
  const config = getAuthConfig();
  if (!config.enabled || !config.oidc) {
    res.redirect('/login?error=oidc_unavailable');
    return;
  }
  try {
    const { url } = await beginOidcLogin({
      redirectUri: oidcRedirectUri(req),
      returnTo: safeReturnTo(req.query['returnTo']),
    });
    res.redirect(url);
  } catch (error) {
    logger.error('Could not start single sign-on:', error);
    const code = error instanceof OidcError ? error.code : 'provider';
    res.redirect(`/login?error=oidc_${code}`);
  }
});

// GET /api/auth/oidc/callback - The identity provider sends the browser back here
router.get('/oidc/callback', async (req: Request, res: Response) => {
  const config = getAuthConfig();
  if (!config.enabled || !config.oidc) {
    res.redirect('/login?error=oidc_unavailable');
    return;
  }

  const providerError = req.query['error'];
  if (typeof providerError === 'string' && providerError) {
    logger.warn(`Single sign-on refused by provider: ${providerError} ${req.query['error_description'] ?? ''}`);
    res.redirect(`/login?error=oidc_denied`);
    return;
  }

  const code = req.query['code'];
  const state = req.query['state'];
  if (typeof code !== 'string' || typeof state !== 'string' || !code || !state) {
    res.redirect('/login?error=oidc_state');
    return;
  }

  try {
    const { identity, returnTo } = await completeOidcLogin({ code, state });
    const role: Role | null = roleFromGroups(identity.groups, config.oidc);
    if (!role) {
      logger.warn(`Single sign-on: "${identity.username}" is in no mapped group (groups: ${identity.groups.join(', ') || 'none'}); refused`);
      res.redirect('/login?error=no_role');
      return;
    }

    const { token, session } = createSession({
      key: `oidc:${identity.subject}`,
      username: identity.username,
      displayName: identity.displayName,
      email: identity.email,
      role,
      provider: 'oidc',
      groups: identity.groups,
    });
    setSessionCookie(req, res, token, session.expiresAt);
    logger.info(`Single sign-on: ${identity.username} (${role}) via ${config.oidc.providerName}`);
    res.redirect(returnTo);
  } catch (error) {
    const code = error instanceof OidcError ? error.code : 'provider';
    logger.error(`Single sign-on failed (${code}): ${error instanceof Error ? error.message : String(error)}`);
    res.redirect(`/login?error=oidc_${code}`);
  }
});

// POST /api/auth/logout - End the current session
router.post('/logout', (req: Request, res: Response) => {
  const session = sessionFromRequest(req);
  if (session) {
    deleteSession(session.id);
    logger.info(`Logout: ${session.username}`);
  }
  clearSessionCookie(req, res);
  res.json({ success: true });
});

export default router;
