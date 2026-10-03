import type { Request } from 'express';
import { sessionFromRequest } from '../auth/sessions';
import { getAuthConfig } from '../auth/config';

/**
 * Who is behind a request, for the activity log and job rows: the signed-in
 * user's name when login is on, otherwise the generic label. API-key calls
 * carry no name either.
 */
export function requestActorName(req: Request, fallback = 'Manual deletion'): string {
  try {
    if (!getAuthConfig().enabled) return fallback;
    const session = sessionFromRequest(req);
    if (!session) return fallback;
    return session.displayName || session.username || fallback;
  } catch {
    return fallback;
  }
}
