import { describe, it, expect } from 'vitest';
import { summariseIndexerHealth } from '../arrHttp';

describe('summariseIndexerHealth', () => {
  const now = new Date('2026-10-04T12:00:00Z');
  it('counts enabled indexers, the ones backed off right now, and the earliest retry', () => {
    const health = summariseIndexerHealth(
      [
        { id: 1, enable: true },
        { id: 2, enable: true },
        { id: 3, enable: false },
      ],
      [
        { indexerId: 1, disabledTill: '2026-10-04T12:30:00Z' },
        { indexerId: 2, disabledTill: '2026-10-04T11:00:00Z' },
        { indexerId: 3, disabledTill: '2026-10-04T13:00:00Z' },
      ],
      now
    );
    expect(health).toEqual({ total: 2, failing: 1, retryAt: '2026-10-04T12:30:00.000Z' });
  });

  it('is calm about missing or odd payloads', () => {
    expect(summariseIndexerHealth([], [], now)).toEqual({ total: 0, failing: 0, retryAt: null });
    expect(summariseIndexerHealth(undefined as never, undefined as never, now)).toEqual({ total: 0, failing: 0, retryAt: null });
  });
});
