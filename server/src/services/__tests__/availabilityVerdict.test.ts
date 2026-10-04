import { describe, it, expect, vi } from 'vitest';

const settings = vi.hoisted(() => ({ values: {} as Record<string, string> }));
vi.mock('../../db/repositories/settings', () => ({
  default: {
    getValue: (key: string, fallback: string) => settings.values[key] ?? fallback,
    getBoolean: (key: string, fallback: boolean) => (key in settings.values ? settings.values[key] === 'true' : fallback),
    getNumber: (key: string, fallback: number) => (key in settings.values ? Number(settings.values[key]) : fallback),
  },
}));

import {
  bestRelease,
  describeReasons,
  getArchiveSettings,
  holdState,
  isStale,
  judge,
  parseAvailability,
  parseResolution,
  summariseRelease,
  type ReleaseSummary,
} from '../availabilityVerdict';

const release = (over: Partial<ReleaseSummary> = {}): ReleaseSummary => ({
  title: 'Movie.2007.1080p.BluRay',
  indexer: 'Idx',
  protocol: 'torrent',
  sizeBytes: 8e9,
  ageDays: 400,
  seeders: 20,
  resolution: 1080,
  qualityName: 'Bluray-1080p',
  ...over,
});

const current = { sizeBytes: 9e9, resolution: 1080, qualityName: 'Bluray-1080p' };
const healthy = { total: 4, failing: 0 };

describe('judge', () => {
  it('is replaceable when something as good is on offer with seeders to spare', () => {
    const v = judge({ current, releases: [release(), release({ protocol: 'usenet', seeders: null })], indexers: healthy, minSeeders: 5 });
    expect(v.verdict).toBe('replaceable');
    expect(v.reasons).toEqual([]);
    expect(v.usenet).toBe(1);
    expect(v.torrents).toBe(1);
    expect(v.maxSeeders).toBe(20);
    expect(v.best?.resolution).toBe(1080);
  });

  it('is at risk with no releases, unless every indexer is down', () => {
    expect(judge({ current, releases: [], indexers: healthy, minSeeders: 5 })).toMatchObject({ verdict: 'at_risk', reasons: ['no_releases'] });
    expect(judge({ current, releases: [], indexers: { total: 3, failing: 3 }, minSeeders: 5 })).toMatchObject({ verdict: 'unknown', reasons: ['indexers_down'] });
    expect(judge({ current, releases: [], indexers: null, minSeeders: 5 }).verdict).toBe('at_risk');
  });

  it('flags a downgrade when the best release is a lower resolution than the file', () => {
    const v = judge({ current: { ...current, resolution: 2160 }, releases: [release()], indexers: healthy, minSeeders: 5 });
    expect(v.verdict).toBe('at_risk');
    expect(v.reasons).toEqual(['downgrade']);
    expect(describeReasons(v as never)).toContain('1080p');
  });

  it('flags torrent-only releases that hang on a few seeders, but not when usenet has it', () => {
    const thin = judge({ current, releases: [release({ seeders: 2 })], indexers: healthy, minSeeders: 5 });
    expect(thin.reasons).toEqual(['low_seeders']);
    const usenet = judge({ current, releases: [release({ seeders: 2 }), release({ protocol: 'usenet', seeders: null })], indexers: healthy, minSeeders: 5 });
    expect(usenet.verdict).toBe('replaceable');
  });

  it('flags releases that are all far smaller than the file at the same resolution', () => {
    const v = judge({ current, releases: [release({ sizeBytes: 2e9 }), release({ sizeBytes: 3e9 })], indexers: healthy, minSeeders: 5 });
    expect(v.reasons).toEqual(['smaller']);
  });

  it('ignores lower-resolution releases when judging size and seeders', () => {
    const v = judge({
      current,
      releases: [release({ resolution: 720, sizeBytes: 1e9, seeders: 500 }), release({ seeders: 1 })],
      indexers: healthy,
      minSeeders: 5,
    });
    expect(v.reasons).toEqual(['low_seeders']);
  });

  it('flags a show whose checked seasons do not all have a pack', () => {
    const v = judge({ current: { sizeBytes: null, resolution: null, qualityName: null }, releases: [release()], indexers: healthy, seasons: { checked: 3, withReleases: 2 }, minSeeders: 5 });
    expect(v.reasons).toEqual(['missing_seasons']);
    expect(describeReasons(v as never)).toContain('1 of 3');
  });

  it('does not compare when the file resolution is unknown', () => {
    const v = judge({ current: { sizeBytes: 9e9, resolution: null, qualityName: null }, releases: [release({ resolution: 720 })], indexers: healthy, minSeeders: 5 });
    expect(v.verdict).toBe('replaceable');
  });
});

