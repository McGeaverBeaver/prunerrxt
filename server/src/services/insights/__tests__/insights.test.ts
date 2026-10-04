import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../config', () => ({
  default: { dbPath: ':memory:', nodeEnv: 'test' },
}));
vi.mock('../../../utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../init', () => ({
  getSonarrService: () => null,
  getRadarrService: () => null,
  getTautulliService: () => null,
}));

const sessionsMock = vi.hoisted(() => ({ result: null as unknown }));
vi.mock('../sessions', () => ({
  getRecentSessions: vi.fn(async () => sessionsMock.result),
}));

// media_items lookups in playbackFriction go through the database; an empty
// in-memory table is enough for codec lookups to come back null.
vi.mock('../../../db', async () => {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE media_items (id INTEGER PRIMARY KEY, plex_id TEXT, title TEXT, type TEXT, status TEXT, video_codec TEXT, codec TEXT, resolution TEXT)`);
  db.exec(`INSERT INTO media_items (plex_id, title, type, status, video_codec, resolution) VALUES ('rk1', 'Big Film', 'movie', 'monitored', 'hevc', '4k')`);
  return { getDatabase: () => db };
});

import { bucketResolution, labelCodec } from '../libraryQuality';
import { getPlaybackFriction, invalidatePlaybackFriction } from '../playbackFriction';
import { worstSeverity, countBySeverity } from '../types';

function session(overrides: Record<string, unknown>) {
  return {
    stoppedAt: new Date(),
    user: 'alice',
    mediaType: 'movie',
    ratingKey: 'rk1',
    title: 'Big Film',
    showTitle: null,
    watched: true,
    percentComplete: 100,
    durationSec: 5400,
    transcodeDecision: 'direct play',
    platform: 'Roku',
    player: 'Living room',
    product: 'Plex for Roku',
    pausedSec: 0,
    ...overrides,
  };
}

describe('insights helpers', () => {
  it('buckets the resolution strings every backend writes', () => {
    expect(bucketResolution('4k')).toBe('4K');
    expect(bucketResolution('2160')).toBe('4K');
    expect(bucketResolution('1080')).toBe('1080p');
    expect(bucketResolution('1080p')).toBe('1080p');
    expect(bucketResolution('720')).toBe('720p');
    expect(bucketResolution('sd')).toBe('SD');
    expect(bucketResolution('576')).toBe('SD');
    expect(bucketResolution('1920x800')).toBe('1080p');
    expect(bucketResolution(null)).toBe('Unknown');
    expect(bucketResolution('garbage')).toBe('Unknown');
  });

  it('labels codecs consistently', () => {
    expect(labelCodec('hevc')).toBe('HEVC');
    expect(labelCodec('h265')).toBe('HEVC');
    expect(labelCodec('h264')).toBe('H.264');
    expect(labelCodec('av1')).toBe('AV1');
    expect(labelCodec('mpeg4')).toBe('MPEG-4');
    expect(labelCodec(undefined)).toBe('Unknown');
    expect(labelCodec('prores')).toBe('PRORES');
  });

  it('ranks severities', () => {
    expect(worstSeverity([{ severity: 'info' }, { severity: 'critical' }, { severity: 'warning' }])).toBe('critical');
    expect(worstSeverity([])).toBe('ok');
    expect(countBySeverity([{ severity: 'info' }, { severity: 'info' }, { severity: 'warning' }])).toEqual({ critical: 0, warning: 1, info: 2, ok: 0 });
  });
});

describe('playback friction', () => {
  beforeEach(() => invalidatePlaybackFriction());

  it('explains itself without Tautulli', async () => {
    sessionsMock.result = { provider: 'mediaServer', days: 30, sessions: [], hasPlaybackDetail: false, note: null };
    const report = await getPlaybackFriction({ refresh: true });
    expect(report.available).toBe(false);
    expect(report.note).toContain('Tautulli');
    expect(report.items).toEqual([]);
  });

  it('finds the client that transcodes everything and the codec it chokes on', async () => {
    const roku = Array.from({ length: 6 }, (_, i) => session({ transcodeDecision: 'transcode', stoppedAt: new Date(Date.now() - i * 3600_000) }));
    const tv = Array.from({ length: 10 }, (_, i) =>
      session({ platform: 'Android TV', player: 'Shield', transcodeDecision: 'direct play', ratingKey: `rk${i + 10}`, title: `Film ${i}`, stoppedAt: new Date(Date.now() - i * 7200_000) })
    );
    sessionsMock.result = { provider: 'tautulli', days: 30, sessions: [...roku, ...tv], hasPlaybackDetail: true, note: null };

    const report = await getPlaybackFriction({ refresh: true });
    expect(report.available).toBe(true);
    expect(report.decisions).toEqual({ directPlay: 10, directStream: 0, transcode: 6, total: 16 });
    expect(report.clients[0]).toMatchObject({ client: 'Roku · Living room', plays: 6, transcodes: 6, transcodeRate: 1, codecs: ['HEVC'] });
    expect(report.titles[0]).toMatchObject({ title: 'Big Film', transcodes: 6, codec: 'HEVC', mediaItemId: 1 });
    // 6 of 16 is under the 40 % threshold for the overall warning, so the finding is the per-client one.
    expect(report.items.map((i) => i.id)).toEqual(['playback.client.Roku · Living room']);
  });

  it('counts abandoned plays and retries', async () => {
    const t0 = Date.now();
    const sessions = [
      session({ percentComplete: 5, durationSec: 120, stoppedAt: new Date(t0 - 3 * 3600_000) }),
      session({ percentComplete: 95, durationSec: 5000, stoppedAt: new Date(t0 - 1 * 3600_000) }),
      ...Array.from({ length: 20 }, (_, i) => session({ user: 'bob', percentComplete: 100, ratingKey: `rk${i + 20}`, title: `Film ${i}`, stoppedAt: new Date(t0 - (i + 5) * 3600_000) })),
    ];
    sessionsMock.result = { provider: 'tautulli', days: 30, sessions, hasPlaybackDetail: true, note: null };
    const report = await getPlaybackFriction({ refresh: true });
    expect(report.abandoned.count).toBe(1);
    expect(report.retried).toBe(1);
    expect(report.abandoned.recent[0]).toMatchObject({ title: 'Big Film', user: 'alice', percentComplete: 5 });
  });
});
