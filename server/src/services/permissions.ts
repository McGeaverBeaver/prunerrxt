/**
 * Ownership and mode of files on the mapped media paths.
 *
 * Media directories collect files owned by whichever process wrote them: a
 * DVR running as root, a download client as another user. Prunerr runs as
 * PUID:PGID, so it can neither remove those files nor can Sonarr/Radarr
 * (running as the same ids) rename them on import. The image grants the
 * Node binary CAP_CHOWN and CAP_FOWNER, which is exactly what is needed to
 * set a file's owner and mode without owning it; nothing else is bypassed.
 * This module inspects a folder against the configured owner and modes, and
 * fixes it, so the end state is always the same whether a folder is kept or
 * deleted.
 */
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import settingsRepo from '../db/repositories/settings';
import logger from '../utils/logger';

export const PERMISSION_SETTINGS_KEY = 'media_permissions';

export interface PermissionSettings {
  /** Owner to apply; defaults to the user Prunerr runs as (PUID). */
  uid: number;
  /** Group to apply; defaults to Prunerr's group (PGID). */
  gid: number;
  /** Mode for directories, octal string, default 0775. */
  dirMode: string;
  /** Mode for files, octal string, default 0664. */
  fileMode: string;
  /** Repair a folder automatically when a delete or import would otherwise fail. */
  autoFix: boolean;
}

export interface PermissionCapabilities {
  uid: number;
  gid: number;
  /** Can set the owner of files it does not own (CAP_CHOWN or root). */
  canChown: boolean;
  /** Can set the mode of files it does not own (CAP_FOWNER or root). */
  canChmod: boolean;
  /** Human explanation when something is missing. */
  reason: string | null;
}

export interface PermissionIssueExample {
  path: string;
  uid: number;
  gid: number;
  mode: string;
  kind: 'dir' | 'file';
}

export interface PermissionReport {
  path: string;
  checked: number;
  wrongOwner: number;
  wrongMode: number;
  unreadable: number;
  /** Whether Prunerr can create and remove entries in the top folder right now. */
  writable: boolean;
  examples: PermissionIssueExample[];
  needsFix: boolean;
}

export interface FixResult {
  path: string;
  changed: number;
  unchanged: number;
  failed: Array<{ path: string; error: string }>;
}

const MAX_ENTRIES = 50_000;

function processIds(): { uid: number; gid: number } {
  return {
    uid: typeof process.getuid === 'function' ? process.getuid() : 0,
    gid: typeof process.getgid === 'function' ? process.getgid() : 0,
  };
}

function parseMode(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0o7777) return value;
  if (typeof value === 'string' && /^0?[0-7]{3,4}$/.test(value.trim())) return parseInt(value.trim(), 8);
  return fallback;
}

function formatMode(mode: number): string {
  return `0${(mode & 0o7777).toString(8).padStart(3, '0')}`;
}

export function getPermissionSettings(): PermissionSettings {
  const ids = processIds();
  const raw = settingsRepo.getJson<Partial<Record<keyof PermissionSettings, unknown>>>(PERMISSION_SETTINGS_KEY, {});
  const uid = typeof raw.uid === 'number' && Number.isInteger(raw.uid) && raw.uid >= 0 ? raw.uid : ids.uid;
  const gid = typeof raw.gid === 'number' && Number.isInteger(raw.gid) && raw.gid >= 0 ? raw.gid : ids.gid;
  return {
    uid,
    gid,
    dirMode: formatMode(parseMode(raw.dirMode, 0o775)),
    fileMode: formatMode(parseMode(raw.fileMode, 0o664)),
    autoFix: typeof raw.autoFix === 'boolean' ? raw.autoFix : true,
  };
}

