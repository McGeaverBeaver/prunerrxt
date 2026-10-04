import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  settings: {} as Record<string, string>,
  items: new Map<number, Record<string, unknown>>(),
  radarr: null as null | Record<string, (...args: never[]) => unknown>,
  sonarr: null as null | Record<string, (...args: never[]) => unknown>,
  archived: [] as number[],
  activity: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../utils/logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../db/repositories/settings', () => ({
  default: {
    getValue: (key: string, fallback: string) => state.settings[key] ?? fallback,
    getBoolean: (key: string, fallback: boolean) => (key in state.settings ? state.settings[key] === 'true' : fallback),
    getNumber: (key: string, fallback: number) => (key in state.settings ? Number(state.settings[key]) : fallback),
  },
}));
vi.mock('../../db/repositories/mediaItems', () => ({
  default: {
    getById: (id: number) => state.items.get(id) ?? null,
    update: (id: number, patch: Record<string, unknown>) => {
      const item = state.items.get(id);
      if (!item) return null;
      Object.assign(item, patch);
      return item;
    },
    getPendingDeletion: () => [...state.items.values()].filter((i) => i['status'] === 'pending_deletion'),
  },
}));
vi.mock('../../db/repositories/activity', () => ({ logActivity: (entry: Record<string, unknown>) => state.activity.push(entry) }));
vi.mock('../init', () => ({ getRadarrService: () => state.radarr, getSonarrService: () => state.sonarr }));
vi.mock('../mediaActions', () => ({
  archiveItems: (ids: number[]) => {
    for (const id of ids) {
      state.archived.push(id);
      const item = state.items.get(id);
      if (item) Object.assign(item, { status: 'protected', is_protected: true, archived_at: '2026-10-04T00:00:00Z' });
    }
    return { archived: ids.map((id) => ({ id, title: 't' })), skipped: [], failed: [] };
  },
}));

import { checkItem, checkQueue, itemsNeedingCheck, pickSeasons, resetAvailabilityState } from '../availability';

const rel = (over: Record<string, unknown> = {}) => ({
  guid: 'g',
  title: 'Movie.2007.1080p',
  indexerId: 1,
  indexer: 'Idx',
  protocol: 'torrent',
  size: 8e9,
  age: 300,
  seeders: 30,
  quality: { quality: { id: 7, name: 'Bluray-1080p', resolution: 1080 } },
  ...over,
});

function movie(id: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  const item: Record<string, unknown> = { id, title: `Movie ${id}`, type: 'movie', status: 'pending_deletion', radarr_id: 100 + id, file_size: 9e9, resolution: '1080', availability: null, availability_decision: null, ...over };
  state.items.set(id, item);
  return item;
}

beforeEach(() => {
  state.settings = {};
  state.items.clear();
  state.archived = [];
  state.activity = [];
  state.radarr = {
    findMovieById: async () => ({ movieFile: { size: 9e9, quality: { quality: { name: 'Bluray-1080p', resolution: 1080 } } } }),
    getIndexerHealth: async () => ({ total: 2, failing: 0 }),
    getReleases: async () => [rel()],
  };
  state.sonarr = null;
  resetAvailabilityState({ searchGapMs: 0 });
});

