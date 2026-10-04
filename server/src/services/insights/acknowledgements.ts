/**
 * Acknowledged stack-health findings.
 *
 * Some findings are true and not worth acting on: Sonarr's "Allowed Hosts
 * is not configured" on a LAN-only install, a recycle bin that is on another
 * filesystem on purpose. Acknowledging one keeps it out of the counts and
 * off the list (behind "show acknowledged") until it is unacknowledged, or
 * until it gets worse: an acknowledgement is taken at the severity it had,
 * and a finding that escalates (warning to critical) comes back on its own.
 *
 * Stored in the settings table as one JSON row keyed by finding id, so it
 * survives restarts and applies to the MCP connector's reports too.
 */
import settingsRepo from '../../db/repositories/settings';
import { SEVERITY_RANK, countBySeverity, worstSeverity, type InsightItem, type InsightSeverity } from './types';

export const ACKNOWLEDGEMENTS_SETTING = 'insights_acknowledged';

export interface Acknowledgement {
  at: string;
  severity: InsightSeverity;
  title: string;
}

export type Acknowledgements = Record<string, Acknowledgement>;

export function getAcknowledgements(): Acknowledgements {
  const raw = settingsRepo.getJson<unknown>(ACKNOWLEDGEMENTS_SETTING, {});
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Acknowledgements = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const v = value as Partial<Acknowledgement>;
    if (typeof v.at !== 'string') continue;
    out[id] = {
      at: v.at,
      severity: v.severity && v.severity in SEVERITY_RANK ? v.severity : 'warning',
      title: typeof v.title === 'string' ? v.title : '',
    };
  }
  return out;
}

export function acknowledge(item: Pick<InsightItem, 'id' | 'severity' | 'title'>): Acknowledgements {
  const all = getAcknowledgements();
  all[item.id] = { at: new Date().toISOString(), severity: item.severity, title: item.title };
  settingsRepo.setJson(ACKNOWLEDGEMENTS_SETTING, all);
  return all;
}

export function unacknowledge(id: string): Acknowledgements {
  const all = getAcknowledgements();
  delete all[id];
  settingsRepo.setJson(ACKNOWLEDGEMENTS_SETTING, all);
  return all;
}

/** Whether an acknowledgement still covers the finding: same id, not escalated since. */
export function isAcknowledged(item: Pick<InsightItem, 'id' | 'severity'>, acks: Acknowledgements): Acknowledgement | null {
  const ack = acks[item.id];
  if (!ack) return null;
  if (SEVERITY_RANK[item.severity] > SEVERITY_RANK[ack.severity]) return null;
  return ack;
}

export interface AcknowledgedView<T extends { items: InsightItem[] }> {
  report: T & { overall: InsightSeverity; counts: ReturnType<typeof countBySeverity>; acknowledgedCount: number };
}

/**
 * Mark acknowledged items and recompute the headline from the rest. Pure
 * apart from reading the stored acknowledgements, so it runs on every read
 * of a cached report and an acknowledgement takes effect at once.
 */
export function applyAcknowledgements<T extends { items: InsightItem[] }>(
  report: T,
  acks: Acknowledgements = getAcknowledgements()
): T & { overall: InsightSeverity; counts: ReturnType<typeof countBySeverity>; acknowledgedCount: number } {
  const items = report.items.map((item) => {
    const ack = isAcknowledged(item, acks);
    return ack ? { ...item, acknowledged: { at: ack.at } } : { ...item, acknowledged: undefined };
  });
  const active = items.filter((i) => !i.acknowledged);
  return {
    ...report,
    items,
    overall: worstSeverity(active),
    counts: countBySeverity(active),
    acknowledgedCount: items.length - active.length,
  };
}
