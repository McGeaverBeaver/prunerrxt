import { describe, it, expect, vi } from 'vitest';

vi.mock('../../utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// The scanner reads service credentials from the settings table when it is
// constructed; none are needed to exercise the conversion.
vi.mock('../../db/repositories/settings', () => ({
  default: {
    getValue: () => null,
    getBoolean: (_key: string, fallback: boolean) => fallback,
    getNumber: (_key: string, fallback: number) => fallback,
    getJson: (_key: string, fallback: unknown) => fallback,
    getStartingWith: () => [],
  },
}));

import { ScannerService, latestOf } from '../scanner';
import type { PlexMediaItem } from '../types';

function plexShow(overrides: Partial<PlexMediaItem> = {}): PlexMediaItem {
  return {
    ratingKey: '10001',
    key: '/library/metadata/10001',
    type: 'show',
    title: 'Example Daily Show',
    addedAt: 1_754_000_000,
    ...overrides,
  } as PlexMediaItem;
}

describe('latestOf', () => {
  it('picks the newest of the given dates and ignores empties', () => {
    const a = new Date('2025-08-01T22:00:18Z');
    const b = new Date('2026-10-01T01:24:00Z');
    expect(latestOf(a, b)?.toISOString()).toBe(b.toISOString());
    expect(latestOf(null, a)?.toISOString()).toBe(a.toISOString());
    expect(latestOf(undefined, null)).toBeNull();
  });
});

describe('convertToMediaItemInput last_watched_at', () => {
  const scanner = new ScannerService();

  it('uses the watch-history provider timestamp over an older Plex lastViewedAt', () => {
    const input = scanner.convertToMediaItemInput({
      plexItem: plexShow({ lastViewedAt: Math.floor(new Date('2025-08-01T22:00:18Z').getTime() / 1000), viewCount: 2 }),
      tautulliData: { playCount: 36, lastWatched: new Date('2026-10-01T01:24:00Z'), watchedBy: ['alice', 'living-room-tv'] },
    });
    expect(input.last_watched_at).toBe('2026-10-01T01:24:00.000Z');
    expect(input.play_count).toBe(36);
    expect(input.watched_by).toEqual(['alice', 'living-room-tv']);
  });

  it('keeps Plex lastViewedAt when it is the newer of the two', () => {
    const input = scanner.convertToMediaItemInput({
      plexItem: plexShow({ lastViewedAt: Math.floor(new Date('2026-10-05T00:00:00Z').getTime() / 1000) }),
      tautulliData: { playCount: 3, lastWatched: new Date('2026-10-01T01:24:00Z'), watchedBy: ['alice'] },
    });
    expect(input.last_watched_at).toBe('2026-10-05T00:00:00.000Z');
  });

  it('falls back to Plex when the provider has no plays, and leaves the field alone when nobody has', () => {
    const withPlex = scanner.convertToMediaItemInput({
      plexItem: plexShow({ lastViewedAt: 1_760_000_000, viewCount: 1 }),
      tautulliData: { playCount: 0, lastWatched: null, watchedBy: [] },
    });
    expect(withPlex.last_watched_at).toBe(new Date(1_760_000_000 * 1000).toISOString());

    const nothing = scanner.convertToMediaItemInput({
      plexItem: plexShow(),
      tautulliData: { playCount: 0, lastWatched: null, watchedBy: [] },
    });
    expect(nothing.last_watched_at).toBeUndefined();
  });
});
