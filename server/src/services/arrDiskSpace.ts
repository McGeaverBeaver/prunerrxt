/**
 * Free and total space as Sonarr and Radarr see their volumes.
 *
 * Both apps expose `/diskspace`: one row per filesystem, with free and total
 * bytes, measured inside their own container. That needs no mount in PrunerrXT
 * at all, which makes disk pressure work on any install, not only ones where
 * a media path was typed in by hand.
 *
 * The list is every mount the app can see, though, not only the media ones:
 * the container's own `/` (the Docker image layer, usually on an appdata or
 * cache pool) and `/config` come back too. Those have nothing to do with
 * where media lives, so only the mounts that actually hold one of the app's
 * root folders are kept. The mount holding a root folder is the longest
 * mount path that is a prefix of it: `/data/movies` on `/data`, not on `/`.
 *
 * The same physical volume often shows up twice (Sonarr sees it as /tv,
 * Radarr as /movies, or both as /data). Rows whose total and free bytes
 * agree within a small tolerance are merged into one volume with every
 * path that reported it.
 */
import logger from '../utils/logger';
import settingsRepo from '../db/repositories/settings';
import { getRadarrService, getSonarrService } from './init';

export interface ArrVolume {
  /** The first path that reported it, as the app sees it. */
  path: string;
  /** Every `app:path` pair that resolved to this volume. */
  reportedBy: string[];
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  /** Stable identity for dedupe against statfs results. */
  key: string;
  source: 'sonarr' | 'radarr';
}

export interface ArrDiskRow {
  source: 'sonarr' | 'radarr';
  path: string;
  freeSpace: number;
  totalSpace: number;
}

/** `diskPressure_includeArrVolumes`: off to monitor typed paths only. */
export const INCLUDE_ARR_VOLUMES_SETTING = 'diskPressure_includeArrVolumes';

export function includesArrVolumes(): boolean {
  return settingsRepo.getBoolean(INCLUDE_ARR_VOLUMES_SETTING, true);
}

const CACHE_TTL_MS = 5 * 60_000;
let cached: { at: number; volumes: ArrVolume[] } | null = null;

/** Two reports describe one volume when total and free agree within 0.5 %. */
export function sameVolume(a: { totalBytes: number; freeBytes: number }, b: { totalBytes: number; freeBytes: number }): boolean {
  if (a.totalBytes <= 0 || b.totalBytes <= 0) return false;
  const close = (x: number, y: number) => Math.abs(x - y) <= Math.max(x, y) * 0.005;
  return close(a.totalBytes, b.totalBytes) && close(a.freeBytes, b.freeBytes);
}

/** Forward slashes, no trailing slash (except the root itself), case kept. */
function normalisePath(p: string): string {
  const slashed = p.replace(/\\/g, '/');
  if (slashed.length > 1 && slashed.endsWith('/')) return slashed.replace(/\/+$/, '') || '/';
  return slashed;
}

function isPrefixMount(mount: string, folder: string): boolean {
  if (mount === '/') return true;
  if (folder === mount) return true;
  return folder.startsWith(mount.endsWith('/') ? mount : `${mount}/`);
}

/**
 * The mount holding each root folder: the longest mount path that is a
 * prefix of it. A root folder matched by no mount at all is ignored (it is
 * usually inaccessible). Pure, for tests.
 */
export function mountsHoldingRootFolders(mounts: string[], rootFolders: string[]): Set<string> {
  const kept = new Set<string>();
  const normalisedMounts = mounts.map((m) => ({ raw: m, norm: normalisePath(m) }));
  for (const folder of rootFolders) {
    const target = normalisePath(folder);
    let best: { raw: string; norm: string } | null = null;
    for (const mount of normalisedMounts) {
      if (!isPrefixMount(mount.norm, target)) continue;
      if (!best || mount.norm.length > best.norm.length) best = mount;
    }
    if (best) kept.add(best.raw);
  }
  return kept;
}

/**
 * Keep only the rows that hold one of the app's root folders. An app whose
 * root folders are unknown (the lookup failed) keeps every row it reported,
 * since dropping its media volume would be worse than showing one too many.
 */
