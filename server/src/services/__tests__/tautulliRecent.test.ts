import { describe, it, expect, vi } from 'vitest';

vi.mock('../../utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { TautulliService } from '../tautulli';

function row(i: number, overrides: Record<string, unknown> = {}) {
  return {
    reference_id: i,
    row_id: i,
    id: i,
    date: 1_700_000_000 + i,
    started: 1_700_000_000 + i,
    stopped: 1_700_003_000 + i,
    duration: 3000,
    paused_counter: 0,
    user: 'alice',
    user_id: 1,
    friendly_name: 'Alice',
    platform: 'Roku',
    product: 'Plex for Roku',
    player: 'Living room',
    ip_address: '10.0.0.2',
    live: 0,
    machine_id: 'm',
    location: 'lan',
    secure: 1,
    relayed: 0,
    media_type: 'movie',
    rating_key: `rk${i}`,
    parent_rating_key: '',
    grandparent_rating_key: '',
    full_title: `Film ${i}`,
    title: `Film ${i}`,
    parent_title: '',
    grandparent_title: '',
    original_title: '',
    year: 2020,
    media_index: 0,
    parent_media_index: 0,
    thumb: '',
    originally_available_at: '',
    guid: '',
    transcode_decision: 'direct play',
    percent_complete: 100,
    watched_status: 1,
    group_count: 1,
    group_ids: '',
    state: null,
    session_key: null,
    ...overrides,
  };
}

describe('TautulliService.getRecentlyWatched', () => {
  it('asks for history after a calendar date, ungrouped, and pages until the filtered count is reached', async () => {
    const service = new TautulliService('http://tautulli.local:8181', 'key');
    const calls: Array<Record<string, unknown>> = [];
    const pages = [
      { recordsFiltered: 1500, recordsTotal: 9000, data: Array.from({ length: 1000 }, (_, i) => row(i)), draw: 1, filter_duration: '', total_duration: '' },
      { recordsFiltered: 1500, recordsTotal: 9000, data: Array.from({ length: 500 }, (_, i) => row(1000 + i)), draw: 2, filter_duration: '', total_duration: '' },
    ];
    vi.spyOn(service as unknown as { request: (cmd: string, params: Record<string, unknown>) => Promise<unknown> }, 'request').mockImplementation(async (_cmd, params) => {
      calls.push(params);
      return pages[calls.length - 1];
    });

    const history = await service.getRecentlyWatched(30);

    expect(history).toHaveLength(1500);
    expect(calls).toHaveLength(2);
    const first = calls[0]!;
    // "YYYY-MM-DD", never a Unix timestamp.
    expect(String(first['after'])).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(first).toMatchObject({ start: 0, length: 1000, grouping: 0, include_activity: 0 });
    expect(calls[1]).toMatchObject({ start: 1000 });
    expect(history[0]).toMatchObject({ transcodeDecision: 'direct play', watchedStatus: 1, friendlyName: 'Alice' });
  });

  it('stops on an empty page even when the count claims more', async () => {
    const service = new TautulliService('http://tautulli.local:8181', 'key');
    let n = 0;
    vi.spyOn(service as unknown as { request: () => Promise<unknown> }, 'request').mockImplementation(async () => {
      n += 1;
      return { recordsFiltered: 5000, recordsTotal: 5000, data: n === 1 ? [row(1)] : [], draw: n, filter_duration: '', total_duration: '' };
    });
    const history = await service.getRecentlyWatched(7);
    expect(history).toHaveLength(1);
    expect(n).toBe(2);
  });
});
