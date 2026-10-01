/**
 * The numbers on the dashboard, computed once for the REST route and the MCP
 * connector alike.
 */
import { getDatabase } from '../db';
import mediaItemsRepo from '../db/repositories/mediaItems';
import collectionsRepo from '../db/repositories/collections';
import rulesRepo from '../db/repositories/rules';
import settingsRepo from '../db/repositories/settings';
import { getUsageForPaths, resolveTargetBytes, type FsUsage, type TargetMode } from './diskSpace';

export type DiskSeverity = 'ok' | 'soft' | 'critical';

export interface DiskPressureStats {
  diskPressureEnabled: boolean;
  diskObserveOnly: boolean;
  diskFreeBytes: number | null;
  diskTotalBytes: number | null;
  diskUsedBytes: number | null;
  diskTargetBytes: number | null;
  diskCriticalBytes: number | null;
  diskPressureSeverity: DiskSeverity | null;
  disks: Array<FsUsage & { targetBytes: number; criticalBytes: number; severity: DiskSeverity }>;
}

/**
 * Best-effort disk-pressure stats for the dashboard gauge and HA sensors.
 * Reads real free space via statfs on the configured paths; returns null
 * fields (never throws) when nothing can be read. The reported single-disk
 * fields reflect the most-pressured filesystem.
 */
export async function computeDiskPressureStats(): Promise<DiskPressureStats> {
  const enabled = settingsRepo.getBoolean('diskPressure_enabled', false);
  const observeOnly = settingsRepo.getBoolean('diskPressure_observeOnly', true);
  const empty: DiskPressureStats = {
    diskPressureEnabled: enabled,
    diskObserveOnly: observeOnly,
    diskFreeBytes: null,
    diskTotalBytes: null,
    diskUsedBytes: null,
    diskTargetBytes: null,
    diskCriticalBytes: null,
    diskPressureSeverity: null,
    disks: [],
  };

  let paths: string[] = [];
  try {
    const raw = settingsRepo.getValue('diskPressure_paths');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) paths = parsed.filter((p) => typeof p === 'string' && p.trim().length > 0);
    }
  } catch {
    /* ignore malformed paths */
  }
  if (paths.length === 0) return empty;

  const mode = (settingsRepo.getValue('diskPressure_targetMode') as TargetMode) || 'percent';
  const targetValue = settingsRepo.getNumber('diskPressure_targetValue', 10);
  const criticalValue = settingsRepo.getNumber('diskPressure_criticalValue', 5);

  const usages = await getUsageForPaths(paths);
  if (usages.length === 0) return empty;

  const disks = usages.map((fs) => {
    const targetBytes = resolveTargetBytes(fs, mode, targetValue);
    const criticalBytes = resolveTargetBytes(fs, mode, criticalValue);
    const severity: DiskSeverity =
      fs.freeBytes < criticalBytes ? 'critical' : fs.freeBytes < targetBytes ? 'soft' : 'ok';
    return { ...fs, targetBytes, criticalBytes, severity };
  });

  // Surface the most-pressured filesystem in the flat fields.
  const rank = { critical: 2, soft: 1, ok: 0 } as const;
  const worst = disks.reduce((a, b) => (rank[b.severity] > rank[a.severity] ? b : a));

  return {
    diskPressureEnabled: enabled,
    diskObserveOnly: observeOnly,
    diskFreeBytes: worst.freeBytes,
    diskTotalBytes: worst.totalBytes,
    diskUsedBytes: worst.usedBytes,
    diskTargetBytes: worst.targetBytes,
    diskCriticalBytes: worst.criticalBytes,
    diskPressureSeverity: worst.severity,
    disks,
  };
}

export interface DashboardStats extends DiskPressureStats {
  totalStorage: number;
  usedStorage: number;
  reclaimableSpace: number;
  movieCount: number;
  tvShowCount: number;
  tvEpisodeCount: number;
  unwatchedMovies: number;
  unwatchedShows: number;
  itemsMarkedForDeletion: number;
  scannedToday: number;
  scanTrend: number;
  reclaimedThisWeek: number;
  reclaimedTrend: number;
  activeRules: number;
  collectionCount: number;
  protectedCollections: number;
}

