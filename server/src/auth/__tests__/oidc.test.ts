import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { groupsFromClaims, identityFromClaims, verifyJwt, OidcError, type Jwk } from '../oidc';

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function signJwt(payload: Record<string, unknown>, key: crypto.KeyObject, header: Record<string, unknown>): string {
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(payload));
  const alg = String(header['alg']);
  const data = Buffer.from(`${h}.${p}`);
  let sig: Buffer;
  if (alg.startsWith('RS')) sig = crypto.sign(`sha${alg.slice(2)}`, data, key);
  else if (alg.startsWith('ES')) sig = crypto.sign(`sha${alg.slice(2)}`, data, { key, dsaEncoding: 'ieee-p1363' });
  else if (alg.startsWith('PS')) sig = crypto.sign(`sha${alg.slice(2)}`, data, { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST });
  else sig = crypto.sign(null, data, key);
  return `${h}.${p}.${b64url(sig)}`;
}

const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const rsaJwk: Jwk = { ...(rsa.publicKey.export({ format: 'jwk' }) as Jwk), kid: 'rsa-1', use: 'sig' };
const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const ecJwk: Jwk = { ...(ec.publicKey.export({ format: 'jwk' }) as Jwk), kid: 'ec-1' };
const ed = crypto.generateKeyPairSync('ed25519');
const edJwk: Jwk = { ...(ed.publicKey.export({ format: 'jwk' }) as Jwk), kid: 'ed-1' };

const now = Math.floor(Date.now() / 1000);
const ISSUER = 'https://auth.example.com/application/o/prunerr/';
const CLIENT = 'prunerr-client';

function claims(overrides: Record<string, unknown> = {}) {
  return {
    iss: ISSUER,
    sub: 'user-123',
    aud: CLIENT,
    exp: now + 300,
    iat: now - 5,
    nonce: 'n0nce',
    preferred_username: 'alice',
    email: 'alice@example.com',
    name: 'Alice Example',
    groups: ['prunerr-admins', 'family'],
    ...overrides,
  };
}

describe('verifyJwt', () => {
  it('accepts a valid RS256 token and tolerates issuer trailing-slash differences', () => {
    const token = signJwt(claims(), rsa.privateKey, { alg: 'RS256', kid: 'rsa-1', typ: 'JWT' });
    const payload = verifyJwt(token, [ecJwk, rsaJwk], { issuer: 'https://auth.example.com/application/o/prunerr', audience: CLIENT, nonce: 'n0nce' });
    expect(payload.sub).toBe('user-123');
  });

  it('accepts ES256 and EdDSA tokens', () => {
    const es = signJwt(claims(), ec.privateKey, { alg: 'ES256', kid: 'ec-1' });
    expect(verifyJwt(es, [ecJwk], { issuer: ISSUER, audience: CLIENT, nonce: 'n0nce' }).sub).toBe('user-123');
    const eddsa = signJwt(claims(), ed.privateKey, { alg: 'EdDSA', kid: 'ed-1' });
    expect(verifyJwt(eddsa, [edJwk], { issuer: ISSUER, audience: CLIENT, nonce: 'n0nce' }).sub).toBe('user-123');
  });

  it('accepts PS256', () => {
    const token = signJwt(claims(), rsa.privateKey, { alg: 'PS256', kid: 'rsa-1' });
    expect(verifyJwt(token, [rsaJwk], { issuer: ISSUER, audience: CLIENT, nonce: 'n0nce' }).sub).toBe('user-123');
  });

  it('rejects a tampered payload', () => {
    const token = signJwt(claims(), rsa.privateKey, { alg: 'RS256', kid: 'rsa-1' });
    const [h, , s] = token.split('.') as [string, string, string];
    const forged = `${h}.${b64url(JSON.stringify(claims({ groups: ['prunerr-admins'], sub: 'attacker' })))}.${s}`;
    expect(() => verifyJwt(forged, [rsaJwk], { issuer: ISSUER, audience: CLIENT })).toThrow(/signature/);
  });

  it('rejects alg=none and HMAC tokens', () => {
    const none = `${b64url(JSON.stringify({ alg: 'none' }))}.${b64url(JSON.stringify(claims()))}.`;
    expect(() => verifyJwt(none, [rsaJwk], { issuer: ISSUER, audience: CLIENT })).toThrow(/algorithm/);
    const hs = `${b64url(JSON.stringify({ alg: 'HS256' }))}.${b64url(JSON.stringify(claims()))}.${b64url('sig')}`;
    expect(() => verifyJwt(hs, [rsaJwk], { issuer: ISSUER, audience: CLIENT })).toThrow(/algorithm/);
  });

  it('rejects wrong issuer, audience, nonce and expired tokens', () => {
    const sign = (c: Record<string, unknown>) => signJwt(c, rsa.privateKey, { alg: 'RS256', kid: 'rsa-1' });
    const opts = { issuer: ISSUER, audience: CLIENT, nonce: 'n0nce' };
    expect(() => verifyJwt(sign(claims({ iss: 'https://evil.example.com' })), [rsaJwk], opts)).toThrow(/issuer/);
    expect(() => verifyJwt(sign(claims({ aud: 'someone-else' })), [rsaJwk], opts)).toThrow(/audience/);
    expect(() => verifyJwt(sign(claims({ nonce: 'other' })), [rsaJwk], opts)).toThrow(/nonce/);
    expect(() => verifyJwt(sign(claims({ exp: now - 600 })), [rsaJwk], opts)).toThrow(/expired/);
  });

  it('reports an unknown kid distinctly so the caller can refresh the JWKS', () => {
    const token = signJwt(claims(), rsa.privateKey, { alg: 'RS256', kid: 'rotated' });
    try {
      verifyJwt(token, [rsaJwk], { issuer: ISSUER, audience: CLIENT });
      expect.fail('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(OidcError);
      expect((error as OidcError).message).toMatch(/No signing key/);
    }
  });
});

describe('claims mapping', () => {
  it('reads groups from a flat or dotted claim, and from a string list', () => {
    expect(groupsFromClaims({ groups: ['a', 'b'] }, 'groups')).toEqual(['a', 'b']);
    expect(groupsFromClaims({ realm_access: { roles: ['x'] } }, 'realm_access.roles')).toEqual(['x']);
    expect(groupsFromClaims({ groups: 'a, b c' }, 'groups')).toEqual(['a', 'b', 'c']);
    expect(groupsFromClaims({}, 'groups')).toBeNull();
  });

  it('builds an identity with sensible fallbacks', () => {
    const identity = identityFromClaims(claims() as never, { groupsClaim: 'groups', usernameClaim: 'preferred_username' }, ['family']);
    expect(identity).toMatchObject({ subject: 'user-123', username: 'alice', displayName: 'Alice Example', email: 'alice@example.com', groups: ['family'] });

    const bare = identityFromClaims({ sub: 'abc', email: 'x@y.z' } as never, { groupsClaim: 'groups', usernameClaim: 'preferred_username' }, []);
    expect(bare.username).toBe('x@y.z');
    expect(bare.displayName).toBe('x@y.z');
  });
});
