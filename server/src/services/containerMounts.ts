/**
 * The volumes mounted into this container, so the Media folders settings can
 * offer them as a pick list instead of asking for a path to be typed.
 *
 * Linux exposes every mount of the current namespace in /proc/self/mountinfo.
 * Inside a container that is the root overlay, a handful of pseudo
 * filesystems (proc, sysfs, cgroups), the files Docker binds in (/etc/hosts
 * and friends), and the volumes the user mapped — which are the only ones of
 * interest here. Everything else is filtered out by type or by path.
 *
 * Outside Linux (a developer on macOS) there is no mountinfo and the result
 * says so; the settings page then falls back to a plain text field.
 */
import fs from 'fs/promises';
import path from 'path';
import config from '../config';
import logger from '../utils/logger';

export interface ParsedMount {
  /** Where it is mounted, e.g. `/media`. */
  mountPoint: string;
  /** Filesystem type as the kernel reports it, e.g. `ext4`, `fuse.mergerfs`, `nfs4`. */
  fsType: string;
  /** The device or share, e.g. `/dev/sdb1` or `nas:/volume1/media`. */
  source: string;
  readOnly: boolean;
}

export interface ContainerMount extends ParsedMount {
  /** Directories under the mount point, up to two levels deep, as absolute paths. */
  subfolders: string[];
  /** True when the listing stopped at the cap, so deeper paths must be typed. */
  truncated: boolean;
}

export interface ContainerMountsResult {
  /** False when the platform has no mount table to read (not Linux). */
  supported: boolean;
  mounts: ContainerMount[];
}

const MOUNTINFO_PATH = '/proc/self/mountinfo';

/** Filesystem types that are never a media volume. */
const PSEUDO_FS_TYPES = new Set([
  'proc',
  'sysfs',
  'cgroup',
  'cgroup2',
  'devpts',
  'devtmpfs',
  'mqueue',
  'securityfs',
  'debugfs',
  'tracefs',
  'binfmt_misc',
  'pstore',
  'configfs',
  'fusectl',
  'bpf',
  'hugetlbfs',
  'nsfs',
  'autofs',
  'rpc_pipefs',
  'efivarfs',
  'selinuxfs',
  // Docker's own tmpfs mounts (/dev/shm, --tmpfs) hold nothing durable.
  'tmpfs',
]);

/** Mount points (and everything under them) that belong to the system or to PrunerrXT itself. */
const SYSTEM_PREFIXES = ['/proc', '/sys', '/dev', '/run', '/var/run', '/tmp', '/var/tmp', '/etc', '/var/lib/docker'];

const MAX_SUBFOLDERS = 300;
const MAX_PER_LEVEL = 100;

/** mountinfo escapes spaces, tabs, newlines and backslashes as octal. */
function unescapeMountField(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_, oct: string) => String.fromCharCode(parseInt(oct, 8)));
}

/**
 * Parse the contents of /proc/self/mountinfo. Each line is
 * `id parent major:minor root mountpoint options [optional…] - fstype source superopts`.
 * Pure, so it can be tested against captured tables.
 */
export function parseMountInfo(text: string): ParsedMount[] {
  const mounts: ParsedMount[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const separator = line.indexOf(' - ');
    if (separator === -1) continue;
    const before = line.slice(0, separator).split(' ');
    const after = line.slice(separator + 3).split(' ');
    if (before.length < 6 || after.length < 2) continue;
    const mountPoint = unescapeMountField(before[4] ?? '');
    const options = (before[5] ?? '').split(',');
    const fsType = after[0] ?? '';
    const source = unescapeMountField(after[1] ?? '');
    if (!mountPoint) continue;
    mounts.push({ mountPoint, fsType, source, readOnly: options.includes('ro') });
  }
  return mounts;
}

function underPrefix(p: string, prefix: string): boolean {
  return p === prefix || p.startsWith(`${prefix}/`);
}

/** Where PrunerrXT keeps its own files: the app directory and the data directory. */
function ownPrefixes(): string[] {
  const prefixes = new Set<string>();
  prefixes.add(path.resolve(process.cwd()));
  try {
    prefixes.add(path.resolve(path.dirname(config.dbPath)));
  } catch {
    // dbPath unset in tests
  }
  return [...prefixes];
}

/**
 * Keep the mounts a user could have mapped media into: a real filesystem on a
 * directory outside the system and app paths. The root overlay is excluded
 * because mapping a root folder to `/` is never right.
 */
export function selectMediaMounts(parsed: ParsedMount[], excludePrefixes: string[] = ownPrefixes()): ParsedMount[] {
  const byPoint = new Map<string, ParsedMount>();
  for (const mount of parsed) {
    if (mount.mountPoint === '/') continue;
    if (PSEUDO_FS_TYPES.has(mount.fsType)) continue;
    if (SYSTEM_PREFIXES.some((prefix) => underPrefix(mount.mountPoint, prefix))) continue;
    if (excludePrefixes.some((prefix) => underPrefix(mount.mountPoint, prefix))) continue;
    // A later line for the same mount point is the one currently visible.
    byPoint.set(mount.mountPoint, mount);
  }
  return [...byPoint.values()].sort((a, b) => a.mountPoint.localeCompare(b.mountPoint));
}

async function listDirectories(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'lost+found' && entry.name !== '@eaDir')
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/**
 * The directories under a mount, two levels deep and capped: enough for the
 * usual `/media/movies` and `/data/media/movies` layouts without walking a
 * large share. Order is depth-first so a parent precedes its children.
 */
async function subfoldersOf(mountPoint: string): Promise<{ subfolders: string[]; truncated: boolean }> {
  const subfolders: string[] = [];
  let truncated = false;
  const first = await listDirectories(mountPoint);
  if (first.length > MAX_PER_LEVEL) truncated = true;
  for (const name of first.slice(0, MAX_PER_LEVEL)) {
    const level1 = path.posix.join(mountPoint, name);
    subfolders.push(level1);
    const second = await listDirectories(level1);
    if (second.length > MAX_PER_LEVEL) truncated = true;
    for (const child of second.slice(0, MAX_PER_LEVEL)) {
      subfolders.push(path.posix.join(level1, child));
      if (subfolders.length >= MAX_SUBFOLDERS) return { subfolders, truncated: true };
    }
    if (subfolders.length >= MAX_SUBFOLDERS) return { subfolders, truncated: true };
  }
  return { subfolders, truncated };
}

export async function listContainerMounts(): Promise<ContainerMountsResult> {
  if (process.platform !== 'linux') return { supported: false, mounts: [] };

  let text: string;
  try {
    text = await fs.readFile(MOUNTINFO_PATH, 'utf8');
  } catch (error) {
    logger.debug(`Cannot read ${MOUNTINFO_PATH}: ${error instanceof Error ? error.message : String(error)}`);
    return { supported: false, mounts: [] };
  }

  const candidates = selectMediaMounts(parseMountInfo(text));
  const mounts: ContainerMount[] = [];
  for (const mount of candidates) {
    // Docker binds single files too (/etc/hosts is filtered above, but a
    // user can bind any file); only directories can hold media.
    try {
      const stat = await fs.stat(mount.mountPoint);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }
    const { subfolders, truncated } = await subfoldersOf(mount.mountPoint);
    mounts.push({ ...mount, subfolders, truncated });
  }
  return { supported: true, mounts };
}
