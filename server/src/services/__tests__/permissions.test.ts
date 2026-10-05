import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';

// Owner and mode repair on a temp tree. The tests run as whatever user the
// CI gives them, so ownership targets the current ids and the assertions are
// about modes, counting, the capability parsing and the error wording.

const { tmpDbPath } = vi.hoisted(() => {
  const osMod = require('os');
  const pathMod = require('path');
  return {
    tmpDbPath: pathMod.join(osMod.tmpdir(), `prunerr-perms-test-${process.pid}-${Date.now()}.db`),
  };
});

vi.mock('../../config', () => ({ default: { dbPath: tmpDbPath, nodeEnv: 'test' } }));
vi.mock('../../utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { initializeDatabase, getDatabase, closeDatabase } from '../../db/index';
import {
  explainPermissionError,
  fixPermissions,
  getPermissionCapabilities,
  getPermissionSettings,
  inspectPermissions,
  isPermissionError,
  readEffectiveCapabilities,
  setPermissionSettings,
} from '../permissions';

let root: string;
const uid = process.getuid?.() ?? 0;
const gid = process.getgid?.() ?? 0;

beforeAll(() => {
  initializeDatabase();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'prunerr-perms-'));
});

afterAll(() => {
  closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* ignore */ }
  }
});

beforeEach(() => {
  getDatabase().prepare("DELETE FROM settings WHERE key = 'media_permissions'").run();
});

function tree(name: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, 'Season 01'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Season 01', 'e01.mkv'), 'x');
  fs.writeFileSync(path.join(dir, 'poster.jpg'), 'y');
  fs.chmodSync(dir, 0o700);
  fs.chmodSync(path.join(dir, 'Season 01'), 0o700);
  fs.chmodSync(path.join(dir, 'Season 01', 'e01.mkv'), 0o600);
  fs.chmodSync(path.join(dir, 'poster.jpg'), 0o664);
  return dir;
}

describe('settings', () => {
  it('defaults to the running user, 0775 and 0664, and validates edits', () => {
    expect(getPermissionSettings()).toEqual({ uid, gid, dirMode: '0775', fileMode: '0664', autoFix: true });
    expect(setPermissionSettings({ dirMode: '777', fileMode: '0666', autoFix: false, uid: 99, gid: 100 })).toEqual({
      uid: 99,
      gid: 100,
      dirMode: '0777',
      fileMode: '0666',
      autoFix: false,
    });
    expect(() => setPermissionSettings({ dirMode: '9' })).toThrow(/octal/);
    expect(() => setPermissionSettings({ uid: -1 })).toThrow(/uid/);
  });
});

describe('capabilities', () => {
  it('reads CAP_CHOWN and CAP_FOWNER from a /proc status mask', () => {
    expect(readEffectiveCapabilities('Name:\tnode\nCapEff:\t0000000000000009\n')).toBe(9n);
    const withCaps = getPermissionCapabilities('CapEff:\t0000000000000009\n');
    const without = getPermissionCapabilities('CapEff:\t0000000000000000\n');
    if (uid === 0) {
      // root needs no capabilities
      expect(withCaps.canChown && without.canChown).toBe(true);
    } else {
      expect(withCaps).toMatchObject({ canChown: true, canChmod: true, reason: null });
      expect(without).toMatchObject({ canChown: false, canChmod: false });
      expect(without.reason).toMatch(/CAP_CHOWN/);
    }
  });
});

describe('inspect and fix', () => {
  it('counts wrong modes and owners, then fixes them top-down', async () => {
    const dir = tree('Show A');
    const before = await inspectPermissions(dir);
    expect(before.checked).toBe(4);
    expect(before.wrongMode).toBe(3); // dir, season dir, e01 (poster already 0664)
    expect(before.needsFix).toBe(true);
    expect(before.examples.length).toBeGreaterThan(0);

    const result = await fixPermissions(dir);
    expect(result.failed).toEqual([]);
    expect(result.changed).toBe(3);
    expect(result.unchanged).toBe(1);

    expect(fs.statSync(dir).mode & 0o777).toBe(0o775);
    expect(fs.statSync(path.join(dir, 'Season 01')).mode & 0o777).toBe(0o775);
    expect(fs.statSync(path.join(dir, 'Season 01', 'e01.mkv')).mode & 0o777).toBe(0o664);

    const after = await inspectPermissions(dir);
    expect(after).toMatchObject({ wrongMode: 0, wrongOwner: 0, needsFix: false, writable: true });
  });

  it('respects configured modes', async () => {
    const dir = tree('Show B');
    setPermissionSettings({ dirMode: '0777', fileMode: '0666' });
    await fixPermissions(dir);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o777);
    expect(fs.statSync(path.join(dir, 'poster.jpg')).mode & 0o777).toBe(0o666);
  });

  it('leaves symlinks alone', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'prunerr-perms-outside-'));
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'k');
    fs.chmodSync(path.join(outside, 'keep.txt'), 0o600);
    const dir = tree('Show C');
    fs.symlinkSync(outside, path.join(dir, 'link'), 'dir');

    const result = await fixPermissions(dir);
    expect(result.failed).toEqual([]);
    expect(fs.statSync(path.join(outside, 'keep.txt')).mode & 0o777).toBe(0o600);
    fs.rmSync(outside, { recursive: true, force: true });
  });
});

describe('explaining a permission error', () => {
  it('names the file, its owner and who PrunerrXT is', async () => {
    const dir = tree('Show D');
    const file = path.join(dir, 'poster.jpg');
    const error = Object.assign(new Error(`EACCES: permission denied, unlink '${file}'`), { code: 'EACCES', path: file });
    expect(isPermissionError(error)).toBe(true);
    expect(isPermissionError(new Error('nope'))).toBe(false);

    const text = await explainPermissionError(error, dir);
    expect(text).toContain(`Permission denied on ${file}`);
    expect(text).toContain(`owned by ${uid}:${gid} with mode 0664`);
    expect(text).toContain(`PrunerrXT runs as ${uid}:${gid}`);
  });
});
