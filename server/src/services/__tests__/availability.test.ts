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

import { AvailabilityPausedError, checkItem, checkQueue, getAvailabilityStatus, getPause, itemsNeedingCheck, pickSeasons, probeService, resetAvailabilityState } from '../availability';

function httpError(status: number | null, headers: Record<string, string> = {}): Error {
  const error = new Error(status ? `Request failed with status code ${status}` : 'connect ECONNREFUSED') as Error & { isAxiosError: boolean; response?: unknown };
  error.isAxiosError = true;
  if (status) error.response = { status, headers };
  return error;
}

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
    getIndexerHealth: async () => ({ total: 2, failing: 0, retryAt: null }),
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

  it('answers unknown, not at risk, when the item is not linked, has no indexers, or has no app', async () => {
    expect((await checkItem(movie(5, { radarr_id: null }) as never)).report).toMatchObject({ verdict: 'unknown', reasons: ['not_linked'] });
    state.radarr!['getIndexerHealth'] = async () => ({ total: 0, failing: 0, retryAt: null });
    expect((await checkItem(movie(7) as never)).report).toMatchObject({ verdict: 'unknown', reasons: ['no_indexers'] });
    state.radarr = null;
    expect((await checkItem(movie(6) as never)).report).toMatchObject({ verdict: 'unknown', reasons: ['no_service'] });
  });

  it('pauses Radarr instead of storing a verdict when the search fails, and backs off', async () => {
    state.radarr!['getReleases'] = async () => {
      throw new Error('timeout of 120000ms exceeded');
    };
    const item = movie(4);
    await expect(checkItem(item as never)).rejects.toBeInstanceOf(AvailabilityPausedError);
    expect(item['availability']).toBeNull();
    const pause = getPause('radarr');
    expect(pause).toMatchObject({ service: 'radarr', reason: 'search_failed', failures: 1 });
    expect(new Date(pause!.until).getTime() - Date.now()).toBeGreaterThan(4 * 60_000);
    // While paused, an unforced check does not even try; a forced one does.
    const searches = vi.fn(async () => {
      throw new Error('still down');
    });
    state.radarr!['getReleases'] = searches;
    await expect(checkItem(movie(8) as never)).rejects.toBeInstanceOf(AvailabilityPausedError);
    expect(searches).not.toHaveBeenCalled();
    await expect(checkItem(movie(8) as never, { force: true })).rejects.toBeInstanceOf(AvailabilityPausedError);
    expect(searches).toHaveBeenCalledTimes(1);
    expect(getPause('radarr')?.failures).toBe(2);
    expect(getAvailabilityStatus().paused.map((p) => p.service)).toEqual(['radarr']);
  });

  it('respects a rate limit and resumes once a search answers again', async () => {
    state.radarr!['getReleases'] = async () => {
      throw httpError(429, { 'retry-after': '1200' });
    };
    await expect(checkItem(movie(4) as never)).rejects.toBeInstanceOf(AvailabilityPausedError);
    const pause = getPause('radarr')!;
    expect(pause.reason).toBe('rate_limited');
    expect(new Date(pause.until).getTime() - Date.now()).toBeGreaterThan(19 * 60_000);

    state.radarr!['getReleases'] = async () => [rel()];
    const result = await checkItem(movie(9) as never, { force: true });
    expect(result.report.verdict).toBe('replaceable');
    expect(getPause('radarr')).toBeNull();
  });

  it('pauses when every enabled indexer is backed off, until the earliest one may retry', async () => {
    const retryAt = new Date(Date.now() + 4 * 60_000).toISOString();
    state.radarr!['getIndexerHealth'] = async () => ({ total: 3, failing: 3, retryAt });
    const searches = vi.fn(async () => [rel()]);
    state.radarr!['getReleases'] = searches;
    await expect(checkItem(movie(4) as never)).rejects.toBeInstanceOf(AvailabilityPausedError);
    expect(searches).not.toHaveBeenCalled();
    expect(getPause('radarr')).toMatchObject({ reason: 'indexers_down', until: retryAt });
  });

  it('pauses for the default window when the app does not say when indexers retry', async () => {
    state.radarr!['getIndexerHealth'] = async () => ({ total: 2, failing: 2, retryAt: null });
    await expect(checkItem(movie(4) as never)).rejects.toBeInstanceOf(AvailabilityPausedError);
    const until = new Date(getPause('radarr')!.until).getTime() - Date.now();
    expect(until).toBeGreaterThan(14 * 60_000);
    expect(until).toBeLessThanOrEqual(15 * 60_000);
  });

  it('treats a 404 from the indexer probe as "no such endpoint" and searches anyway', async () => {
    state.radarr!['getIndexerHealth'] = async () => {
      throw httpError(404);
    };
    const result = await checkItem(movie(4) as never);
    expect(result.report.verdict).toBe('replaceable');
    expect(result.report.indexers).toBeNull();
    expect(getPause('radarr')).toBeNull();
    expect(await probeService('radarr')).toBe(true);
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
      getIndexerHealth: async () => ({ total: 1, failing: 0, retryAt: null }),
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

describe('lazy linking', () => {
  it('finds the Radarr movie by folder before calling the item unlinked, and remembers the id', async () => {
    state.radarr!['getMovies'] = async () => [{ id: 300, title: '300', year: 2007, path: '/movies/300 (2006)' }];
    const item = movie(30, { radarr_id: null, title: '300', year: 2007, file_path: '/data/movies/300 (2006)/300.mkv' });
    const result = await checkItem(item as never);
    expect(result.report.verdict).toBe('replaceable');
    expect(item['radarr_id']).toBe(300);
  });

  it('still answers not linked when nothing in Radarr matches', async () => {
    state.radarr!['getMovies'] = async () => [];
    const item = movie(31, { radarr_id: null, title: 'Nothing Like It', year: 1999, file_path: null });
    expect((await checkItem(item as never)).report).toMatchObject({ verdict: 'unknown', reasons: ['not_linked'] });
    expect(item['radarr_id']).toBeNull();
  });
});

describe('pickSeasons', () => {
  it('keeps the first, middle and last season that has files, skipping specials', () => {
    const seasons = [0, 1, 2, 3, 4, 5, 6].map((n) => ({ seasonNumber: n, monitored: true, statistics: { episodeFileCount: n === 3 ? 0 : 2 } }));
    expect(pickSeasons(seasons as never)).toEqual([1, 4, 6]);
    expect(pickSeasons(seasons.slice(0, 3) as never)).toEqual([1, 2]);
  });
});

describe('probeService', () => {
  it('pauses an unreachable app and resumes it when the indexers answer', async () => {
    state.radarr!['getIndexerHealth'] = async () => {
      throw httpError(null);
    };
    expect(await probeService('radarr')).toBe(false);
    expect(getPause('radarr')?.reason).toBe('unreachable');
    state.radarr!['getIndexerHealth'] = async () => ({ total: 2, failing: 1, retryAt: null });
    expect(await probeService('radarr')).toBe(true);
    expect(getPause('radarr')).toBeNull();
    state.radarr = null;
    expect(await probeService('radarr')).toBe(false);
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

  it('skips a paused service, probes it on the next pass, and carries on when it is back', async () => {
    movie(1);
    movie(2);
    const show = { id: 20, title: 'Show', type: 'show', status: 'pending_deletion', sonarr_id: 9, resolution: '1080', availability: null, availability_decision: null };
    state.items.set(20, show);
    state.sonarr = {
      findSeriesById: async () => ({ seasons: [{ seasonNumber: 1, monitored: true, statistics: { episodeFileCount: 3 } }] }),
      getIndexerHealth: async () => ({ total: 1, failing: 0, retryAt: null }),
      getSeasonReleases: async () => [rel({ fullSeason: true })],
    };
    const radarrSearches = vi.fn(async () => {
      throw httpError(503);
    });
    state.radarr!['getReleases'] = radarrSearches;

    // Radarr fails on its first item: the second movie waits, the show still gets its verdict.
    let result = await checkQueue();
    expect(result).toMatchObject({ checked: 1, paused: 2 });
    expect(result.pauses.map((p) => p.service)).toEqual(['radarr']);
    expect(radarrSearches).toHaveBeenCalledTimes(1);

    // Next pass while still paused: Radarr is not touched at all.
    result = await checkQueue();
    expect(result).toMatchObject({ checked: 0, paused: 2 });
    expect(radarrSearches).toHaveBeenCalledTimes(1);

    // Time is up and Radarr is healthy again: probe passes, both movies get verdicts.
    resetAvailabilityState({ searchGapMs: 0 });
    state.radarr!['getReleases'] = async () => [rel()];
    result = await checkQueue();
    expect(result).toMatchObject({ checked: 2, replaceable: 2, paused: 0 });
    expect(getAvailabilityStatus()).toMatchObject({ paused: [], unchecked: 0 });
  });

  it('does nothing while Archive is off', async () => {
    state.settings = { archive_enabled: 'false' };
    movie(1);
    expect(await checkQueue()).toMatchObject({ checked: 0 });
  });
});
