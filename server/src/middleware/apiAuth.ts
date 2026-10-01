import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import settingsRepo from '../db/repositories/settings';
import logger from '../utils/logger';
import { getAuthConfig } from '../auth/config';
import { isAuthorized } from '../auth/roles';
import { sessionFromRequest } from '../auth/sessions';
import { isPublicApiPath, setRequestAuth } from '../auth/middleware';

const API_KEY_SETTING = 'api_key';

let cachedApiKey: string | null = null;

/**
 * Ensure an API key exists in the database.
 * Called once at startup and lazily on first request.
 */
export function ensureApiKey(): string {
  const existing = settingsRepo.getValue(API_KEY_SETTING);
  if (existing) {
    cachedApiKey = existing;
    return existing;
  }

  const newKey = crypto.randomBytes(32).toString('hex');
  settingsRepo.set({ key: API_KEY_SETTING, value: newKey });
  cachedApiKey = newKey;
  logger.info('Generated new API key for external access');
  return newKey;
}

/**
 * Get the current API key (from cache, DB, or env override).
 */
export function getApiKey(): string {
  const envKey = process.env['PRUNERR_API_KEY'];
  if (envKey) {
    return envKey;
  }

  if (cachedApiKey) {
    return cachedApiKey;
  }

  return ensureApiKey();
}

/**
 * Clear the cached key so the next call reads from DB.
 */
export function clearApiKeyCache(): void {
  cachedApiKey = null;
}

/**
 * Constant-time key comparison using HMAC to avoid length leaks.
 * Both inputs are hashed to a fixed-length digest before comparing,
 * so neither the key length nor content leaks via timing.
 */
export function keysMatch(provided: string, valid: string): boolean {
  const hash = (s: string) => crypto.createHmac('sha256', 'prunerr-api-key-compare').update(s).digest();
  const a = hash(provided);
  const b = hash(valid);
  return crypto.timingSafeEqual(a, b);
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Express middleware that authenticates and authorizes /api/* requests.
 *
 * Two modes, decided by AUTH_ENABLED:
 *
 * Login disabled (the default, and the historical behaviour): requests with
 * no X-Api-Key header are allowed through — the web UI never sends one. A
 * request that does send the header must send the right key. The app is
 * designed for trusted LAN / VPN access in this mode; expose it publicly only
 * behind a reverse proxy with auth, or enable login.
 *
 * Login enabled: every request needs either a valid API key (acts as admin)
 * or a session cookie from the login flow, and the session's role decides
 * what it may do (see auth/roles.ts). Health probes and the login endpoints
 * themselves stay public.
 */
export function apiAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const providedKey = req.headers['x-api-key'] as string | undefined;

  if (providedKey) {
    if (!keysMatch(providedKey, getApiKey())) {
      logger.warn(`API auth: invalid API key from ${req.ip} for ${req.method} ${req.path}`);
      res.status(401).json({
        success: false,
        error: 'Invalid API key.',
        code: 'INVALID_API_KEY',
      });
      return;
    }
    setRequestAuth(res, { kind: 'apiKey', role: 'admin' });
    next();
    return;
  }

  const authConfig = getAuthConfig();
  if (!authConfig.enabled) {
    setRequestAuth(res, { kind: 'disabled', role: 'admin' });
    next();
    return;
  }

  if (isPublicApiPath(req.path)) {
    next();
    return;
  }

  const session = sessionFromRequest(req);
  if (!session) {
    res.status(401).json({
      success: false,
      error: 'Authentication required.',
      code: 'AUTH_REQUIRED',
    });
    return;
  }

  // A cookie-authenticated mutation from another site is the classic CSRF
  // shape. SameSite=Lax already withholds the cookie on cross-site POSTs in
  // modern browsers; this is the belt to that suspender.
  const fetchSite = req.headers['sec-fetch-site'];
  if (!SAFE_METHODS.has(req.method.toUpperCase()) && fetchSite === 'cross-site') {
    res.status(403).json({
      success: false,
      error: 'Cross-site request refused.',
      code: 'CSRF',
    });
    return;
  }

  if (!isAuthorized(session.role, req.method, req.path)) {
    res.status(403).json({
      success: false,
      error: `Your role (${session.role}) does not allow this action.`,
      code: 'FORBIDDEN',
      role: session.role,
    });
    return;
  }

  setRequestAuth(res, { kind: 'session', role: session.role, session });
  next();
}
