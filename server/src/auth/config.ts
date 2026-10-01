/**
 * Login configuration, read from the environment.
 *
 * Everything about who may sign in is decided by environment variables so a
 * container can be fully provisioned without touching the UI, and so a bad
 * change can be reverted by editing the compose file. Nothing here is stored
 * in the database.
 *
 *   AUTH_ENABLED            true/false. Off (the default) keeps the historical
 *                           behaviour: no login, and the MCP connector is off.
 *   OIDC_ISSUER_URL         e.g. https://auth.example.com/application/o/prunerr/
 *   OIDC_CLIENT_ID / OIDC_CLIENT_SECRET
 *   OIDC_REDIRECT_URI       optional; derived from APP_URL or the request otherwise
 *   OIDC_SCOPES             default "openid profile email"
 *   OIDC_GROUPS_CLAIM       default "groups" (Authentik's default claim name)
 *   OIDC_ADMIN_GROUPS / OIDC_OPERATOR_GROUPS / OIDC_VIEWER_GROUPS
 *                           comma-separated group names mapped to each role
 *   OIDC_DEFAULT_ROLE       role for users in none of those groups: none (default),
 *                           viewer, operator or admin
 *   AUTH_LOCAL_ENABLED      true/false — a single built-in account
 *   AUTH_LOCAL_USERNAME / AUTH_LOCAL_PASSWORD or AUTH_LOCAL_PASSWORD_HASH
 */

export type Role = 'admin' | 'operator' | 'viewer';

export const ROLES: readonly Role[] = ['admin', 'operator', 'viewer'];

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export type ClientAuthMethod = 'client_secret_basic' | 'client_secret_post';

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Fixed redirect URI. When absent it is derived per request. */
  redirectUri: string | null;
  scopes: string[];
  groupsClaim: string;
  usernameClaim: string;
  adminGroups: string[];
  operatorGroups: string[];
  viewerGroups: string[];
  /** Role for a user who is in none of the mapped groups. 'none' denies them. */
  defaultRole: Role | 'none';
  /** Label on the login button. */
  providerName: string;
  /** Send users straight to the provider instead of showing the login page. */
  autoLogin: boolean;
  tokenAuthMethod: ClientAuthMethod;
}

export interface LocalAuthConfig {
  username: string;
  /** Plain password from the environment. Compared in constant time. */
  password: string | null;
  /** `scrypt$...` hash produced by scripts/hash-password.mjs. Preferred over a plain password. */
  passwordHash: string | null;
  role: Role;
}

export interface AuthConfig {
  enabled: boolean;
  oidc: OidcConfig | null;
  local: LocalAuthConfig | null;
  /** How long a login lasts without re-authenticating. */
  sessionTtlHours: number;
  /** Signs session cookies. Generated and stored in the database when unset. */
  sessionSecret: string | null;
  /** 'auto' marks the cookie Secure when the request arrived over HTTPS. */
  cookieSecure: 'auto' | boolean;
  /** Public base URL, used to build the OIDC redirect URI. */
  appUrl: string | null;
  /** Misconfigurations worth logging at startup. */
  warnings: string[];
}

type Env = Record<string, string | undefined>;

