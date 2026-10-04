import { describe, it, expect } from 'vitest';
import { evaluateNode } from '../conditions';
import type { ConditionNode } from '../types';
import type { MediaItem } from '../../types';
import type { WatchState } from '../../services/watchState';

function state(overrides: Partial<WatchState> = {}): string {
  return JSON.stringify({
    startedBy: [],
    completedBy: [],
    inProgressUsers: [],
    lastPlayedByUser: {},
    episodesWatched: 0,
    episodesTotal: null,
    completion: null,
    computedAt: '2026-10-04T00:00:00Z',
    ...overrides,
  });
}

function makeItem(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id: 1,
    type: 'show',
    title: 'Show',
    plex_id: 'rk-1',
    sonarr_id: null,
    radarr_id: null,
    tmdb_id: null,
    imdb_id: null,
    tvdb_id: null,
    year: 2020,
    poster_url: null,
    file_path: null,
    file_size: 10,
    resolution: null,
    codec: null,
    added_at: null,
    last_watched_at: null,
    play_count: 0,
    watched_by: null,
    status: 'monitored',
    marked_at: null,
    delete_after: null,
    deleted_at: null,
    is_protected: false,
    protection_reason: null,
    genres: null,
    tags: null,
    studio: null,
    audio_codec: null,
    video_codec: null,
    hdr: null,
    bitrate: null,
    runtime_minutes: null,
    season_count: null,
    episode_count: null,
    series_status: null,
    rating_imdb: null,
    rating_tmdb: null,
    rating_rt: null,
    content_rating: null,
    original_language: null,
    requested_by: null,
    watch_state: null,
    in_progress: false,
    watch_completion: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const leaf = (field: string, operator: string, value: unknown): ConditionNode => ({ kind: 'condition', field, operator, value });

describe('watch-state rule fields', () => {
  it('in_progress accepts booleans and the editor\'s "true"/"false" strings', () => {
    const watching = makeItem({ in_progress: true });
    expect(evaluateNode(leaf('in_progress', 'equals', false), watching)).toBe(false);
    expect(evaluateNode(leaf('in_progress', 'equals', 'false'), watching)).toBe(false);
    expect(evaluateNode(leaf('in_progress', 'equals', 'true'), watching)).toBe(true);
    expect(evaluateNode(leaf('in_progress', 'equals', 'false'), makeItem())).toBe(true);
  });

  it('fully_watched needs everyone who started to have finished, and is never true when unknown', () => {
    expect(evaluateNode(leaf('fully_watched', 'equals', true), makeItem())).toBe(false);
    const finished = makeItem({ watch_state: state({ startedBy: ['alice', 'bob'], completedBy: ['alice', 'bob'], episodesWatched: 8, episodesTotal: 8, completion: 1 }), watch_completion: 1 });
    expect(evaluateNode(leaf('fully_watched', 'equals', 'true'), finished)).toBe(true);
    const halfway = makeItem({ watch_state: state({ startedBy: ['alice', 'bob'], completedBy: ['alice'], inProgressUsers: ['bob'], episodesWatched: 8, episodesTotal: 8, completion: 1 }), watch_completion: 1, in_progress: true });
    expect(evaluateNode(leaf('fully_watched', 'equals', true), halfway)).toBe(false);
    const gaveUp = makeItem({ watch_state: state({ startedBy: ['alice', 'bob'], completedBy: ['alice'], episodesWatched: 8, episodesTotal: 8, completion: 1 }), watch_completion: 1 });
    expect(evaluateNode(leaf('fully_watched', 'equals', true), gaveUp)).toBe(false);
  });

  it('watch_completion compares as a percentage and is null when unknown', () => {
    expect(evaluateNode(leaf('watch_completion', 'greater_than', 50), makeItem({ watch_completion: 0.75 }))).toBe(true);
    expect(evaluateNode(leaf('watch_completion', 'greater_than', 80), makeItem({ watch_completion: 0.75 }))).toBe(false);
    expect(evaluateNode(leaf('watch_completion', 'is_null', null), makeItem())).toBe(true);
  });

  it('in_progress_by and completed_by take the user-list operators', () => {
    const item = makeItem({ watch_state: state({ startedBy: ['Alice', 'bob'], completedBy: ['bob'], inProgressUsers: ['Alice'] }) });
    expect(evaluateNode(leaf('in_progress_by', 'equals', 'alice'), item)).toBe(true);
    expect(evaluateNode(leaf('in_progress_by', 'is_empty', null), item)).toBe(false);
    expect(evaluateNode(leaf('in_progress_by', 'is_empty', null), makeItem())).toBe(true);
    expect(evaluateNode(leaf('completed_by', 'in', ['bob', 'carol']), item)).toBe(true);
    expect(evaluateNode(leaf('completed_by', 'not_in', ['bob']), item)).toBe(false);
  });
});
