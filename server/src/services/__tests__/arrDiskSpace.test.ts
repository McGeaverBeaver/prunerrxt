import { describe, it, expect, vi } from 'vitest';

vi.mock('../../utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../db/repositories/settings', () => ({
  default: { getBoolean: () => true },
}));
vi.mock('../init', () => ({
  getSonarrService: () => null,
  getRadarrService: () => null,
}));

import { mergeArrVolumes, sameVolume } from '../arrDiskSpace';

const TB = 1024 ** 4;

describe('arr disk space', () => {
  it('merges the same volume reported under different paths by both apps', () => {
    const volumes = mergeArrVolumes([
      { source: 'radarr', path: '/movies', totalSpace: 20 * TB, freeSpace: 3 * TB },
      { source: 'sonarr', path: '/tv', totalSpace: 20 * TB, freeSpace: 3 * TB + 500 * 1024 ** 2 },
      { source: 'sonarr', path: '/anime', totalSpace: 8 * TB, freeSpace: 1 * TB },
    ]);
    expect(volumes).toHaveLength(2);
    const shared = volumes.find((v) => v.path === '/movies')!;
    expect(shared.reportedBy).toEqual(['radarr:/movies', 'sonarr:/tv']);
    expect(shared.usedBytes).toBe(17 * TB);
    expect(volumes.find((v) => v.path === '/anime')!.reportedBy).toEqual(['sonarr:/anime']);
  });

  it('keeps volumes apart when totals match but free space differs', () => {
    expect(sameVolume({ totalBytes: 20 * TB, freeBytes: 3 * TB }, { totalBytes: 20 * TB, freeBytes: 2 * TB })).toBe(false);
    expect(sameVolume({ totalBytes: 0, freeBytes: 0 }, { totalBytes: 0, freeBytes: 0 })).toBe(false);
  });

  it('drops rows without a usable total', () => {
    expect(mergeArrVolumes([{ source: 'radarr', path: '/x', totalSpace: 0, freeSpace: 0 }])).toEqual([]);
  });
});
