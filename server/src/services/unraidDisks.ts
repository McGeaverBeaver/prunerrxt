/**
 * Turns the Unraid API's array listing into the rows the Disk Statistics
 * card shows.
 *
 * Two things about the API shape that are easy to get wrong:
 *
 * - Every size it reports is in kilobytes: `size` (the device) as well as
 *   `fsSize`, `fsUsed` and `fsFree` (the filesystem). Reading `size` as bytes
 *   makes a 4 TB parity drive "3.64 GB".
 * - A cache pool with several devices has one filesystem. The API puts
 *   `fsSize`/`fsUsed`/`fsFree` on the first device only; the others carry
 *   just their device size and temperature. Unraid names them `<pool>`,
 *   `<pool>2`, `<pool>3`, ... with no limit, so members are found by name:
 *   a device is a member of the pool whose name, plus a number, is its own.
 *   The pool row carries the usage; members are listed under it as devices.
 */
import type { UnraidArrayStats } from './unraid';

const KB = 1024;

export type ShapedDiskStatus = 'active' | 'standby' | 'error' | 'unknown';

export interface ShapedDisk {
  name: string;
  device: string;
  /** Bytes. For a pool member, the device's raw size; for a pool, the filesystem's. */
  size: number;
  used: number;
  free: number;
  usedPercent: number;
  temp?: number;
  status: ShapedDiskStatus;
  type: 'data' | 'parity' | 'cache';
  filesystem?: string;
  /** Cache devices only: the pool this device belongs to. */
  pool?: string;
  /** Cache devices only: 'pool' carries the filesystem; 'member' is another device in it. */
  poolRole?: 'pool' | 'member';
}

export function mapDiskStatus(status: string | null | undefined): ShapedDiskStatus {
  const statusLower = (status ?? '').toLowerCase();
  if (statusLower.includes('active') || statusLower === 'disk_ok') return 'active';
  if (statusLower.includes('standby')) return 'standby';
  if (statusLower.includes('error') || statusLower.includes('fail')) return 'error';
  return 'unknown';
}

/**
 * The pool a cache device belongs to. "cache2" belongs to "cache" when a
 * device called "cache" exists; "nvme12" belongs to "nvme1" when that
 * exists, else to "nvme" when that exists; a name with no such parent is a
 * pool of its own. The longest matching parent wins.
 */
export function poolOf(name: string, names: Iterable<string>): string {
  let best: string | null = null;
  for (const candidate of names) {
    if (candidate === name || !name.startsWith(candidate)) continue;
    const rest = name.slice(candidate.length);
    if (!/^\d+$/.test(rest) || Number(rest) < 2) continue;
    if (!best || candidate.length > best.length) best = candidate;
  }
  return best ?? name;
}

export function shapeUnraidDisks(arrayStats: UnraidArrayStats): ShapedDisk[] {
  const data: ShapedDisk[] = arrayStats.disks.map((disk) => {
    const size = disk.fsSize != null ? disk.fsSize * KB : (disk.size ?? 0) * KB;
    const used = disk.fsUsed != null ? disk.fsUsed * KB : 0;
    const free = disk.fsFree != null ? disk.fsFree * KB : 0;
    return {
      name: disk.name,
      device: disk.id || disk.name,
      size,
      used,
      free,
      usedPercent: size > 0 ? (used / size) * 100 : 0,
      temp: disk.temp ?? undefined,
      status: mapDiskStatus(disk.status),
      type: 'data',
      filesystem: disk.fsType ?? undefined,
    };
  });

  const parity: ShapedDisk[] = arrayStats.parities.map((p) => ({
    name: p.name,
    device: p.id || p.name,
    size: (p.size ?? 0) * KB,
    used: 0,
    free: 0,
    usedPercent: 0,
    temp: p.temp ?? undefined,
    status: mapDiskStatus(p.status),
    type: 'parity',
    filesystem: undefined,
  }));

  const cacheNames = arrayStats.caches.map((c) => c.name);
  const caches: ShapedDisk[] = arrayStats.caches.map((cache) => {
    const pool = poolOf(cache.name, cacheNames);
    const member = pool !== cache.name;
    if (member) {
      return {
        name: cache.name,
        device: cache.id || cache.name,
        size: (cache.size ?? 0) * KB,
        used: 0,
        free: 0,
        usedPercent: 0,
        temp: cache.temp ?? undefined,
        status: 'active',
        type: 'cache',
        filesystem: cache.fsType ?? undefined,
        pool,
        poolRole: 'member',
      };
    }
    const size = cache.fsSize != null ? cache.fsSize * KB : (cache.size ?? 0) * KB;
    const used = cache.fsUsed != null ? cache.fsUsed * KB : 0;
    const free = cache.fsFree != null ? cache.fsFree * KB : 0;
    return {
      name: cache.name,
      device: cache.id || cache.name,
      size,
      used,
      free,
      usedPercent: size > 0 ? (used / size) * 100 : 0,
      temp: cache.temp ?? undefined,
      status: 'active',
      type: 'cache',
      filesystem: cache.fsType ?? undefined,
      pool,
      poolRole: 'pool',
    };
  });

  // Members follow their pool, in the order Unraid lists them.
  const ordered: ShapedDisk[] = [];
  for (const c of caches) {
    if (c.poolRole !== 'pool') continue;
    ordered.push(c, ...caches.filter((m) => m.poolRole === 'member' && m.pool === c.name));
  }
  // A member whose parent is missing from the listing still gets shown.
  for (const c of caches) if (!ordered.includes(c)) ordered.push(c);

  return [...data, ...parity, ...ordered];
}
