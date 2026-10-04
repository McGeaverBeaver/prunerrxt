import { describe, it, expect, vi } from 'vitest';

const store = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('../../../db/repositories/settings', () => ({
  default: {
    getJson: () => store.value,
    setJson: (_key: string, value: Record<string, unknown>) => {
      store.value = value;
    },
  },
}));

import { acknowledge, applyAcknowledgements, getAcknowledgements, isAcknowledged, unacknowledge } from '../acknowledgements';
import type { InsightItem } from '../types';

const item = (id: string, severity: InsightItem['severity']): InsightItem => ({ id, severity, source: 'sonarr', title: `${id} title` });

describe('stack-health acknowledgements', () => {
  it('hides an acknowledged finding from the counts and brings it back on undo', () => {
    store.value = {};
    const report = { items: [item('sonarr.health.AllowedHostsCheck', 'warning'), item('radarr.health.IndexerLongTermStatusCheck', 'warning'), item('prunerr.auth.disabled', 'info')] };

    let view = applyAcknowledgements(report, getAcknowledgements());
    expect(view.counts).toEqual({ critical: 0, warning: 2, info: 1, ok: 0 });
    expect(view.acknowledgedCount).toBe(0);

    acknowledge(report.items[0]!);
    view = applyAcknowledgements(report, getAcknowledgements());
    expect(view.counts).toEqual({ critical: 0, warning: 1, info: 1, ok: 0 });
    expect(view.acknowledgedCount).toBe(1);
    expect(view.items[0]?.acknowledged?.at).toBeTruthy();
    expect(view.overall).toBe('warning');

    acknowledge(report.items[1]!);
    acknowledge(report.items[2]!);
    view = applyAcknowledgements(report, getAcknowledgements());
    expect(view.overall).toBe('ok');
    expect(view.acknowledgedCount).toBe(3);

    unacknowledge('sonarr.health.AllowedHostsCheck');
    view = applyAcknowledgements(report, getAcknowledgements());
    expect(view.items[0]?.acknowledged).toBeUndefined();
    expect(view.counts.warning).toBe(1);
  });

  it('drops the acknowledgement when the finding escalates', () => {
    store.value = {};
    acknowledge(item('prunerr.disk./media', 'warning'));
    expect(isAcknowledged(item('prunerr.disk./media', 'warning'), getAcknowledgements())).not.toBeNull();
    expect(isAcknowledged(item('prunerr.disk./media', 'critical'), getAcknowledgements())).toBeNull();
    expect(isAcknowledged(item('prunerr.disk./media', 'info'), getAcknowledgements())).not.toBeNull();
  });

  it('ignores malformed stored entries', () => {
    store.value = { good: { at: '2026-10-04T00:00:00Z', severity: 'warning', title: 'x' }, bad: 'nope', worse: { severity: 'warning' } };
    expect(Object.keys(getAcknowledgements())).toEqual(['good']);
  });
});
