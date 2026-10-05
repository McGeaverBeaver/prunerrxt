import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';

// A real SQLite file: the recommendation window is a SQL predicate.
const { tmpDbPath } = vi.hoisted(() => {
  const osMod = require('os') as typeof import('os');
  const pathMod = require('path') as typeof import('path');
  return { tmpDbPath: pathMod.join(osMod.tmpdir(), `prunerr-unwatched-test-${process.pid}-${Date.now()}.db`) };
});

vi.mock('../../config', () => ({
  default: { dbPath: tmpDbPath, nodeEnv: 'test', mediaServer: { type: 'plex' }, plex: { url: '', token: '' }, jellyfin: { url: '', apiKey: '' } },
}));
vi.mock('../../utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { initializeDatabase, closeDatabase } from '../index';
import mediaItemsRepo from '../repositories/mediaItems';

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

describe('getUnwatched: the recommendation window', () => {
  beforeAll(() => {
    initializeDatabase();
    // Never played, in the library for a year: stale.
    mediaItemsRepo.create({ type: 'movie', title: 'Old and never played', plex_id: 'p1', added_at: daysAgo(365), play_count: 0, status: 'monitored' });
    // Never played, added last week: new, not stale.
    mediaItemsRepo.create({ type: 'show', title: 'Added last week', plex_id: 'p2', added_at: daysAgo(6), play_count: 0, status: 'monitored' });
    // Never played, added just inside the window: still new.
    mediaItemsRepo.create({ type: 'movie', title: 'Added 89 days ago', plex_id: 'p3', added_at: daysAgo(89), play_count: 0, status: 'monitored' });
    // Played, but not for a long time: stale.
    mediaItemsRepo.create({ type: 'movie', title: 'Watched long ago', plex_id: 'p4', added_at: daysAgo(400), play_count: 3, last_watched_at: daysAgo(200), status: 'monitored' });
    // Played recently: not stale.
    mediaItemsRepo.create({ type: 'show', title: 'Watched recently', plex_id: 'p5', added_at: daysAgo(400), play_count: 9, last_watched_at: daysAgo(10), status: 'monitored' });
    // Never played and old, but already queued: only monitored items are candidates.
    mediaItemsRepo.create({ type: 'movie', title: 'Old and queued', plex_id: 'p6', added_at: daysAgo(365), play_count: 0, status: 'pending_deletion' });
  });

  afterAll(() => {
    closeDatabase();
    fs.rmSync(tmpDbPath, { force: true });
  });

  it('leaves out never-played titles that were added inside the window', () => {
    const titles = mediaItemsRepo.getUnwatched(90).map((i) => i.title).sort();
    expect(titles).toEqual(['Old and never played', 'Watched long ago']);
  });

  it('counts a never-played title once it has been in the library longer than the window', () => {
    expect(mediaItemsRepo.getUnwatched(5).map((i) => i.title).sort()).toEqual(['Added 89 days ago', 'Added last week', 'Old and never played', 'Watched long ago', 'Watched recently']);
    expect(mediaItemsRepo.getUnwatched(88).map((i) => i.title)).toContain('Added 89 days ago');
    expect(mediaItemsRepo.getUnwatched(90).map((i) => i.title)).not.toContain('Added 89 days ago');
  });
});
