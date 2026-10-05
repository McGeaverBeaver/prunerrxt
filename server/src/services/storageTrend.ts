/**
 * The storage trend behind the dashboard's Storage Trends card and the
 * assistant's get_storage_history: one point per day, a live point for right
 * now, and a summary that explains the change rather than just stating it.
 *
 * Library size can only move for two reasons: PrunerrXT deleted something
 * (recorded in deletion_history) or something arrived or was replaced by a
 * bigger file. So over any window:
 *
 *   change = added - reclaimed
 *
 * The summary carries all three, which is what makes a falling line
 * meaningful ("you reclaimed 4.6 TB and added 0.4 TB") instead of a shape.
 *
 * Sizes count only titles still in the library; tombstones of deleted items
 * stay in media_items for history but are not storage.
 */
import { getDatabase } from '../db';
import storageSnapshotsRepo, { type StorageSnapshot } from '../db/repositories/storageSnapshots';

export interface TrendTotals {
  totalBytes: number;
  movieBytes: number;
  showBytes: number;
  itemCount: number;
  movieCount: number;
  showCount: number;
}

export interface TrendPoint extends TrendTotals {
  /** Calendar day, YYYY-MM-DD (UTC). */
  date: string;
  /** Space PrunerrXT freed that day, and how many titles. */
  reclaimedBytes: number;
  reclaimedTitles: number;
  /** True for the live point computed now rather than a stored snapshot. */
  live: boolean;
}

export interface StorageTrend {
  days: number;
  points: TrendPoint[];
  now: TrendTotals;
  summary: {
    firstDate: string | null;
    lastDate: string | null;
    startBytes: number;
    endBytes: number;
    deltaBytes: number;
    /** Percent change over the window, rounded; null when the window started empty. */
    deltaPct: number | null;
    reclaimedBytes: number;
    reclaimedTitles: number;
    /** What arrived or grew: the change the deletions do not explain. Never negative. */
    addedBytes: number;
    movies: { startBytes: number; endBytes: number; deltaBytes: number };
    shows: { startBytes: number; endBytes: number; deltaBytes: number };
  };
}

export interface ReclaimedDay {
  date: string;
  bytes: number;
  titles: number;
}

function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

/** Pure: fold raw snapshots, per-day deletions and the live totals into the trend. */
export function buildTrend(snapshots: StorageSnapshot[], reclaimed: ReclaimedDay[], now: TrendTotals, days: number, today: string = new Date().toISOString().slice(0, 10)): StorageTrend {
  // Several snapshots can land on one day (start-ups capture one); the last
  // one of the day stands for it.
  const byDay = new Map<string, StorageSnapshot>();
  for (const s of [...snapshots].sort((a, b) => a.captured_at.localeCompare(b.captured_at))) {
    byDay.set(dayOf(s.captured_at), s);
  }
  const reclaimedByDay = new Map(reclaimed.map((r) => [r.date, r]));

  const points: TrendPoint[] = [...byDay.entries()]
    .filter(([date]) => date < today)
    .map(([date, s]) => ({
      date,
      totalBytes: s.total_size,
      movieBytes: s.movie_size,
      showBytes: s.show_size,
      itemCount: s.item_count,
      movieCount: s.movie_count,
      showCount: s.show_count,
      reclaimedBytes: reclaimedByDay.get(date)?.bytes ?? 0,
      reclaimedTitles: reclaimedByDay.get(date)?.titles ?? 0,
      live: false,
    }));
  points.push({
    date: today,
    ...now,
    reclaimedBytes: reclaimedByDay.get(today)?.bytes ?? 0,
    reclaimedTitles: reclaimedByDay.get(today)?.titles ?? 0,
    live: true,
  });

  const first = points[0]!;
  const last = points[points.length - 1]!;
  const reclaimedBytes = points.reduce((sum, p) => sum + p.reclaimedBytes, 0);
  const reclaimedTitles = points.reduce((sum, p) => sum + p.reclaimedTitles, 0);
  const deltaBytes = last.totalBytes - first.totalBytes;

  return {
    days,
    points,
    now,
    summary: {
      firstDate: first.date,
      lastDate: last.date,
      startBytes: first.totalBytes,
      endBytes: last.totalBytes,
      deltaBytes,
      deltaPct: first.totalBytes > 0 ? Math.round((deltaBytes / first.totalBytes) * 100) : null,
      reclaimedBytes,
      reclaimedTitles,
      addedBytes: Math.max(0, deltaBytes + reclaimedBytes),
      movies: { startBytes: first.movieBytes, endBytes: last.movieBytes, deltaBytes: last.movieBytes - first.movieBytes },
      shows: { startBytes: first.showBytes, endBytes: last.showBytes, deltaBytes: last.showBytes - first.showBytes },
    },
  };
}

/** What the library holds right now, the same way a snapshot measures it. */
export function liveTotals(): TrendTotals {
  const rows = getDatabase()
    .prepare<[], { type: string; bytes: number; count: number }>(
      `SELECT type, COALESCE(SUM(file_size), 0) AS bytes, COUNT(*) AS count
       FROM media_items WHERE status != 'deleted' GROUP BY type`
    )
    .all();
  const totals: TrendTotals = { totalBytes: 0, movieBytes: 0, showBytes: 0, itemCount: 0, movieCount: 0, showCount: 0 };
  for (const row of rows) {
    totals.totalBytes += row.bytes;
    totals.itemCount += row.count;
    if (row.type === 'movie') {
      totals.movieBytes = row.bytes;
      totals.movieCount = row.count;
    } else if (row.type === 'show') {
      totals.showBytes = row.bytes;
      totals.showCount = row.count;
    }
  }
  return totals;
}

export function reclaimedPerDay(days: number): ReclaimedDay[] {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - days);
  return getDatabase()
    .prepare<[string], { date: string; bytes: number | null; titles: number }>(
      `SELECT date(deleted_at) AS date, SUM(file_size) AS bytes, COUNT(*) AS titles
       FROM deletion_history WHERE deleted_at >= ? GROUP BY date(deleted_at) ORDER BY date`
    )
    .all(since.toISOString())
    .map((r) => ({ date: r.date, bytes: r.bytes ?? 0, titles: r.titles }));
}

export function getStorageTrend(days: number): StorageTrend {
  const window = Math.min(365, Math.max(1, days));
  return buildTrend(storageSnapshotsRepo.getHistory(window), reclaimedPerDay(window), liveTotals(), window);
}
