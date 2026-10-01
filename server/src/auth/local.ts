/**
 * The built-in local account: one username and password from the environment.
 *
 * Passwords may be given in plain text (AUTH_LOCAL_PASSWORD) or as a scrypt
 * hash (AUTH_LOCAL_PASSWORD_HASH) produced by `scripts/hash-password.mjs`, so
 * the compose file never has to contain the password itself.
 */
import crypto from 'crypto';
import { getAuthConfig, type LocalAuthConfig, type Role } from './config';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;

function constantTimeEqual(a: string, b: string): boolean {
  // Hash both sides first so neither length nor content leaks via timing.
  const ha = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hb = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** `scrypt$N$r$p$<salt b64url>$<hash b64url>` */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export function verifyPasswordHash(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (![N, r, p].every((n) => Number.isInteger(n) && n > 0)) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4]!, 'base64url');
    expected = Buffer.from(parts[5]!, 'base64url');
  } catch {
    return false;
  }
  if (expected.length === 0) return false;
  try {
    const actual = crypto.scryptSync(password, salt, expected.length, { N, r, p, maxmem: 128 * N * r * 2 });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export interface LocalIdentity {
  username: string;
  role: Role;
}

/**
 * Check a username/password pair against the configured local account.
 * Always does the full comparison so a wrong username costs the same as a
 * wrong password.
 */
export function verifyLocalCredentials(
  username: string,
  password: string,
  local: LocalAuthConfig | null = getAuthConfig().local
): LocalIdentity | null {
  if (!local) return null;

  const userOk = constantTimeEqual(username.trim().toLowerCase(), local.username.toLowerCase());
  let passwordOk = false;
  if (local.passwordHash) {
    passwordOk = verifyPasswordHash(password, local.passwordHash);
  } else if (local.password) {
    passwordOk = constantTimeEqual(password, local.password);
  }

  if (!userOk || !passwordOk) return null;
  return { username: local.username, role: local.role };
}
