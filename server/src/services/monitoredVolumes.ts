/**
 * Every volume disk pressure watches: the paths typed into Settings, read
 * with statfs inside this container, plus the volumes Sonarr and Radarr
 * report for their root folders, which need no mount here at all. A volume
 * seen both ways is counted once, with the statfs reading kept because it is
 * measured where Prunerr can act.
 */
import { getUsageForPaths, type FsUsage } from './diskSpace';
import { getArrVolumes, includesArrVolumes, sameVolume } from './arrDiskSpace';

export async function getMonitoredUsage(paths: string[], options: { refresh?: boolean } = {}): Promise<FsUsage[]> {
  const local = (await getUsageForPaths(paths)).map((u) => ({ ...u, source: 'statfs' as const }));
  const result: FsUsage[] = [...local];
  if (!includesArrVolumes()) return result;

  const arr = await getArrVolumes(options);
  for (const volume of arr) {
    if (result.some((u) => sameVolume(u, volume))) continue;
    result.push({
      path: volume.path,
      totalBytes: volume.totalBytes,
      freeBytes: volume.freeBytes,
      usedBytes: volume.usedBytes,
      key: volume.key,
      source: volume.source,
      reportedBy: volume.reportedBy,
    });
  }
  return result;
}

/** Every path prefix that names a volume, as any app sees it, for ranking candidates on it. */
export function pathPrefixesFor(usage: FsUsage): string[] {
  const prefixes = new Set<string>([usage.path]);
  for (const label of usage.reportedBy ?? []) {
    const idx = label.indexOf(':');
    if (idx !== -1) prefixes.add(label.slice(idx + 1));
  }
  return [...prefixes].filter((p) => p.length > 0);
}
