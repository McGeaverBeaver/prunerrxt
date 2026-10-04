/**
 * One row a day of the numbers the Insights page shows, so they can be read
 * as a trend: is the never-played share going down after the rules ran, is
 * the transcode rate climbing, has the stack been red for a week.
 *
 * Captured by the scheduler after the nightly scan (and once at startup if
 * today's row is missing), kept for a year. Each capture reads the four
 * blocks with their caches, so it costs what a page load costs.
 */
import { getDatabase } from '../../db';
import logger from '../../utils/logger';
import { getStackHealth } from './stackHealth';
import { getLibraryQuality } from './libraryQuality';
import { getWatchPatterns } from './watchPatterns';
import { getPlaybackFriction } from './playbackFriction';

export interface InsightSnapshot {
  capturedAt: string;
  stackCritical: number;
  stackWarning: number;
  libraryItems: number;
  libraryBytes: number;
  sdCount: number;
  lowQualityUnwatchedBytes: number;
  neverPlayedCount: number;
  neverPlayedBytes: number;
  quietYearBytes: number;
  plays30: number;
  viewers30: number;
  /** 0..1, null when the provider has no playback detail. */
  transcodeRate30: number | null;
}

const KEEP_DAYS = 365;

export async function captureInsightSnapshot(): Promise<InsightSnapshot> {
  const [stack, library, watching, playback] = await Promise.all([
    getStackHealth(),
    getLibraryQuality(),
    getWatchPatterns(),
    getPlaybackFriction(),
  ]);
  const sd = library.byResolution.find((b) => b.label === 'SD');
  const snapshot: InsightSnapshot = {
    capturedAt: new Date().toISOString(),
    stackCritical: stack.counts.critical,
    stackWarning: stack.counts.warning,
    libraryItems: library.totals.items,
    libraryBytes: library.totals.bytes,
    sdCount: sd?.count ?? 0,
    lowQualityUnwatchedBytes: library.lowQualityUnwatchedBytes,
    neverPlayedCount: watching.library.neverPlayed.count,
    neverPlayedBytes: watching.library.neverPlayed.bytes,
    quietYearBytes: watching.library.quietOverYear.bytes,
    plays30: watching.last30.plays,
    viewers30: watching.last30.users,
    transcodeRate30: playback.available && playback.decisions.total > 0 ? playback.decisions.transcode / playback.decisions.total : null,
  };

  const db = getDatabase();
  db.prepare(
    `INSERT INTO insight_snapshots
       (captured_at, stack_critical, stack_warning, library_items, library_bytes, sd_count, low_quality_unwatched_bytes,
        never_played_count, never_played_bytes, quiet_year_bytes, plays_30, viewers_30, transcode_rate_30)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    snapshot.capturedAt,
    snapshot.stackCritical,
    snapshot.stackWarning,
    snapshot.libraryItems,
    snapshot.libraryBytes,
    snapshot.sdCount,
    snapshot.lowQualityUnwatchedBytes,
    snapshot.neverPlayedCount,
    snapshot.neverPlayedBytes,
    snapshot.quietYearBytes,
    snapshot.plays30,
    snapshot.viewers30,
    snapshot.transcodeRate30
  );
  const cutoff = new Date(Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const pruned = db.prepare('DELETE FROM insight_snapshots WHERE captured_at < ?').run(cutoff).changes;
  if (pruned > 0) logger.info(`Pruned ${pruned} old insight snapshots`);
  return snapshot;
}

export function hasTodayInsightSnapshot(): boolean {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const row = getDatabase().prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM insight_snapshots WHERE captured_at >= ?').get(todayStart.toISOString());
  return (row?.n ?? 0) > 0;
}

interface SnapshotRow {
  captured_at: string;
  stack_critical: number;
  stack_warning: number;
  library_items: number;
  library_bytes: number;
  sd_count: number;
  low_quality_unwatched_bytes: number;
  never_played_count: number;
  never_played_bytes: number;
  quiet_year_bytes: number;
  plays_30: number;
  viewers_30: number;
  transcode_rate_30: number | null;
}

export function getInsightHistory(days = 90): InsightSnapshot[] {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  return getDatabase()
    .prepare<[string], SnapshotRow>('SELECT * FROM insight_snapshots WHERE captured_at >= ? ORDER BY captured_at ASC')
    .all(since)
    .map((r) => ({
      capturedAt: r.captured_at,
      stackCritical: r.stack_critical,
      stackWarning: r.stack_warning,
      libraryItems: r.library_items,
      libraryBytes: r.library_bytes,
      sdCount: r.sd_count,
      lowQualityUnwatchedBytes: r.low_quality_unwatched_bytes,
      neverPlayedCount: r.never_played_count,
      neverPlayedBytes: r.never_played_bytes,
      quietYearBytes: r.quiet_year_bytes,
      plays30: r.plays_30,
      viewers30: r.viewers_30,
      transcodeRate30: r.transcode_rate_30,
    }));
}
