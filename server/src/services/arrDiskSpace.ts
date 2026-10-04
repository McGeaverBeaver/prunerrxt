/**
 * Free and total space as Sonarr and Radarr see their volumes.
 *
 * Both apps expose `/diskspace`: one row per filesystem that holds a root
 * folder, with free and total bytes, measured inside their own container.
 * That needs no mount in Prunerr at all, which makes disk pressure work on
 * any install, not only ones where a media path was typed in by hand.
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

/** Merge the raw rows from both apps into distinct volumes. Pure, for tests. */
export function mergeArrVolumes(rows: Array<{ source: 'sonarr' | 'radarr'; path: string; freeSpace: number; totalSpace: number }>): ArrVolume[] {
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

export async function getArrVolumes(options: { refresh?: boolean } = {}): Promise<ArrVolume[]> {
  if (!options.refresh && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.volumes;

  const rows: Array<{ source: 'sonarr' | 'radarr'; path: string; freeSpace: number; totalSpace: number }> = [];
  const sonarr = getSonarrService();
  const radarr = getRadarrService();
  const reads = await Promise.allSettled([
    sonarr ? sonarr.getDiskSpace() : Promise.resolve([]),
    radarr ? radarr.getDiskSpace() : Promise.resolve([]),
  ]);
  const [s, r] = reads;
  if (s.status === 'fulfilled') rows.push(...s.value.map((d) => ({ source: 'sonarr' as const, ...d })));
  else logger.debug(`Sonarr disk space unavailable: ${s.reason instanceof Error ? s.reason.message : String(s.reason)}`);
  if (r.status === 'fulfilled') rows.push(...r.value.map((d) => ({ source: 'radarr' as const, ...d })));
  else logger.debug(`Radarr disk space unavailable: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);

  const volumes = mergeArrVolumes(rows);
  cached = { at: Date.now(), volumes };
  return volumes;
}

export function invalidateArrVolumes(): void {
  cached = null;
}
