import { describe, it, expect } from 'vitest';
import { summariseIndexerHealth } from '../arrHttp';

const indexers = [
  { id: 1, name: 'DrunkenSlug', enable: true },
  { id: 2, name: 'NZBgeek', enable: true },
  { id: 3, name: 'Old Tracker', enable: false },
];

describe('summariseIndexerHealth', () => {
  it('counts enabled indexers and the ones /health names as failing', () => {
    expect(
      summariseIndexerHealth(indexers, [
        { source: 'IndexerLongTermStatusCheck', message: 'Indexers unavailable due to failures for more than 6 hours: DrunkenSlug' },
        { source: 'AllowedHostsCheck', message: 'Allowed Hosts is not configured' },
      ])
    ).toEqual({ total: 2, failing: 1, retryAt: null });
  });

  it('treats "All indexers are unavailable" as every enabled indexer down', () => {
    expect(summariseIndexerHealth(indexers, [{ source: 'IndexerStatusCheck', message: 'All indexers are unavailable due to failures' }])).toEqual({ total: 2, failing: 2, retryAt: null });
  });

  it('merges the short-term and long-term checks without double counting', () => {
    const health = [
      { source: 'IndexerStatusCheck', message: 'Indexers unavailable due to failures: DrunkenSlug, NZBgeek' },
      { source: 'IndexerLongTermStatusCheck', message: 'Indexers unavailable due to failures for more than 6 hours: DrunkenSlug' },
    ];
    expect(summariseIndexerHealth(indexers, health).failing).toBe(2);
  });

  it('is calm about missing or odd payloads', () => {
    expect(summariseIndexerHealth([], [])).toEqual({ total: 0, failing: 0, retryAt: null });
    expect(summariseIndexerHealth(undefined as never, undefined as never)).toEqual({ total: 0, failing: 0, retryAt: null });
  });
});
