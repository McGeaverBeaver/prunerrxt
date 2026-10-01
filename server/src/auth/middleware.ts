/**
 * Who is making this request, as every /api route sees it.
 *
 * Resolved once by the API auth middleware and stashed on `res.locals`, so
 * routes that care (the auth routes, the settings panel) can read the role and
 * user without re-parsing cookies.
 */
import type { Request, Response } from 'express';
import type { Role } from './config';
import type { AuthSession } from './sessions';

export type RequestAuth =
  | { kind: 'disabled'; role: 'admin' }
  | { kind: 'apiKey'; role: 'admin' }
  | { kind: 'session'; role: Role; session: AuthSession };

const LOCALS_KEY = 'prunerrAuth';

export function setRequestAuth(res: Response, auth: RequestAuth): void {
  res.locals[LOCALS_KEY] = auth;
}

export function getRequestAuth(res: Response): RequestAuth | null {
  const value = res.locals[LOCALS_KEY];
  return (value as RequestAuth | undefined) ?? null;
}

/** Paths under /api that never need a login (health probes and the login flow itself). */
export function isPublicApiPath(apiPath: string): boolean {
  if (apiPath === '/auth' || apiPath.startsWith('/auth/')) return true;
  return (
    apiPath === '/health' ||
    apiPath === '/health/ping' ||
    apiPath === '/health/live' ||
    apiPath === '/health/ready' ||
    apiPath === '/health/version'
  );
}

/** Actor label for the activity log. */
export function actorNameFor(req: Request, res: Response): string | null {
  const auth = getRequestAuth(res);
  if (!auth) return null;
  if (auth.kind === 'session') return auth.session.displayName ?? auth.session.username;
  if (auth.kind === 'apiKey') return req.headers['user-agent'] ? 'API key' : 'API key';
  return null;
}