export async function getDashboardStats(): Promise<DashboardStats> {
  const db = getDatabase();

  const mediaStats = mediaItemsRepo.getStats();

  // Mirror the Queue route's filter (delete_after && marked_at) so the
  // "Reclaimable" card's count and space match what the Queue page shows.
  const pendingDeletion = mediaItemsRepo
    .getPendingDeletion()
    .filter((item) => item.delete_after && item.marked_at);

  const enabledRules = rulesRepo.rules.getEnabled();

  const pendingDeletionSize = pendingDeletion.reduce((sum, item) => sum + (item.file_size || 0), 0);

  const unwatchedMovies =
    db
      .prepare<[], { count: number }>(
        "SELECT COUNT(*) as count FROM media_items WHERE type = 'movie' AND (play_count = 0 OR play_count IS NULL)"
      )
      .get()?.count ?? 0;

  const unwatchedShows =
    db
      .prepare<[], { count: number }>(
        "SELECT COUNT(*) as count FROM media_items WHERE type = 'show' AND (play_count = 0 OR play_count IS NULL)"
      )
      .get()?.count ?? 0;

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const scannedToday =
    db
      .prepare<[string], { total: number | null }>(
        "SELECT SUM(items_scanned) as total FROM scan_history WHERE started_at >= ? AND status = 'completed'"
      )
      .get(todayStart.toISOString())?.total ?? 0;

  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - 7);
  const reclaimedThisWeek =
    db
      .prepare<[string], { total: number | null }>('SELECT SUM(file_size) as total FROM deletion_history WHERE deleted_at >= ?')
      .get(weekStart.toISOString())?.total ?? 0;

  const thisWeekStart = new Date();
  thisWeekStart.setDate(thisWeekStart.getDate() - 7);
  const lastWeekStart = new Date();
  lastWeekStart.setDate(lastWeekStart.getDate() - 14);

  const scanTrendStmt = db.prepare<[string, string], { total: number | null }>(
    "SELECT SUM(items_scanned) as total FROM scan_history WHERE started_at >= ? AND started_at < ? AND status = 'completed'"
  );
  const thisWeekScanned = scanTrendStmt.get(thisWeekStart.toISOString(), new Date().toISOString())?.total ?? 0;
  const lastWeekScanned = scanTrendStmt.get(lastWeekStart.toISOString(), thisWeekStart.toISOString())?.total ?? 0;
  const scanTrend = lastWeekScanned > 0 ? Math.round(((thisWeekScanned - lastWeekScanned) / lastWeekScanned) * 100) : 0;

  const reclaimedTrendStmt = db.prepare<[string, string], { total: number | null }>(
    'SELECT SUM(file_size) as total FROM deletion_history WHERE deleted_at >= ? AND deleted_at < ?'
  );
  const thisWeekReclaimed = reclaimedTrendStmt.get(thisWeekStart.toISOString(), new Date().toISOString())?.total ?? 0;
  const lastWeekReclaimed = reclaimedTrendStmt.get(lastWeekStart.toISOString(), thisWeekStart.toISOString())?.total ?? 0;
  const reclaimedTrend =
    lastWeekReclaimed > 0 ? Math.round(((thisWeekReclaimed - lastWeekReclaimed) / lastWeekReclaimed) * 100) : 0;

  const diskStats = await computeDiskPressureStats();
  const collections = collectionsRepo.findAll();

  return {
    totalStorage: mediaStats.totalSize,
    usedStorage: mediaStats.totalSize,
    reclaimableSpace: pendingDeletionSize,
    ...diskStats,
    movieCount: mediaStats.byType['movie'] ?? 0,
    tvShowCount: mediaStats.byType['show'] ?? 0,
    tvEpisodeCount: mediaStats.totalEpisodes ?? 0,
    unwatchedMovies,
    unwatchedShows,
    itemsMarkedForDeletion: pendingDeletion.length,
    scannedToday,
    scanTrend,
    reclaimedThisWeek,
    reclaimedTrend,
    activeRules: enabledRules.length,
    collectionCount: collections.length,
    protectedCollections: collections.filter((c) => c.is_protected).length,
  };
}