export function setPermissionSettings(patch: Partial<PermissionSettings>): PermissionSettings {
  const current = getPermissionSettings();
  const next: PermissionSettings = { ...current };
  if (patch.uid !== undefined) {
    if (!Number.isInteger(patch.uid) || patch.uid < 0) throw new Error('uid must be a non-negative integer');
    next.uid = patch.uid;
  }
  if (patch.gid !== undefined) {
    if (!Number.isInteger(patch.gid) || patch.gid < 0) throw new Error('gid must be a non-negative integer');
    next.gid = patch.gid;
  }
  if (patch.dirMode !== undefined) {
    if (!/^0?[0-7]{3,4}$/.test(String(patch.dirMode).trim())) throw new Error('dirMode must be octal, e.g. 0775');
    next.dirMode = formatMode(parseInt(String(patch.dirMode).trim(), 8));
  }
  if (patch.fileMode !== undefined) {
    if (!/^0?[0-7]{3,4}$/.test(String(patch.fileMode).trim())) throw new Error('fileMode must be octal, e.g. 0664');
    next.fileMode = formatMode(parseInt(String(patch.fileMode).trim(), 8));
  }
  if (patch.autoFix !== undefined) next.autoFix = Boolean(patch.autoFix);
  settingsRepo.setJson(PERMISSION_SETTINGS_KEY, next);
  return next;
}

/** Parse the effective capability mask of this process from /proc. */
export function readEffectiveCapabilities(statusText?: string): bigint | null {
  try {
    const text = statusText ?? readFileSync('/proc/self/status', 'utf8');
    const line = text.split('\n').find((l) => l.startsWith('CapEff:'));
    if (!line) return null;
    return BigInt(`0x${line.split(/\s+/)[1] ?? '0'}`);
  } catch {
    return null;
  }
}

const CAP_CHOWN = 0n;
const CAP_FOWNER = 3n;

export function getPermissionCapabilities(statusText?: string): PermissionCapabilities {
  const ids = processIds();
  if (ids.uid === 0) return { ...ids, canChown: true, canChmod: true, reason: null };
  const caps = readEffectiveCapabilities(statusText);
  const has = (bit: bigint) => caps !== null && ((caps >> bit) & 1n) === 1n;
  const canChown = has(CAP_CHOWN);
  const canChmod = has(CAP_FOWNER);
  let reason: string | null = null;
  if (!canChown || !canChmod) {
    reason =
      caps === null
        ? 'Could not read this process\'s capabilities; permission repair may not work on this platform.'
        : `Prunerr runs as ${ids.uid}:${ids.gid} without the CAP_CHOWN/CAP_FOWNER capabilities, so it can only change files it already owns. Update to an image that grants them, or run the container with --cap-add CHOWN --cap-add FOWNER.`;
  }
  return { ...ids, canChown, canChmod, reason };
}

interface Entry {
  path: string;
  kind: 'dir' | 'file';
}

/**
 * Every directory and regular file under `root`, the directory first so a
 * fix can open it up before descending. Symlinks are listed as neither and
 * left alone: following one could lead out of the media tree.
 */
async function* walk(root: string, counter: { n: number }): AsyncGenerator<Entry> {
  yield { path: root, kind: 'dir' };
  let list: import('node:fs').Dirent[];
  try {
    list = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of list) {
    if (++counter.n > MAX_ENTRIES) return;
    const full = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) yield* walk(full, counter);
    else if (entry.isFile()) yield { path: full, kind: 'file' };
  }
}

export async function inspectPermissions(localPath: string, settings: PermissionSettings = getPermissionSettings()): Promise<PermissionReport> {
  const wantDir = parseInt(settings.dirMode, 8);
  const wantFile = parseInt(settings.fileMode, 8);
  const report: PermissionReport = { path: localPath, checked: 0, wrongOwner: 0, wrongMode: 0, unreadable: 0, writable: false, examples: [], needsFix: false };

  try {
    await fs.access(localPath, (await import('node:fs')).constants.W_OK | (await import('node:fs')).constants.X_OK);
    report.writable = true;
  } catch {
    report.writable = false;
  }

  const counter = { n: 0 };
  for await (const entry of walk(localPath, counter)) {
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(entry.path);
    } catch {
      report.unreadable += 1;
      continue;
    }
    report.checked += 1;
    const want = entry.kind === 'dir' ? wantDir : wantFile;
    const ownerWrong = stat.uid !== settings.uid || stat.gid !== settings.gid;
    const modeWrong = (stat.mode & 0o777) !== (want & 0o777);
    if (ownerWrong) report.wrongOwner += 1;
    if (modeWrong) report.wrongMode += 1;
    if ((ownerWrong || modeWrong) && report.examples.length < 5) {
      report.examples.push({ path: entry.path, uid: stat.uid, gid: stat.gid, mode: formatMode(stat.mode), kind: entry.kind });
    }
  }
  report.needsFix = !report.writable || report.wrongOwner > 0 || report.wrongMode > 0;
  return report;
}

