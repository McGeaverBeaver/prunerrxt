/**
 * Shapes shared by the four Insights blocks (stack health, library quality,
 * watch patterns, playback friction), the REST routes, the daily snapshot and
 * the MCP tool. Everything here is plain JSON: the client renders it, the
 * assistant reads it.
 */

export type InsightSeverity = 'ok' | 'info' | 'warning' | 'critical';

export const SEVERITY_RANK: Record<InsightSeverity, number> = { ok: 0, info: 1, warning: 2, critical: 3 };

/** Where a finding came from: Prunerr itself or one of the connected apps. */
export type InsightSource = 'prunerr' | 'mediaServer' | 'sonarr' | 'radarr' | 'tautulli' | 'tracearr' | 'overseerr' | 'unraid';

export interface InsightItem {
  /** Stable key, e.g. `sonarr.health.IndexerStatusCheck`, so the UI can dedupe and the assistant can refer to it. */
  id: string;
  severity: InsightSeverity;
  source: InsightSource;
  /** One line: what is wrong (or right). */
  title: string;
  /** Why it matters and what to do, when the title is not enough. */
  detail?: string;
  /** An in-app page that fixes or explains it (`/settings?category=connections`) or an external help page. */
  href?: string;
  /** True when `href` leaves Prunerr (Sonarr's wiki, the app's own UI). */
  external?: boolean;
}

export interface InsightCounts {
  critical: number;
  warning: number;
  info: number;
  ok: number;
}

export function worstSeverity(items: readonly Pick<InsightItem, 'severity'>[]): InsightSeverity {
  let worst: InsightSeverity = 'ok';
  for (const item of items) {
    if (SEVERITY_RANK[item.severity] > SEVERITY_RANK[worst]) worst = item.severity;
  }
  return worst;
}

export function countBySeverity(items: readonly Pick<InsightItem, 'severity'>[]): InsightCounts {
  const counts: InsightCounts = { critical: 0, warning: 0, info: 0, ok: 0 };
  for (const item of items) counts[item.severity] += 1;
  return counts;
}