function read(env: Env, key: string): string | null {
  const value = env[key];
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function readBoolean(env: Env, key: string, defaultValue: boolean): boolean {
  const value = read(env, key);
  if (value === null) return defaultValue;
  return value.toLowerCase() === 'true' || value === '1' || value.toLowerCase() === 'yes';
}

function readList(env: Env, key: string): string[] {
  const value = read(env, key);
  if (!value) return [];
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function readRole(env: Env, key: string, fallback: Role, warnings: string[]): Role {
  const value = read(env, key);
  if (value === null) return fallback;
  if (isRole(value)) return value;
  warnings.push(`${key}="${value}" is not a role (admin, operator or viewer); using ${fallback}`);
  return fallback;
}

/** Strip a trailing slash so issuer comparisons are forgiving of either form. */
export function normalizeIssuer(issuer: string): string {
  return issuer.replace(/\/+$/, '');
}

function guessProviderName(issuer: string): string {
  const lower = issuer.toLowerCase();
  if (lower.includes('authentik') || lower.includes('/application/o/')) return 'Authentik';
  if (lower.includes('authelia')) return 'Authelia';
  if (lower.includes('keycloak') || lower.includes('/realms/')) return 'Keycloak';
  if (lower.includes('pocket-id') || lower.includes('pocketid')) return 'Pocket ID';
  if (lower.includes('zitadel')) return 'Zitadel';
  if (lower.includes('okta')) return 'Okta';
  if (lower.includes('auth0')) return 'Auth0';
  if (lower.includes('google')) return 'Google';
  if (lower.includes('microsoft')) return 'Microsoft';
  return 'Single sign-on';
}

export function loadAuthConfig(env: Env = process.env): AuthConfig {
  const warnings: string[] = [];
  const enabled = readBoolean(env, 'AUTH_ENABLED', false);

  // --- OIDC -----------------------------------------------------------------
  let oidc: OidcConfig | null = null;
  const issuer = read(env, 'OIDC_ISSUER_URL');
  const clientId = read(env, 'OIDC_CLIENT_ID');
  const clientSecret = read(env, 'OIDC_CLIENT_SECRET');

  if (issuer || clientId || clientSecret) {
    if (!issuer || !clientId || !clientSecret) {
      warnings.push(
        'OIDC is partially configured: OIDC_ISSUER_URL, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET are all required. Single sign-on is off.'
      );
    } else if (!/^https?:\/\//i.test(issuer)) {
      warnings.push(`OIDC_ISSUER_URL "${issuer}" must be an http(s) URL. Single sign-on is off.`);
    } else {
      const defaultRoleRaw = read(env, 'OIDC_DEFAULT_ROLE') ?? 'none';
      let defaultRole: Role | 'none' = 'none';
      if (defaultRoleRaw === 'none' || isRole(defaultRoleRaw)) {
        defaultRole = defaultRoleRaw;
      } else {
        warnings.push(`OIDC_DEFAULT_ROLE="${defaultRoleRaw}" is not none, viewer, operator or admin; using none`);
      }

      const tokenAuthRaw = read(env, 'OIDC_TOKEN_AUTH_METHOD') ?? 'client_secret_basic';
      const tokenAuthMethod: ClientAuthMethod =
        tokenAuthRaw === 'client_secret_post' ? 'client_secret_post' : 'client_secret_basic';

      const scopes = readList(env, 'OIDC_SCOPES').flatMap((s) => s.split(/\s+/));
      const scopeSet = new Set(scopes.length > 0 ? scopes : ['openid', 'profile', 'email']);
      scopeSet.add('openid');

      oidc = {
        issuer: normalizeIssuer(issuer),
        clientId,
        clientSecret,
        redirectUri: read(env, 'OIDC_REDIRECT_URI'),
        scopes: [...scopeSet],
        groupsClaim: read(env, 'OIDC_GROUPS_CLAIM') ?? 'groups',
        usernameClaim: read(env, 'OIDC_USERNAME_CLAIM') ?? 'preferred_username',
        adminGroups: readList(env, 'OIDC_ADMIN_GROUPS'),
        operatorGroups: readList(env, 'OIDC_OPERATOR_GROUPS'),
        viewerGroups: readList(env, 'OIDC_VIEWER_GROUPS'),
        defaultRole,
        providerName: read(env, 'OIDC_PROVIDER_NAME') ?? guessProviderName(issuer),
        autoLogin: readBoolean(env, 'OIDC_AUTO_LOGIN', false),
        tokenAuthMethod,
      };

      if (
        oidc.adminGroups.length === 0 &&
        oidc.operatorGroups.length === 0 &&
        oidc.viewerGroups.length === 0 &&
        oidc.defaultRole === 'none'
      ) {
        warnings.push(
          'OIDC has no group mapping (OIDC_ADMIN_GROUPS / OIDC_OPERATOR_GROUPS / OIDC_VIEWER_GROUPS) and OIDC_DEFAULT_ROLE is none, so every single sign-on login will be refused.'
        );
      }
    }
  }

  // --- Local account --------------------------------------------------------
  let local: LocalAuthConfig | null = null;
  if (readBoolean(env, 'AUTH_LOCAL_ENABLED', false)) {
    const username = read(env, 'AUTH_LOCAL_USERNAME');
    const password = read(env, 'AUTH_LOCAL_PASSWORD');
    const passwordHash = read(env, 'AUTH_LOCAL_PASSWORD_HASH');
    if (!username || (!password && !passwordHash)) {
      warnings.push(
        'AUTH_LOCAL_ENABLED is true but AUTH_LOCAL_USERNAME and AUTH_LOCAL_PASSWORD (or AUTH_LOCAL_PASSWORD_HASH) are not both set. Local login is off.'
      );
    } else {
      if (password && !passwordHash && password.length < 8) {
        warnings.push('AUTH_LOCAL_PASSWORD is shorter than 8 characters.');
      }
      local = {
        username,
        password: passwordHash ? null : password,
        passwordHash,
        role: readRole(env, 'AUTH_LOCAL_ROLE', 'admin', warnings),
      };
    }
  }

  if (enabled && !oidc && !local) {
    warnings.push(
      'AUTH_ENABLED is true but no login method is configured. Nobody can sign in to the web UI; only the API key works. Configure OIDC_* or AUTH_LOCAL_*.'
    );
  }

  const ttlRaw = read(env, 'AUTH_SESSION_TTL_HOURS');
  let sessionTtlHours = 24 * 7;
  if (ttlRaw !== null) {
    const parsed = Number(ttlRaw);
    if (Number.isFinite(parsed) && parsed > 0) sessionTtlHours = parsed;
    else warnings.push(`AUTH_SESSION_TTL_HOURS="${ttlRaw}" is not a positive number; using ${sessionTtlHours}`);
  }

  const cookieSecureRaw = read(env, 'AUTH_COOKIE_SECURE');
  let cookieSecure: 'auto' | boolean = 'auto';
  if (cookieSecureRaw !== null && cookieSecureRaw.toLowerCase() !== 'auto') {
    cookieSecure = cookieSecureRaw.toLowerCase() === 'true' || cookieSecureRaw === '1';
  }

  const appUrlRaw = read(env, 'APP_URL');

  return {
    enabled,
    oidc,
    local,
    sessionTtlHours,
    sessionSecret: read(env, 'AUTH_SESSION_SECRET'),
    cookieSecure,
    appUrl: appUrlRaw ? appUrlRaw.replace(/\/+$/, '') : null,
    warnings,
  };
}

let cached: AuthConfig | null = null;

/** The process-wide login configuration, parsed once. */
export function getAuthConfig(): AuthConfig {
  if (!cached) cached = loadAuthConfig();
  return cached;
}

/** Test seam. */
export function setAuthConfigForTests(config: AuthConfig | null): void {
  cached = config;
}
