import { describe, it, expect } from 'vitest';
import { isAuthorized, roleFromGroups } from '../roles';
import { loadAuthConfig } from '../config';

describe('roleFromGroups', () => {
  const mapping = { adminGroups: ['prunerr-admins'], operatorGroups: ['Media Ops'], viewerGroups: ['family'], defaultRole: 'none' as const };

  it('picks the highest matching role, case-insensitively', () => {
    expect(roleFromGroups(['family', 'PRUNERR-ADMINS'], mapping)).toBe('admin');
    expect(roleFromGroups(['media ops'], mapping)).toBe('operator');
    expect(roleFromGroups(['Family'], mapping)).toBe('viewer');
  });

  it('denies users in no mapped group unless a default role is set', () => {
    expect(roleFromGroups(['strangers'], mapping)).toBeNull();
    expect(roleFromGroups([], { ...mapping, defaultRole: 'viewer' })).toBe('viewer');
  });
});

describe('isAuthorized', () => {
  it('lets admins do everything', () => {
    expect(isAuthorized('admin', 'PUT', '/settings')).toBe(true);
    expect(isAuthorized('admin', 'DELETE', '/rules/3')).toBe(true);
  });

  it('keeps operators out of settings but lets them run the library', () => {
    expect(isAuthorized('operator', 'GET', '/settings')).toBe(false);
    expect(isAuthorized('operator', 'GET', '/settings/api-key')).toBe(false);
    expect(isAuthorized('operator', 'POST', '/webhooks/test')).toBe(false);
    expect(isAuthorized('operator', 'PUT', '/library/plex-libraries/exclusions')).toBe(false);
    expect(isAuthorized('operator', 'POST', '/library/12/mark-deletion')).toBe(true);
    expect(isAuthorized('operator', 'DELETE', '/queue/12')).toBe(true);
    expect(isAuthorized('operator', 'POST', '/scan/trigger')).toBe(true);
    expect(isAuthorized('operator', 'GET', '/library/plex-libraries')).toBe(true);
  });

  it('makes viewers read-only', () => {
    expect(isAuthorized('viewer', 'GET', '/library')).toBe(true);
    expect(isAuthorized('viewer', 'GET', '/queue')).toBe(true);
    expect(isAuthorized('viewer', 'POST', '/library/12/mark-deletion')).toBe(false);
    expect(isAuthorized('viewer', 'GET', '/settings')).toBe(false);
    expect(isAuthorized('viewer', 'POST', '/auth/logout')).toBe(true);
  });
});

describe('loadAuthConfig', () => {
  it('is disabled with no environment', () => {
    const config = loadAuthConfig({});
    expect(config.enabled).toBe(false);
    expect(config.oidc).toBeNull();
    expect(config.local).toBeNull();
  });

  it('parses an Authentik-style configuration', () => {
    const config = loadAuthConfig({
      AUTH_ENABLED: 'true',
      OIDC_ISSUER_URL: 'https://auth.example.com/application/o/prunerr/',
      OIDC_CLIENT_ID: 'abc',
      OIDC_CLIENT_SECRET: 'shh',
      OIDC_ADMIN_GROUPS: 'prunerr-admins, media-admins',
      OIDC_VIEWER_GROUPS: 'family',
    });
    expect(config.enabled).toBe(true);
    expect(config.oidc?.issuer).toBe('https://auth.example.com/application/o/prunerr');
    expect(config.oidc?.providerName).toBe('Authentik');
    expect(config.oidc?.adminGroups).toEqual(['prunerr-admins', 'media-admins']);
    expect(config.oidc?.scopes).toEqual(['openid', 'profile', 'email']);
    expect(config.oidc?.groupsClaim).toBe('groups');
    expect(config.warnings).toEqual([]);
  });

  it('warns about half-configured OIDC and keeps it off', () => {
    const config = loadAuthConfig({ AUTH_ENABLED: 'true', OIDC_ISSUER_URL: 'https://auth.example.com' });
    expect(config.oidc).toBeNull();
    expect(config.warnings.some((w) => w.includes('partially configured'))).toBe(true);
    expect(config.warnings.some((w) => w.includes('no login method'))).toBe(true);
  });

  it('parses the local account', () => {
    const config = loadAuthConfig({ AUTH_ENABLED: 'true', AUTH_LOCAL_ENABLED: 'true', AUTH_LOCAL_USERNAME: 'me', AUTH_LOCAL_PASSWORD: 'longenough', AUTH_LOCAL_ROLE: 'operator' });
    expect(config.local).toEqual({ username: 'me', password: 'longenough', passwordHash: null, role: 'operator' });
  });
});
