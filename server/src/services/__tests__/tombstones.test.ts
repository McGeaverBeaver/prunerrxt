import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/repositories/settings', () => ({
  default: {
    getJson: vi.fn(() => [{ remotePath: '/movies', localPath: '/mnt/movies' }]),
    setJson: vi.fn(),
    get: vi.fn(),
    set: vi.fn(),
  },
}));
vi.mock('../../utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { decideRevive, gatherEvidence, PLEX_TRASH_GRACE_DAYS, type TombstoneEvidence } from '../tombstones';

const now = new Date('2026-10-05T12:00:00Z');
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();

function evidence(over: Partial<TombstoneEvidence> = {}): TombstoneEvidence {
  return { arrHasFile: null, localFileExists: null, plexTrashed: false, addedAt: null, ...over };
}

describe('decideRevive', () => {
  // The install that started this: rows marked deleted on day one while
  // Radarr still had every file. Radarr's word is enough to bring them back.
  it('revives when Radarr or Sonarr still has the file', () => {
    const d = decideRevive(daysAgo(1), evidence({ arrHasFile: true }), now);
    expect(d.revive).toBe(true);
    expect(d.reason).toMatch(/still has its file/);
  });

  it('keeps the tombstone when the app reports no file, whatever else says', () => {
    const d = decideRevive(daysAgo(30), evidence({ arrHasFile: false, localFileExists: true, addedAt: now.toISOString() }), now);
    expect(d.revive).toBe(false);
  });

  it('revives when the file is on a mounted path and the app was not asked', () => {
    expect(decideRevive(daysAgo(1), evidence({ localFileExists: true }), now).revive).toBe(true);
  });

  it('keeps the tombstone when the mounted file is gone', () => {
    expect(decideRevive(daysAgo(30), evidence({ localFileExists: false, addedAt: now.toISOString() }), now).revive).toBe(false);
  });

  it('keeps the tombstone when Plex has trashed the entry', () => {
    expect(decideRevive(daysAgo(30), evidence({ plexTrashed: true }), now).revive).toBe(false);
  });

  it('revives a genuine re-add: Plex added it after the deletion', () => {
    const d = decideRevive(daysAgo(3), evidence({ addedAt: daysAgo(1) }), now);
    expect(d.revive).toBe(true);
    expect(d.reason).toMatch(/after the deletion/);
  });

  it('waits for Plex to notice a fresh deletion, then trusts the listing', () => {
    const fresh = decideRevive(daysAgo(1), evidence({ addedAt: daysAgo(400) }), now);
    expect(fresh.revive).toBe(false);
    const old = decideRevive(daysAgo(PLEX_TRASH_GRACE_DAYS + 1), evidence({ addedAt: daysAgo(400) }), now);
    expect(old.revive).toBe(true);
  });

  it('never revives on no evidence when the deletion date is unknown', () => {
    expect(decideRevive(null, evidence({ addedAt: daysAgo(1) }), now).revive).toBe(false);
  });
});

describe('gatherEvidence', () => {
  it('reads Radarr hasFile and checks the mapped path', () => {
    const exists = vi.fn(() => true);
    const e = gatherEvidence(
      { addedAt: 1_600_000_000, deletedAt: undefined },
      { radarrId: 1, radarrMovie: { hasFile: true } as never },
      '/movies/Tenet (2020)/Tenet (2020).mkv',
      exists
    );
    expect(e.arrHasFile).toBe(true);
    expect(e.localFileExists).toBe(true);
    expect(exists).toHaveBeenCalledWith('/mnt/movies/Tenet (2020)/Tenet (2020).mkv');
    expect(e.plexTrashed).toBe(false);
    expect(e.addedAt).toBe('2020-09-13T12:26:40.000Z');
  });

  it('counts Sonarr episode files and leaves unmapped paths unknown', () => {
    const e = gatherEvidence(
      { addedAt: 0, deletedAt: 1_700_000_000 },
      { sonarrId: 2, sonarrSeries: { statistics: { episodeFileCount: 0 } } as never },
      '/tv/Some Show',
      () => true
    );
    expect(e.arrHasFile).toBe(false);
    expect(e.localFileExists).toBeNull();
    expect(e.plexTrashed).toBe(true);
    expect(e.addedAt).toBeNull();
  });

  it('knows nothing when neither app nor mount can be asked', () => {
    const e = gatherEvidence({ addedAt: 0 }, undefined, null);
    expect(e).toEqual({ arrHasFile: null, localFileExists: null, plexTrashed: false, addedAt: null });
  });
});
