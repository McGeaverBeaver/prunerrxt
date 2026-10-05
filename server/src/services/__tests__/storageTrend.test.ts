import { describe, it, expect } from 'vitest';
import { buildTrend } from '../storageTrend';
import type { StorageSnapshot } from '../../db/repositories/storageSnapshots';

const TB = 1024 ** 4;
const snap = (captured_at: string, total: number, movie: number, items: number): StorageSnapshot => ({
  id: 0,
  total_size: total,
  movie_size: movie,
  show_size: total - movie,
  item_count: items,
  movie_count: Math.round(items * 0.7),
  show_count: items - Math.round(items * 0.7),
  space_reclaimed: 0,
  captured_at,
});

describe('storage trend', () => {
  it('keeps one point per day, ends on the live point, and explains the change', () => {
    const snapshots = [
      snap('2026-10-01 03:30:00', 6 * TB, 5 * TB, 500),
      snap('2026-10-01 21:31:09', 6 * TB, 5 * TB, 500), // restart capture, same day: ignored
      snap('2026-10-02 03:30:00', 6.1 * TB, 5.05 * TB, 505),
      snap('2026-10-03 03:30:00', 3.4 * TB, 2.4 * TB, 260),
      snap('2026-10-04 03:30:00', 3.4 * TB, 2.4 * TB, 260), // today's stored snapshot: replaced by the live point
    ];
    const reclaimed = [
      { date: '2026-10-02', bytes: 0.1 * TB, titles: 2 },
      { date: '2026-10-03', bytes: 2.8 * TB, titles: 240 },
      { date: '2026-10-04', bytes: 1.8 * TB, titles: 155 },
    ];
    const now = { totalBytes: 1.6 * TB, movieBytes: 1 * TB, showBytes: 0.6 * TB, itemCount: 82, movieCount: 49, showCount: 33 };

    const trend = buildTrend(snapshots, reclaimed, now, 30, '2026-10-04');

    expect(trend.points.map((p) => p.date)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']);
    expect(trend.points[3]).toMatchObject({ live: true, totalBytes: 1.6 * TB, reclaimedBytes: 1.8 * TB, reclaimedTitles: 155 });
    expect(trend.points[1]!.reclaimedBytes).toBe(0.1 * TB);

    const s = trend.summary;
    expect(s.startBytes).toBe(6 * TB);
    expect(s.endBytes).toBe(1.6 * TB);
    expect(s.deltaBytes).toBeCloseTo(-4.4 * TB, -6);
    expect(s.deltaPct).toBe(-73);
    expect(s.reclaimedBytes).toBeCloseTo(4.7 * TB, -6);
    expect(s.reclaimedTitles).toBe(397);
    // Down 4.4 TB while 4.7 TB was deleted: 0.3 TB arrived in the meantime.
    expect(s.addedBytes).toBeCloseTo(0.3 * TB, -6);
    expect(s.movies.deltaBytes).toBeCloseTo(-4 * TB, -6);
  });

  it('copes with an empty history: the live point alone, no percentage', () => {
    const now = { totalBytes: 2 * TB, movieBytes: 2 * TB, showBytes: 0, itemCount: 10, movieCount: 10, showCount: 0 };
    const trend = buildTrend([], [], now, 30, '2026-10-04');
    expect(trend.points).toHaveLength(1);
    expect(trend.summary).toMatchObject({ startBytes: 2 * TB, endBytes: 2 * TB, deltaBytes: 0, addedBytes: 0 });
    const empty = buildTrend([snap('2026-10-01 03:30:00', 0, 0, 0)], [], now, 30, '2026-10-04');
    expect(empty.summary.deltaPct).toBeNull();
  });
});