describe('helpers', () => {
  it('summarises an Arr release and parses resolutions', () => {
    expect(summariseRelease({ title: 't', indexer: 'i', protocol: 'usenet', size: 100, age: 3, quality: { quality: { name: 'WEBDL-2160p', resolution: 2160 } } })).toMatchObject({ protocol: 'usenet', seeders: null, resolution: 2160, qualityName: 'WEBDL-2160p' });
    expect(parseResolution('4k')).toBe(2160);
    expect(parseResolution('1080')).toBe(1080);
    expect(parseResolution('sd')).toBe(480);
    expect(parseResolution(null)).toBeNull();
  });

  it('picks the highest resolution, then the largest, as best', () => {
    expect(bestRelease([release({ sizeBytes: 1 }), release({ resolution: 2160, sizeBytes: 5 }), release({ resolution: 2160, sizeBytes: 9 })])?.sizeBytes).toBe(9);
    expect(bestRelease([])).toBeNull();
  });

  it('round-trips a stored verdict and rejects garbage', () => {
    const v = { ...judge({ current, releases: [release()], indexers: healthy, minSeeders: 5 }), service: 'radarr' as const };
    expect(parseAvailability(JSON.stringify(v))).toMatchObject({ verdict: 'replaceable', service: 'radarr', releases: 1 });
    expect(parseAvailability('{"verdict":"maybe"}')).toBeNull();
    expect(parseAvailability('nope')).toBeNull();
    expect(parseAvailability(null)).toBeNull();
  });

  it('treats a missing or old verdict as stale', () => {
    const now = new Date('2026-10-04T00:00:00Z');
    expect(isStale(null, 7, now)).toBe(true);
    expect(isStale({ checkedAt: '2026-10-01T00:00:00Z' } as never, 7, now)).toBe(false);
    expect(isStale({ checkedAt: '2026-09-01T00:00:00Z' } as never, 7, now)).toBe(true);
  });
});

describe('holdState', () => {
  const atRisk = JSON.stringify({ ...judge({ current, releases: [], indexers: healthy, minSeeders: 5 }), service: 'radarr' });
  const fine = JSON.stringify({ ...judge({ current, releases: [release()], indexers: healthy, minSeeders: 5 }), service: 'radarr' });

  it('holds at-risk, unknown and unchecked items in ask mode until a person decides', () => {
    settings.values = {};
    expect(getArchiveSettings()).toEqual({ enabled: true, mode: 'ask', minSeeders: 5, recheckDays: 7 });
    expect(holdState({ availability: atRisk, availability_decision: null })).toMatchObject({ held: true, reason: 'at_risk' });
    expect(holdState({ availability: null, availability_decision: null })).toMatchObject({ held: true, reason: 'unchecked' });
    expect(holdState({ availability: fine, availability_decision: null })).toMatchObject({ held: false, reason: null });
    expect(holdState({ availability: atRisk, availability_decision: 'delete' })).toMatchObject({ held: false });
  });

  it('holds nothing in archive or delete mode, or when Archive is off', () => {
    settings.values = { archive_mode: 'delete' };
    expect(holdState({ availability: atRisk, availability_decision: null }).held).toBe(false);
    settings.values = { archive_mode: 'archive' };
    expect(holdState({ availability: atRisk, availability_decision: null }).held).toBe(false);
    settings.values = { archive_enabled: 'false' };
    expect(holdState({ availability: null, availability_decision: null }).held).toBe(false);
    settings.values = { archive_mode: 'bogus', archive_minSeeders: '-3' };
    expect(getArchiveSettings()).toMatchObject({ mode: 'ask', minSeeders: 0 });
  });
});