describe('checkItem', () => {
  it('stores a replaceable verdict on the row and leaves the item queued', async () => {
    const item = movie(1);
    const result = await checkItem(item as never);
    expect(result.report.verdict).toBe('replaceable');
    expect(result.report.service).toBe('radarr');
    expect(result.report.current).toEqual({ sizeBytes: 9e9, resolution: 1080, qualityName: 'Bluray-1080p' });
    expect(JSON.parse(String(item['availability'])).verdict).toBe('replaceable');
    expect(item['status']).toBe('pending_deletion');
    expect(state.activity).toEqual([]);
  });

  it('holds an at-risk item in ask mode and logs why', async () => {
    state.radarr!['getReleases'] = async () => [];
    const item = movie(2);
    const result = await checkItem(item as never);
    expect(result.report.verdict).toBe('at_risk');
    expect(result.archived).toBe(false);
    expect(state.activity[0]).toMatchObject({ action: 'availability_hold', targetId: 2 });
  });

  it('archives an at-risk item at once in archive mode', async () => {
    state.settings = { archive_mode: 'archive' };
    state.radarr!['getReleases'] = async () => [rel({ quality: { quality: { id: 3, name: 'WEBDL-720p', resolution: 720 } } })];
    const item = movie(3);
    const result = await checkItem(item as never);
    expect(result.report.reasons).toEqual(['downgrade']);
    expect(result.archived).toBe(true);
    expect(state.archived).toEqual([3]);
    expect(item['status']).toBe('protected');
  });

  it('answers unknown, not at risk, when the search fails or the item is not linked', async () => {
    state.radarr!['getReleases'] = async () => {
      throw new Error('timeout of 120000ms exceeded');
    };
    expect((await checkItem(movie(4) as never)).report).toMatchObject({ verdict: 'unknown', reasons: ['search_failed'] });
    expect((await checkItem(movie(5, { radarr_id: null }) as never)).report).toMatchObject({ verdict: 'unknown', reasons: ['not_linked'] });
    state.radarr = null;
    expect((await checkItem(movie(6) as never)).report).toMatchObject({ verdict: 'unknown', reasons: ['no_service'] });
  });

  it('reuses a fresh verdict unless forced, and a forced re-check clears "delete anyway"', async () => {
    const searches = vi.fn(async () => [rel()]);
    state.radarr!['getReleases'] = searches;
    const item = movie(7);
    await checkItem(item as never);
    await checkItem(item as never);
    expect(searches).toHaveBeenCalledTimes(1);
    item['availability_decision'] = 'delete';
    await checkItem(item as never, { force: true });
    expect(searches).toHaveBeenCalledTimes(2);
    expect(item['availability_decision']).toBeNull();
  });

  it('searches a show season by season and counts the ones with a pack', async () => {
    state.sonarr = {
      findSeriesById: async () => ({
        seasons: [0, 1, 2, 3, 4, 5].map((n) => ({ seasonNumber: n, monitored: true, statistics: { episodeFileCount: n === 4 ? 0 : 3 } })),
      }),
      getIndexerHealth: async () => ({ total: 1, failing: 0 }),
      getSeasonReleases: async (_id: number, season: number) => (season === 5 ? [] : [rel({ fullSeason: true })]),
    };
    const show = { id: 20, title: 'Show', type: 'show', status: 'pending_deletion', sonarr_id: 9, resolution: '1080', availability: null, availability_decision: null };
    state.items.set(20, show);
    const result = await checkItem(show as never);
    expect(result.report.seasons).toEqual({ checked: 3, withReleases: 2 });
    expect(result.report.verdict).toBe('at_risk');
    expect(result.report.reasons).toEqual(['missing_seasons']);
  });
});

describe('pickSeasons', () => {
  it('keeps the first, middle and last season that has files, skipping specials', () => {
    const seasons = [0, 1, 2, 3, 4, 5, 6].map((n) => ({ seasonNumber: n, monitored: true, statistics: { episodeFileCount: n === 3 ? 0 : 2 } }));
    expect(pickSeasons(seasons as never)).toEqual([1, 4, 6]);
    expect(pickSeasons(seasons.slice(0, 3) as never)).toEqual([1, 2]);
  });
});

describe('checkQueue', () => {
  it('checks every queued item without a fresh verdict and tallies the outcome', async () => {
    movie(1);
    movie(2, { availability: JSON.stringify({ verdict: 'replaceable', checkedAt: new Date().toISOString(), reasons: [] }) });
    movie(3, { status: 'monitored' });
    expect(itemsNeedingCheck().map((i) => i.id)).toEqual([1]);
    const result = await checkQueue();
    expect(result).toMatchObject({ checked: 1, replaceable: 1, atRisk: 0, unknown: 0, archived: 0, skipped: 0 });
  });

  it('does nothing while Archive is off', async () => {
    state.settings = { archive_enabled: 'false' };
    movie(1);
    expect(await checkQueue()).toMatchObject({ checked: 0 });
  });
});
