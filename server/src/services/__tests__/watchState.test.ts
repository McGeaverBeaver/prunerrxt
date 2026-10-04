import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/repositories/settings', () => ({
  default: { getNumber: () => 30 },
}));

import { computeWatchState, parseWatchState, cacheEntriesToPlays } from '../watchState';

const now = new Date('2026-10-04T12:00:00Z');
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);

describe('computeWatchState', () => {
  it('marks a movie finished by whoever reached the watched threshold', () => {
    const state = computeWatchState(
      [
        { user: 'alice', ratingKey: 'm1', watched: true, stoppedAt: daysAgo(100) },
        { user: 'bob', ratingKey: 'm1', watched: false, stoppedAt: daysAgo(2) },
        { user: 'carol', ratingKey: 'm1', watched: false, stoppedAt: daysAgo(80) },
      ],
      { isShow: false, now }
    );
    expect(state.startedBy).toEqual(['alice', 'bob', 'carol']);
    expect(state.completedBy).toEqual(['alice']);
    // bob stopped partway two days ago: in progress. carol gave up months ago: not.
    expect(state.inProgressUsers).toEqual(['bob']);
    expect(state.completion).toBe(1);
    expect(state.episodesWatched).toBe(1);
    expect(state.episodesTotal).toBeNull();
    expect(state.lastPlayedByUser['bob']).toBe(daysAgo(2).toISOString());
  });

  it('treats a show as in progress while episodes remain and the viewer keeps coming back', () => {
    const plays = [
      ...[1, 2, 3].map((i) => ({ user: 'alice', ratingKey: `e${i}`, watched: true, stoppedAt: daysAgo(10 - i) })),
      ...[1, 2, 3, 4, 5, 6].map((i) => ({ user: 'bob', ratingKey: `e${i}`, watched: true, stoppedAt: daysAgo(200 - i) })),
    ];
    const state = computeWatchState(plays, { isShow: true, episodeCount: 6, now });
    expect(state.completedBy).toEqual(['bob']);
    expect(state.inProgressUsers).toEqual(['alice']);
    expect(state.episodesWatched).toBe(6);
    expect(state.episodesTotal).toBe(6);
    expect(state.completion).toBe(1);
  });

  it('reports partial completion and no in-progress viewer when plays are old', () => {
    const plays = [1, 2].map((i) => ({ user: 'alice', ratingKey: `e${i}`, watched: true, stoppedAt: daysAgo(90) }));
    const state = computeWatchState(plays, { isShow: true, episodeCount: 8, now });
    expect(state.completedBy).toEqual([]);
    expect(state.inProgressUsers).toEqual([]);
    expect(state.completion).toBe(0.25);
  });

  it('cannot judge completion for a show without an episode count', () => {
    const state = computeWatchState([{ user: 'alice', ratingKey: 'e1', watched: true, stoppedAt: daysAgo(1) }], { isShow: true, episodeCount: null, now });
    expect(state.completion).toBeNull();
    expect(state.completedBy).toEqual([]);
    expect(state.inProgressUsers).toEqual(['alice']);
  });

  it('honours the in-progress window', () => {
    const plays = [{ user: 'alice', ratingKey: 'm1', watched: false, stoppedAt: daysAgo(20) }];
    expect(computeWatchState(plays, { isShow: false, now, inProgressDays: 30 }).inProgressUsers).toEqual(['alice']);
    expect(computeWatchState(plays, { isShow: false, now, inProgressDays: 7 }).inProgressUsers).toEqual([]);
  });

  it('round-trips through JSON and converts cache rows', () => {
    const plays = cacheEntriesToPlays([{ plex_rating_key: 'e1', username: 'alice', watched: true, stopped_at: daysAgo(1).toISOString() }]);
    expect(plays[0]).toMatchObject({ user: 'alice', ratingKey: 'e1', watched: true });
    const state = computeWatchState(plays, { isShow: true, episodeCount: 2, now });
    const parsed = parseWatchState(JSON.stringify(state));
    expect(parsed).toEqual(state);
    expect(parseWatchState('garbage')).toBeNull();
    expect(parseWatchState(null)).toBeNull();
  });
});
