/**
 * Roles and what each one may do.
 *
 *   admin     everything, including Settings, the API key, backups and the
 *             MCP connector configuration
 *   operator  runs the library day to day: queue, protect, rules, scans,
 *             collections — but cannot see or change Settings (which hold
 *             service credentials)
 *   viewer    read-only
 *
 * The API key and a disabled login both act as admin, as they always have.
 */
import type { OidcConfig, Role } from './config';

export const ROLE_RANK: Record<Role, number> = { viewer: 1, operator: 2, admin: 3 };

export function roleAtLeast(role: Role, required: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[required];
}

/**
 * Map a user's groups to a role. The highest matching role wins, so someone
 * in both an admin and a viewer group is an admin. Returns null when the
 * user is in none of the mapped groups and no default role is configured.
 */
export function roleFromGroups(groups: readonly string[], oidc: Pick<OidcConfig, 'adminGroups' | 'operatorGroups' | 'viewerGroups' | 'defaultRole'>): Role | null {
  const have = new Set(groups.map((g) => g.trim().toLowerCase()));
  const inAny = (wanted: readonly string[]) => wanted.some((g) => have.has(g.trim().toLowerCase()));

  if (inAny(oidc.adminGroups)) return 'admin';
  if (inAny(oidc.operatorGroups)) return 'operator';
  if (inAny(oidc.viewerGroups)) return 'viewer';
  return oidc.defaultRole === 'none' ? null : oidc.defaultRole;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Routes (relative to /api) only an admin may touch, with any method. These
 * either expose credentials or reconfigure the install.
 */
const ADMIN_ONLY_PREFIXES = ['/settings', '/webhooks', '/library/plex-libraries/exclusions', '/diagnostics'];

/**
 * Whether `role` may perform `method` on an API path (relative to /api, e.g.
 * "/queue/12"). Authentication has already happened by the time this runs.
 */
export function isAuthorized(role: Role, method: string, apiPath: string): boolean {
  const upper = method.toUpperCase();

  // Everyone who is signed in may look at and end their own session.
  if (apiPath === '/auth/me' || apiPath === '/auth/logout' || apiPath === '/auth/config') return true;

  if (role === 'admin') return true;

  if (ADMIN_ONLY_PREFIXES.some((prefix) => apiPath === prefix || apiPath.startsWith(`${prefix}/`))) {
    return false;
  }

  if (role === 'operator') return true;

  // viewer
  return SAFE_METHODS.has(upper);
}

/** Human-readable summary for the login page and the settings panel. */
export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  admin: 'Full access, including Settings and the MCP connector',
  operator: 'Manage the library, queue, rules and scans; no Settings',
  viewer: 'Read-only',
};