export function rowsHoldingRootFolders(rows: ArrDiskRow[], rootFolders: Partial<Record<'sonarr' | 'radarr', string[] | null>>): ArrDiskRow[] {
  const out: ArrDiskRow[] = [];
  for (const source of ['sonarr', 'radarr'] as const) {
    const own = rows.filter((r) => r.source === source);
    if (own.length === 0) continue;
    const folders = rootFolders[source];
    if (!folders) {
      out.push(...own);
      continue;
    }
    const kept = mountsHoldingRootFolders(own.map((r) => r.path), folders);
    out.push(...own.filter((r) => kept.has(r.path)));
  }
  return out;
}

/** Merge the raw rows from both apps into distinct volumes. Pure, for tests. */
export function mergeArrVolumes(rows: ArrDiskRow[]): ArrVolume[] {
  const volumes: ArrVolume[] = [];
  for (const row of rows) {
    if (!Number.isFinite(row.totalSpace) || row.totalSpace <= 0) continue;
    const free = Number.isFinite(row.freeSpace) ? Math.max(0, row.freeSpace) : 0;
    const label = `${row.source}:${row.path}`;
    const existing = volumes.find((v) => sameVolume(v, { totalBytes: row.totalSpace, freeBytes: free }));
    if (existing) {
      if (!existing.reportedBy.includes(label)) existing.reportedBy.push(label);
      continue;
    }
    volumes.push({
      path: row.path,
      reportedBy: [label],
      totalBytes: row.totalSpace,
      freeBytes: free,
      usedBytes: Math.max(0, row.totalSpace - free),
      key: `arr:${row.totalSpace}:${Math.round(free / (64 * 1024 * 1024))}`,
      source: row.source,
    });
  }
  return volumes.sort((a, b) => a.path.localeCompare(b.path));
}

function describeFailure(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export async function getArrVolumes(options: { refresh?: boolean } = {}): Promise<ArrVolume[]> {
  if (!options.refresh && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.volumes;

  const rows: ArrDiskRow[] = [];
  const rootFolders: Partial<Record<'sonarr' | 'radarr', string[] | null>> = {};
  const sonarr = getSonarrService();
  const radarr = getRadarrService();
  const [s, r, sRoots, rRoots] = await Promise.allSettled([
    sonarr ? sonarr.getDiskSpace() : Promise.resolve([]),
    radarr ? radarr.getDiskSpace() : Promise.resolve([]),
    sonarr ? sonarr.getRootFolders() : Promise.resolve([]),
    radarr ? radarr.getRootFolders() : Promise.resolve([]),
  ]);
  if (s.status === 'fulfilled') rows.push(...s.value.map((d) => ({ source: 'sonarr' as const, ...d })));
  else logger.debug(`Sonarr disk space unavailable: ${describeFailure(s.reason)}`);
  if (r.status === 'fulfilled') rows.push(...r.value.map((d) => ({ source: 'radarr' as const, ...d })));
  else logger.debug(`Radarr disk space unavailable: ${describeFailure(r.reason)}`);

  if (sRoots.status === 'fulfilled') rootFolders.sonarr = sRoots.value.map((f) => f.path);
  else logger.debug(`Sonarr root folders unavailable, keeping every reported volume: ${describeFailure(sRoots.reason)}`);
  if (rRoots.status === 'fulfilled') rootFolders.radarr = rRoots.value.map((f) => f.path);
  else logger.debug(`Radarr root folders unavailable, keeping every reported volume: ${describeFailure(rRoots.reason)}`);

  const mediaRows = rowsHoldingRootFolders(rows, rootFolders);
  const dropped = rows.length - mediaRows.length;
  if (dropped > 0) {
    logger.debug(`Ignoring ${dropped} reported volume(s) that hold no root folder: ${rows.filter((x) => !mediaRows.includes(x)).map((x) => `${x.source}:${x.path}`).join(', ')}`);
  }

  const volumes = mergeArrVolumes(mediaRows);
  cached = { at: Date.now(), volumes };
  return volumes;
}

export function invalidateArrVolumes(): void {
  cached = null;
}
