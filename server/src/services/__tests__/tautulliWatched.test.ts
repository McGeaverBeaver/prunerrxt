import { describe, it, expect, vi } from 'vitest';

vi.mock('../../utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { TautulliService, latestPlay } from '../tautulli';

/** A Tautulli get_history row, as the API returns it (unix seconds). */
function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    reference_id: 1,
    row_id: 1,
    id: 1,
    date: 1_700_000_000,
    started: 1_700_000_000,
    stopped: 1_700_003_600,
    duration: 3600,
    paused_counter: 0,
    user: 'alice',
    user_id: 1,
    friendly_name: 'Alice',
    platform: 'Android',
    product: 'Plex for Android (TV)',
    player: 'SHIELD Android TV',
    ip_address: '192.168.10.50',
    live: 0,
    machine_id: 'm',
    location: 'lan',
    secure: 1,
    relayed: 0,
    media_type: 'episode',
    rating_key: '31000',
    parent_rating_key: '30950',
    grandparent_rating_key: '10001',
    full_title: 'Example Daily Show - S53E251',
    title: 'S53E251',
    parent_title: 'Season 53',
    grandparent_title: 'Example Daily Show',
    original_title: '',
    year: 1973,
    media_index: 251,
    parent_media_index: 53,
    thumb: '',
    originally_available_at: '2026-09-30',
    guid: '',
    transcode_decision: 'direct play',
    percent_complete: 100,
    watched_status: 1,
    group_count: 1,
    group_ids: '1',
    state: null,
    session_key: null,
    ...overrides,
  };
}

describe('latestPlay', () => {
  it('returns the most recent stop time across every row, whatever its watched_status', () => {
    const result = latestPlay([
      { stopped: 100, date: 90, started: 90 },
      { stopped: 500, date: 450, started: 450 },
      { stopped: 300, date: 250, started: 250 },
    ]);
    expect(result?.getTime()).toBe(500 * 1000);
  });

  it('falls back to date/started when stopped is missing and returns null for no plays', () => {
    expect(latestPlay([{ stopped: 0, date: 120, started: 110 }])?.getTime()).toBe(120 * 1000);
    expect(latestPlay([])).toBeNull();
  });
});

describe('TautulliService watched status', () => {
  it('reports the last play of a show from episode rows, including partial watches', async () => {
    const service = new TautulliService('http://tautulli.local:8181', 'key');
    const requestSpy = vi.spyOn(service as unknown as { request: (cmd: string, params: Record<string, unknown>) => Promise<unknown> }, 'request');

    // Alice watched S53E251 on 2026-09-30 19:45–21:24 local time; the row
    // reports watched_status 1. An older partial watch (0.5) and a row from a
    // second user are in the history as well.
    const latestStop = Math.floor(new Date('2026-10-01T01:24:00Z').getTime() / 1000);
    requestSpy.mockResolvedValue({
      data: [
        row({ id: 3, stopped: latestStop, started: latestStop - 99 * 60, date: latestStop - 99 * 60, watched_status: 1 }),
        row({ id: 2, stopped: latestStop - 86_400, started: latestStop - 90_000, date: latestStop - 90_000, watched_status: 0.5, percent_complete: 62 }),
        row({ id: 1, stopped: latestStop - 200_000, started: latestStop - 203_000, date: latestStop - 203_000, friendly_name: 'Living Room TV', user: 'livingroom', watched_status: 1 }),
      ],
    });

    const status = await service.getShowWatchedStatus('10001', 'Example Daily Show');

    expect(requestSpy).toHaveBeenCalledWith('get_history', expect.objectContaining({ grandparent_rating_key: '10001' }));
    expect(status.playCount).toBe(3);
    expect(status.watchedBy.sort()).toEqual(['Alice', 'Living Room TV']);
    expect(status.lastWatched?.toISOString()).toBe('2026-10-01T01:24:00.000Z');
  });

  it('counts a show whose only plays are partial as watched, with a timestamp', async () => {
    const service = new TautulliService('http://tautulli.local:8181', 'key');
    vi.spyOn(service as unknown as { request: () => Promise<unknown> }, 'request').mockResolvedValue({
      data: [row({ stopped: 1_750_000_000, watched_status: 0.5, percent_complete: 40 })],
    });
    const status = await service.getShowWatchedStatus('10001');
    expect(status.playCount).toBe(1);
    expect(status.lastWatched?.getTime()).toBe(1_750_000_000 * 1000);
  });

  it('does the same for movies through getItemWatchedStatus', async () => {
    const service = new TautulliService('http://tautulli.local:8181', 'key');
    const requestSpy = vi.spyOn(service as unknown as { request: (cmd: string, params: Record<string, unknown>) => Promise<unknown> }, 'request');
    requestSpy.mockResolvedValue({
      data: [row({ media_type: 'movie', rating_key: '555', stopped: 1_760_000_000, watched_status: 1 })],
    });
    const status = await service.getItemWatchedStatus('555');
    expect(requestSpy).toHaveBeenCalledWith('get_history', expect.objectContaining({ rating_key: '555' }));
    expect(status.lastWatched?.getTime()).toBe(1_760_000_000 * 1000);
  });

  it('reports no last play when there is no history', async () => {
    const service = new TautulliService('http://tautulli.local:8181', 'key');
    vi.spyOn(service as unknown as { request: () => Promise<unknown> }, 'request').mockResolvedValue({ data: [] });
    const status = await service.getShowWatchedStatus('1');
    expect(status).toEqual({ playCount: 0, lastWatched: null, watchedBy: [], plays: [] });
  });
});