/**
 * Set owner and mode on the folder and everything in it. The folder itself
 * goes first, so a directory nobody could enter becomes readable before its
 * contents are listed.
 */
export async function fixPermissions(localPath: string, settings: PermissionSettings = getPermissionSettings()): Promise<FixResult> {
  const caps = getPermissionCapabilities();
  const wantDir = parseInt(settings.dirMode, 8);
  const wantFile = parseInt(settings.fileMode, 8);
  const result: FixResult = { path: localPath, changed: 0, unchanged: 0, failed: [] };

  const apply = async (entry: Entry): Promise<void> => {
    const want = entry.kind === 'dir' ? wantDir : wantFile;
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(entry.path);
    } catch (error) {
      result.failed.push({ path: entry.path, error: describeFsError(error) });
      return;
    }
    let touched = false;
    try {
      if (stat.uid !== settings.uid || stat.gid !== settings.gid) {
        await fs.chown(entry.path, settings.uid, settings.gid);
        touched = true;
      }
      if ((stat.mode & 0o777) !== (want & 0o777)) {
        await fs.chmod(entry.path, want);
        touched = true;
      }
    } catch (error) {
      result.failed.push({ path: entry.path, error: describeFsError(error) });
      return;
    }
    if (touched) result.changed += 1;
    else result.unchanged += 1;
  };

  const counter = { n: 0 };
  for await (const entry of walk(localPath, counter)) {
    await apply(entry);
  }

  if (result.changed === 0 && result.failed.length > 0 && !caps.canChown) {
    throw new Error(`${result.failed[0]!.error}. ${caps.reason ?? ''}`.trim());
  }
  logger.info(`Fixed permissions under ${localPath}: ${result.changed} changed, ${result.unchanged} already right, ${result.failed.length} failed (owner ${settings.uid}:${settings.gid}, dirs ${settings.dirMode}, files ${settings.fileMode})`);
  return result;
}

export function isPermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EACCES' || code === 'EPERM';
}

function describeFsError(error: unknown): string {
  const err = error as NodeJS.ErrnoException;
  if (err?.code === 'EPERM') return `Operation not permitted on ${err.path ?? 'a file'}`;
  if (err?.code === 'EACCES') return `Permission denied on ${err.path ?? 'a file'}`;
  return err?.message ?? String(error);
}

/**
 * Turn an EACCES/EPERM from a delete into a sentence that says who owns the
 * file, who Prunerr is, and what to do about it.
 */
export async function explainPermissionError(error: unknown, fallbackPath: string): Promise<string> {
  const err = error as NodeJS.ErrnoException;
  const target = err?.path ?? fallbackPath;
  const ids = processIds();
  let owner = '';
  try {
    const stat = await fs.lstat(target);
    owner = ` It is owned by ${stat.uid}:${stat.gid} with mode ${formatMode(stat.mode)}`;
    try {
      const parent = await fs.lstat(path.dirname(target));
      owner += `, inside a folder owned by ${parent.uid}:${parent.gid} with mode ${formatMode(parent.mode)}`;
    } catch {
      /* ignore */
    }
    owner += '.';
  } catch {
    /* gone or unreadable; skip the detail */
  }
  const caps = getPermissionCapabilities();
  const hint = caps.canChown
    ? 'Use "Fix permissions" on the folder (or turn on automatic repair in Settings, Media folders) and try again.'
    : (caps.reason ?? '');
  return `Permission denied on ${target}.${owner} Prunerr runs as ${ids.uid}:${ids.gid}. ${hint}`.trim();
}
