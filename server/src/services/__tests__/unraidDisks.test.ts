import { describe, it, expect } from 'vitest';
import { poolOf, shapeUnraidDisks } from '../unraidDisks';
import type { UnraidArrayStats } from '../unraid';

const KB = 1024;

function stats(over: Partial<UnraidArrayStats> = {}): UnraidArrayStats {
  return {
    state: 'STARTED',
    capacity: { kilobytes: { free: 0, used: 0, total: 0 } },
    disks: [],
    caches: [],
    parities: [],
    ...over,
  };
}

describe('poolOf', () => {
  const names = ['cache', 'cache2', 'cache3', 'cache20', 'fastercache', 'fastercache2', 'nvme1', 'nvme12', 'solo'];

  it('finds the pool a numbered device belongs to', () => {
    expect(poolOf('cache2', names)).toBe('cache');
    expect(poolOf('cache20', names)).toBe('cache');
    expect(poolOf('fastercache2', names)).toBe('fastercache');
  });

  it('prefers the longest parent, so a pool whose name ends in a digit keeps its members', () => {
    expect(poolOf('nvme12', names)).toBe('nvme1');
  });

  it('treats the first device and a lone device as pools of their own', () => {
    expect(poolOf('cache', names)).toBe('cache');
    expect(poolOf('nvme1', names)).toBe('nvme1');
    expect(poolOf('solo', names)).toBe('solo');
  });

  it('never attaches to a parent that is not in the listing', () => {
    expect(poolOf('cache2', ['cache2', 'cache3'])).toBe('cache2');
  });
});

describe('shapeUnraidDisks', () => {
  it('reads every size as kilobytes', () => {
    const disks = shapeUnraidDisks(
      stats({
        parities: [{ id: 'p', name: 'parity', size: 3_906_250_000, temp: 33, status: 'DISK_OK' }],
        disks: [{ id: 'd1', name: 'disk1', size: 3_906_250_000, temp: 34, status: 'DISK_OK', fsUsed: 3_000_000_000, fsFree: 900_000_000, fsSize: 3_900_000_000, fsType: 'xfs' }],
      })
    );
    const parity = disks.find((d) => d.type === 'parity')!;
    expect(parity.size).toBe(3_906_250_000 * KB);
    const disk1 = disks.find((d) => d.name === 'disk1')!;
    expect(disk1.size).toBe(3_900_000_000 * KB);
    expect(disk1.used).toBe(3_000_000_000 * KB);
    expect(disk1.filesystem).toBe('xfs');
    expect(Math.round(disk1.usedPercent)).toBe(77);
  });

  it('groups a multi-device pool: usage on the pool row, members listed under it by raw size', () => {
    const device = (name: string, fs: boolean) => ({
      id: name,
      name,
      size: 488_386_584,
      temp: 42,
      fsUsed: fs ? 800_000_000 : null,
      fsFree: fs ? 150_000_000 : null,
      fsSize: fs ? 950_000_000 : null,
      fsType: fs ? 'btrfs' : null,
    });
    const disks = shapeUnraidDisks(
      stats({
        caches: [device('cache', true), device('fastercache', true), device('cache2', false), device('cache3', false), device('fastercache2', false)],
      })
    );
    const caches = disks.filter((d) => d.type === 'cache');
    expect(caches.map((d) => `${d.name}:${d.poolRole}:${d.pool}`)).toEqual([
      'cache:pool:cache',
      'cache2:member:cache',
      'cache3:member:cache',
      'fastercache:pool:fastercache',
      'fastercache2:member:fastercache',
    ]);
    const pool = caches[0]!;
    expect(pool.size).toBe(950_000_000 * KB);
    expect(pool.used).toBe(800_000_000 * KB);
    expect(Math.round(pool.usedPercent)).toBe(84);
    const member = caches[1]!;
    expect(member.size).toBe(488_386_584 * KB);
    expect(member.used).toBe(0);
    expect(member.usedPercent).toBe(0);
    expect(member.temp).toBe(42);
  });

  it('handles twenty members and a member whose parent is absent', () => {
    const caches = [
      { id: 'c', name: 'cache', size: 1000, temp: null, fsUsed: 10, fsFree: 10, fsSize: 20 },
      ...Array.from({ length: 19 }, (_, i) => ({ id: `c${i + 2}`, name: `cache${i + 2}`, size: 1000, temp: null, fsUsed: null, fsFree: null, fsSize: null })),
      { id: 'o', name: 'orphan5', size: 1000, temp: null, fsUsed: null, fsFree: null, fsSize: null },
    ];
    const disks = shapeUnraidDisks(stats({ caches }));
    expect(disks.filter((d) => d.pool === 'cache' && d.poolRole === 'member')).toHaveLength(19);
    const orphan = disks.find((d) => d.name === 'orphan5')!;
    expect(orphan.poolRole).toBe('pool');
    expect(disks).toHaveLength(21);
  });
});
