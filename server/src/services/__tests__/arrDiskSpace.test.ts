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

import { mergeArrVolumes, mountsHoldingRootFolders, rowsHoldingRootFolders, sameVolume, type ArrDiskRow } from '../arrDiskSpace';

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

describe('arr disk space: only mounts holding a root folder', () => {
  it('drops the container root and /config when the root folders live on another mount', () => {
    const rows: ArrDiskRow[] = [
      { source: 'radarr', path: '/', totalSpace: 1000, freeSpace: 90 },
      { source: 'radarr', path: '/config', totalSpace: 1000, freeSpace: 90 },
      { source: 'radarr', path: '/data', totalSpace: 20 * TB, freeSpace: 3 * TB },
      { source: 'sonarr', path: '/', totalSpace: 1000, freeSpace: 90 },
      { source: 'sonarr', path: '/tv', totalSpace: 20 * TB, freeSpace: 3 * TB },
    ];
    const kept = rowsHoldingRootFolders(rows, { radarr: ['/data/movies', '/data/movies-4k'], sonarr: ['/tv'] });
    expect(kept.map((r) => `${r.source}:${r.path}`)).toEqual(['sonarr:/tv', 'radarr:/data']);
  });

  it('keeps the root mount when a root folder really sits on it', () => {
    const kept = mountsHoldingRootFolders(['/', '/config'], ['/movies']);
    expect([...kept]).toEqual(['/']);
  });

  it('picks the longest matching mount, not a parent', () => {
    expect([...mountsHoldingRootFolders(['/', '/mnt', '/mnt/user'], ['/mnt/user/media/tv'])]).toEqual(['/mnt/user']);
    expect([...mountsHoldingRootFolders(['/', '/mnt/users'], ['/mnt/user/media'])]).toEqual(['/']);
  });

  it('keeps every row of an app whose root folders could not be read', () => {
    const rows: ArrDiskRow[] = [
      { source: 'radarr', path: '/', totalSpace: 1000, freeSpace: 90 },
      { source: 'radarr', path: '/movies', totalSpace: 20 * TB, freeSpace: 3 * TB },
    ];
    expect(rowsHoldingRootFolders(rows, { radarr: null })).toEqual(rows);
    expect(rowsHoldingRootFolders(rows, {})).toEqual(rows);
  });

  it('understands Windows paths', () => {
    expect([...mountsHoldingRootFolders(['C:\\', 'D:\\'], ['D:\\Media\\Movies'])]).toEqual(['D:\\']);
  });
});
