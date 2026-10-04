/**
 * Stack health: one list of everything that is wrong (or worth knowing)
 * across Prunerr and the apps it talks to, each with a severity and a next
 * step.
 *
 * Sonarr and Radarr already publish their own health checks (indexer down,
 * download client unreachable, root folder missing, update available) and a
 * queue status; Prunerr fetched those for the diagnostics tools but never
 * showed them. They matter to a cleanup tool: a deleted film that nothing
 * can re-grab, an import that silently stalls. On top of them come Prunerr's
 * own signals: a stale library sync, a failed scan, a stuck deletion job,
 * a mapping that points nowhere, disk pressure, refused API key attempts.
 *
 * Every check is independent and never throws: a service that cannot be
 * reached is itself a finding. The whole report is cached briefly so the
 * page and the assistant can poll without hammering the other apps.
 */
import fs from 'fs/promises';
import settingsRepo from '../../db/repositories/settings';
import deletionJobsRepo from '../../db/repositories/deletionJobs';
import * as rulesRepo from '../../db/repositories/rules';
import scanHistoryRepo from '../../db/repositories/scanHistoryRepo';
import watchHistoryCacheRepo from '../../db/repositories/watchHistoryCache';
import { getDatabase } from '../../db';
import logger from '../../utils/logger';
import { getAuthConfig } from '../../auth/config';
import { isApiKeyEnabled } from '../../middleware/apiAuth';
import { getApiKeyUsageSummary } from '../apiKeyUsage';
import { computeDiskPressureStats } from '../dashboardStats';
import { getSystemHealth, type ServiceHealthStatus } from '../systemHealth';
import { getRadarrService, getSonarrService } from '../init';
import { getConfiguredServerType, getMediaServerLabel } from '../mediaServer';
import { fetchHealth, fetchQueueStatus, fetchRootFolders, fetchSystemStatus, type ArrHealthItem, type ArrQueueStatus } from '../arrDiagnostics';
import { getDeletionSetup, type DiagnosticsService } from '../serviceDiagnostics';
import { getFolderMappings } from '../orphanFolders';
import { listContainerMounts } from '../containerMounts';
import { getPermissionCapabilities } from '../permissions';
import { formatBytes } from '../../utils/format';
import { defaultGracePeriodDays } from '../mediaActions';
import { countBySeverity, worstSeverity, type InsightCounts, type InsightItem, type InsightSeverity, type InsightSource } from './types';
import { applyAcknowledgements } from './acknowledgements';

export interface StackServiceReport {
  service: 'sonarr' | 'radarr';
  label: 'Sonarr' | 'Radarr';
  reachable: boolean;
  version: string | null;
  /** The app's own health checks, verbatim. */
  health: ArrHealthItem[];
  queue: ArrQueueStatus | null;
  rootFolders: Array<{ path: string; accessible: boolean; freeSpace: number | null }>;
}

export interface StackHealthReport {
  checkedAt: string;
  overall: InsightSeverity;
  counts: InsightCounts;
  items: InsightItem[];
  /** Connectivity of every configured service, as the dashboard shows it. */
  connections: ServiceHealthStatus[];
  /** Sonarr and Radarr in more depth, when configured. */
  arr: StackServiceReport[];
  /** Findings hidden by an acknowledgement; they are still in `items`, flagged. */
  acknowledgedCount: number;
}

const CACHE_TTL_MS = 60_000;
/** A deletion job step that has run this long is treated as stuck. */
const STUCK_STEP_MS = 30 * 60 * 1000;
/** No successful library sync for this long, with sync scheduled, is a warning. */
const STALE_SYNC_MS = 48 * 60 * 60 * 1000;
/** With a scheduled scan, no scan for this long is a warning. */
const STALE_SCAN_MS = 7 * 24 * 60 * 60 * 1000;
/** No new watch history for this long, with a provider configured, is worth a look. */
const QUIET_HISTORY_MS = 14 * 24 * 60 * 60 * 1000;

const SETTINGS_CONNECTIONS = '/settings?section=connections';
const SETTINGS_SYSTEM = '/settings?section=system';
const SETTINGS_SAFETY = '/settings?section=safety';

let cached: { at: number; report: StackHealthReport } | null = null;
let inFlight: Promise<StackHealthReport> | null = null;

function daysAgo(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / (24 * 60 * 60 * 1000)));
}

function arrSeverity(type: string): InsightSeverity {
  const lower = type.toLowerCase();
  if (lower === 'error') return 'critical';
  if (lower === 'warning') return 'warning';
  if (lower === 'ok') return 'ok';
  return 'info';
}

/** `IndexerStatusCheck` → `Indexer status`, for the finding title. */
function humaniseCheck(source: string): string {
  return source
    .replace(/Check$/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase());
}

// ----------------------------------------------------------------------------
// Sonarr / Radarr
// ----------------------------------------------------------------------------

async function checkArr(service: DiagnosticsService, items: InsightItem[]): Promise<StackServiceReport | null> {
  const instance = service === 'sonarr' ? getSonarrService() : getRadarrService();
  if (!instance) return null;
  const label = service === 'sonarr' ? 'Sonarr' : 'Radarr';
  const client = instance.httpClient;
  const source: InsightSource = service;
  const appUrl = settingsRepo.getValue(`${service}_url`) ?? undefined;

  const report: StackServiceReport = { service, label, reachable: false, version: null, health: [], queue: null, rootFolders: [] };

  let status: Awaited<ReturnType<typeof fetchSystemStatus>> | null = null;
  try {
    status = await fetchSystemStatus(client);
    report.reachable = true;
    report.version = typeof status.version === 'string' ? status.version : null;
  } catch (error) {
    items.push({
      id: `${service}.unreachable`,
      severity: 'critical',
      source,
      title: `${label} cannot be reached`,
      detail: `${error instanceof Error ? error.message : String(error)}. Nothing can be deleted through ${label} until it answers; check the URL and API key.`,
      href: SETTINGS_CONNECTIONS,
    });
    return report;
  }

  const [health, queue, rootFolders, setup] = await Promise.allSettled([
    fetchHealth(client),
    fetchQueueStatus(client),
    fetchRootFolders(client),
    getDeletionSetup(service),
  ]);

  if (health.status === 'fulfilled') {
    report.health = health.value;
    for (const check of health.value) {
      const severity = arrSeverity(check.type);
      if (severity === 'ok') continue;
      items.push({
        id: `${service}.health.${check.source}`,
        severity,
        source,
        title: `${label}: ${humaniseCheck(check.source)}`,
        detail: check.message,
        href: check.wikiUrl || appUrl,
        external: true,
      });
    }
  } else {
    items.push({ id: `${service}.health.unavailable`, severity: 'info', source, title: `${label}'s health checks could not be read`, detail: String(health.reason instanceof Error ? health.reason.message : health.reason) });
  }

  if (queue.status === 'fulfilled') {
    report.queue = queue.value;
    const q = queue.value;
    if (q.errors || q.unknownErrors) {
      items.push({
        id: `${service}.queue.errors`,
        severity: 'warning',
        source,
        title: `${label} has downloads stuck with errors`,
        detail: `${q.totalCount} item${q.totalCount === 1 ? '' : 's'} in the queue, some failing to import. A grab that never imports leaves a gap after Prunerr deletes the old file.`,
        href: appUrl ? `${appUrl.replace(/\/$/, '')}/activity/queue` : undefined,
        external: true,
      });
    } else if (q.warnings || q.unknownWarnings) {
      items.push({
        id: `${service}.queue.warnings`,
        severity: 'info',
        source,
        title: `${label} has downloads with warnings`,
        detail: `${q.totalCount} item${q.totalCount === 1 ? '' : 's'} in the queue, some needing attention in ${label}.`,
        href: appUrl ? `${appUrl.replace(/\/$/, '')}/activity/queue` : undefined,
        external: true,
      });
    }
  }

  if (rootFolders.status === 'fulfilled') {
    report.rootFolders = rootFolders.value.map((f) => ({ path: f.path, accessible: f.accessible, freeSpace: typeof f.freeSpace === 'number' ? f.freeSpace : null }));
    for (const folder of rootFolders.value) {
      if (!folder.accessible) {
        items.push({
          id: `${service}.rootfolder.${folder.path}`,
          severity: 'critical',
          source,
          title: `${label} cannot see its root folder ${folder.path}`,
          detail: `Deletes and imports under this folder will fail until the mount is back inside the ${label} container.`,
          href: appUrl,
          external: true,
        });
      }
    }
  }

  if (setup.status === 'fulfilled') {
    // Recycle-bin-on-another-filesystem and never-cleaned-bin warnings; the
    // inaccessible root folder is already reported above.
    for (const warning of setup.value.warnings) {
      if (warning.includes('is not accessible')) continue;
      items.push({
        id: `${service}.deletionSetup.${warning.slice(0, 40)}`,
        severity: 'info',
        source,
        title: `${label}: deletion setup worth checking`,
        detail: warning,
        href: appUrl ? `${appUrl.replace(/\/$/, '')}/settings/mediamanagement` : undefined,
        external: true,
      });
    }
  }

  return report;
}

// ----------------------------------------------------------------------------
// Prunerr's own signals
// ----------------------------------------------------------------------------

function checkConnections(health: Awaited<ReturnType<typeof getSystemHealth>>, items: InsightItem[]): void {
  for (const s of health.services) {
    if (!s.configured || s.connected) continue;
    // Sonarr and Radarr are reported in depth by checkArr.
    if (s.service === 'sonarr' || s.service === 'radarr') continue;
    const name = s.service === 'plex' ? getMediaServerLabel() : s.service.charAt(0).toUpperCase() + s.service.slice(1);
    const source: InsightSource = s.service === 'plex' ? 'mediaServer' : (s.service as InsightSource);
    const consequence =
      s.service === 'plex'
        ? 'Library sync and direct watch history stop until it answers.'
        : s.service === 'tautulli' || s.service === 'tracearr'
          ? 'Watch counts stop updating; rules that look at plays will see stale data.'
          : s.service === 'overseerr'
            ? 'Requests will not be cleared when Prunerr deletes what they asked for.'
            : '';
    items.push({
      id: `${s.service}.unreachable`,
      severity: s.service === 'plex' ? 'critical' : 'warning',
      source,
      title: `${name} cannot be reached`,
      detail: [s.error, consequence].filter(Boolean).join(' '),
      href: SETTINGS_CONNECTIONS,
    });
  }
}

function checkSyncAndScans(health: Awaited<ReturnType<typeof getSystemHealth>>, items: InsightItem[]): void {
  const sched = health.scheduler;
  const mediaServer = getMediaServerLabel();

  if (sched.lastSyncSuccess === false) {
    items.push({
      id: 'prunerr.sync.failed',
      severity: 'warning',
      source: 'prunerr',
      title: `The last ${mediaServer} library sync failed`,
      detail: `Finished ${sched.lastSyncAt ? `${daysAgo(sched.lastSyncAt)} day(s) ago` : 'at an unknown time'} without success. Items added since then are missing from Prunerr, and sizes may be stale. Check the ${mediaServer} connection and the activity log.`,
      href: '/activity',
    });
  } else if (sched.syncSchedule && sched.lastSync && Date.now() - new Date(sched.lastSync).getTime() > STALE_SYNC_MS) {
    items.push({
      id: 'prunerr.sync.stale',
      severity: 'warning',
      source: 'prunerr',
      title: `No successful library sync for ${daysAgo(sched.lastSync)} days`,
      detail: 'Sync is scheduled but has not completed recently. Rules run against stale sizes and watch dates until it does.',
      href: '/library',
    });
  } else if (!sched.lastSync) {
    items.push({
      id: 'prunerr.sync.never',
      severity: 'info',
      source: 'prunerr',
      title: 'The library has never been synced',
      detail: `Run a sync from the Library page so Prunerr knows what ${mediaServer} holds.`,
      href: '/library',
    });
  }

  const latestScan = scanHistoryRepo.getLatest();
  if (latestScan?.status === 'failed') {
    items.push({
      id: 'prunerr.scan.failed',
      severity: 'warning',
      source: 'prunerr',
      title: 'The last rule scan failed',
      detail: `Started ${daysAgo(latestScan.started_at)} day(s) ago. Nothing new was flagged; see the activity log for the error.`,
      href: '/activity',
    });
  } else if (sched.scanSchedule && sched.lastScan && Date.now() - new Date(sched.lastScan).getTime() > STALE_SCAN_MS) {
    items.push({
      id: 'prunerr.scan.stale',
      severity: 'info',
      source: 'prunerr',
      title: `No rule scan for ${daysAgo(sched.lastScan)} days`,
      detail: 'Scans are scheduled but none has run recently, so nothing new is being flagged.',
      href: '/rules',
    });
  }
}

function checkDeletionJobs(items: InsightItem[]): void {
  const active = deletionJobsRepo.listActive();
  const stuck = active.filter((job) => job.status !== 'pending' && job.step_started_at && Date.now() - new Date(job.step_started_at).getTime() > STUCK_STEP_MS);
  if (stuck.length > 0) {
    const first = stuck[0]!;
    items.push({
      id: 'prunerr.deletionJobs.stuck',
      severity: 'warning',
      source: 'prunerr',
      title: `${stuck.length} deletion job${stuck.length === 1 ? '' : 's'} running for over 30 minutes`,
      detail: `"${first.title}" has been on step "${first.step ?? first.stage ?? 'unknown'}" since ${first.step_started_at}. ${first.service ?? 'The app'} may be copying the file into a recycle bin on another filesystem; the job verifies by polling rather than failing.`,
      href: '/queue',
    });
  }

  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const failed = deletionJobsRepo.listFinished(200).filter((job) => job.status === 'failed' && job.finished_at && job.finished_at >= weekAgo);
  if (failed.length > 0) {
    const first = failed[0]!;
    items.push({
      id: 'prunerr.deletionJobs.failed',
      severity: 'warning',
      source: 'prunerr',
      title: `${failed.length} deletion${failed.length === 1 ? '' : 's'} failed in the last 7 days`,
      detail: `Most recent: "${first.title}"${first.error ? ` — ${first.error}` : ''}. Failed jobs can be retried from the queue.`,
      href: '/queue',
    });
  }

  // Items past their grace period with nobody to process them.
  try {
    const autoProcess = settingsRepo.getBoolean('schedule_autoProcess', false);
    const overdue = getDatabase()
      .prepare<[string], { n: number }>(`SELECT COUNT(*) AS n FROM media_items WHERE status = 'pending_deletion' AND delete_after IS NOT NULL AND delete_after <= ?`)
      .get(new Date().toISOString())?.n ?? 0;
    if (overdue > 0 && !autoProcess) {
      items.push({
        id: 'prunerr.queue.overdue',
        severity: 'info',
        source: 'prunerr',
        title: `${overdue} queued item${overdue === 1 ? '' : 's'} past the grace period`,
        detail: 'Automatic processing is off, so they wait until someone presses Process queue. Turn it on under Settings → Scheduling to have them handled on the schedule.',
        href: '/queue',
      });
    }
  } catch (error) {
    logger.debug(`Insights: overdue queue check failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function checkFolderMappings(items: InsightItem[]): Promise<void> {
  const mappings = getFolderMappings();
  if (mappings.length === 0) return;

  let mounts: Awaited<ReturnType<typeof listContainerMounts>> | null = null;
  try {
    mounts = await listContainerMounts();
  } catch {
    mounts = null;
  }

  for (const mapping of mappings) {
    try {
      const stat = await fs.stat(mapping.localPath);
      if (!stat.isDirectory()) throw new Error('not a directory');
    } catch {
      items.push({
        id: `prunerr.mapping.missing.${mapping.localPath}`,
        severity: 'critical',
        source: 'prunerr',
        title: `Mapped folder ${mapping.localPath} does not exist in the container`,
        detail: `${mapping.remotePath} is mapped to it, so sizes stay unknown and deletes fail for everything under it. Check the volume in the container settings, or pick the right path under Settings → Connections → Media folders.`,
        href: SETTINGS_CONNECTIONS,
      });
      continue;
    }
    const mount = mounts?.mounts.find((m) => mapping.localPath === m.mountPoint || mapping.localPath.startsWith(`${m.mountPoint}/`));
    if (mount?.readOnly) {
      items.push({
        id: `prunerr.mapping.readonly.${mapping.localPath}`,
        severity: 'info',
        source: 'prunerr',
        title: `${mapping.localPath} is mounted read-only`,
        detail: 'Folders under it can be measured but not deleted or repaired. Mount the volume read-write to enable that.',
        href: SETTINGS_CONNECTIONS,
      });
    }
  }

  const caps = getPermissionCapabilities();
  if (!caps.canChown) {
    items.push({
      id: 'prunerr.permissions.nochown',
      severity: 'info',
      source: 'prunerr',
      title: 'Prunerr cannot repair file ownership',
      detail: caps.reason ?? 'The Node binary lacks CAP_CHOWN/CAP_FOWNER, so a delete that hits files owned by another user will fail instead of being repaired first.',
      href: SETTINGS_CONNECTIONS,
    });
  }
}

async function checkDisk(items: InsightItem[]): Promise<void> {
  const disk = await computeDiskPressureStats();
  for (const d of disk.disks) {
    if (d.severity === 'ok') continue;
    items.push({
      id: `prunerr.disk.${d.path}`,
      severity: d.severity === 'critical' ? 'critical' : 'warning',
      source: 'prunerr',
      title: `${d.path} is ${d.severity === 'critical' ? 'critically' : 'running'} low on space`,
      detail: `${formatBytes(d.freeBytes)} free of ${formatBytes(d.totalBytes)}; the target is ${formatBytes(d.targetBytes)}.${disk.diskObserveOnly ? ' Disk pressure is in observe-only mode, so nothing is freed automatically.' : ''}`,
      href: '/',
    });
  }
}

function checkWatchHistory(items: InsightItem[]): void {
  const provider = settingsRepo.getValue('watch_history_provider');
  const externalConfigured = (name: 'tautulli' | 'tracearr') => Boolean(settingsRepo.getValue(`${name}_url`) && settingsRepo.getValue(`${name}_apiKey`));
  if ((provider === 'tautulli' || provider === 'tracearr') && !externalConfigured(provider)) {
    items.push({
      id: 'prunerr.watchHistory.unconfigured',
      severity: 'critical',
      source: 'prunerr',
      title: `${provider === 'tautulli' ? 'Tautulli' : 'Tracearr'} is selected for watch history but not configured`,
      detail: 'Every item reports zero plays, which is exactly what watch-based rules delete. Fill in its URL and key, or switch the provider.',
      href: SETTINGS_CONNECTIONS,
    });
    return;
  }
  // Plex's own history only records plays that reached the watched threshold,
  // so under the direct provider a half-watched movie never shows as in
  // progress. Only worth saying when a rule actually relies on the field.
  const direct = provider === 'plex' || provider === 'mediaServer' || (!provider && !externalConfigured('tautulli') && !externalConfigured('tracearr'));
  if (direct && getConfiguredServerType() === 'plex') {
    const fields = ['in_progress', 'fully_watched', 'watch_completion', 'in_progress_by', 'completed_by'];
    const relying = rulesRepo.getEnabledRules().filter((rule) => fields.some((f) => (typeof rule.conditions === 'string' ? rule.conditions : JSON.stringify(rule.conditions ?? '')).includes(`"${f}"`)));
    if (relying.length > 0) {
      items.push({
        id: 'prunerr.watchHistory.noPartialPlays',
        severity: 'info',
        source: 'prunerr',
        title: `${relying.length} rule${relying.length === 1 ? '' : 's'} use watch state, but Plex direct history cannot see partial plays`,
        detail: `${relying.map((r) => `"${r.name}"`).join(', ')}. Plex only records a play once it reaches the watched threshold, so a movie someone stopped halfway is never "in progress" here (shows still are, while episodes remain). Tautulli records partial plays; select it as the watch history provider for the full picture.`,
        href: SETTINGS_CONNECTIONS,
      });
    }
  }

  const latest = watchHistoryCacheRepo.getLatestTimestamp();
  if (latest && Date.now() - new Date(latest).getTime() > QUIET_HISTORY_MS) {
    items.push({
      id: 'prunerr.watchHistory.quiet',
      severity: 'info',
      source: 'prunerr',
      title: `No new watch history in ${daysAgo(latest)} days`,
      detail: 'Either nobody has watched anything, or the provider has stopped reporting. Worth a glance before trusting a "not watched since" rule.',
      href: SETTINGS_CONNECTIONS,
    });
  }
}

function checkAccess(items: InsightItem[]): void {
  const auth = getAuthConfig();
  if (!auth.enabled) {
    items.push({
      id: 'prunerr.auth.disabled',
      severity: 'info',
      source: 'prunerr',
      title: 'Login is off: anyone who can reach this address can delete media',
      detail: 'Fine on a trusted LAN or behind a proxy with its own login. Set AUTH_ENABLED=true to require a sign-in and enable the MCP connector.',
      href: SETTINGS_SYSTEM,
    });
  }
  for (const warning of auth.warnings ?? []) {
    items.push({ id: `prunerr.auth.warning.${warning.slice(0, 40)}`, severity: 'warning', source: 'prunerr', title: 'Login configuration warning', detail: warning, href: SETTINGS_SYSTEM });
  }

  const usage = getApiKeyUsageSummary();
  if (usage.refusedLast24h > 0) {
    const refused = usage.recent.find((r) => r.outcome !== 'ok');
    items.push({
      id: 'prunerr.apiKey.refused',
      severity: 'warning',
      source: 'prunerr',
      title: `${usage.refusedLast24h} request${usage.refusedLast24h === 1 ? '' : 's'} with a wrong or disabled API key in the last 24 hours`,
      detail: `Last from ${refused?.ip ?? 'an unknown address'}${refused?.userAgent ? ` (${refused.userAgent})` : ''}. A script with an old key after a regenerate is the usual cause; an unknown address is worth a look.`,
      href: SETTINGS_SYSTEM,
    });
  }
  if (!isApiKeyEnabled() && usage.lastUsedAt && daysAgo(usage.lastUsedAt)! <= 7) {
    items.push({
      id: 'prunerr.apiKey.disabledButUsed',
      severity: 'info',
      source: 'prunerr',
      title: 'API key access is off, but something used the key this week',
      detail: 'Whatever used it (nzb360, Home Assistant, a script) is now getting 401s.',
      href: SETTINGS_SYSTEM,
    });
  }
}

function checkDeletionSafety(items: InsightItem[]): void {
  const grace = defaultGracePeriodDays();
  const autoProcess = settingsRepo.getBoolean('schedule_autoProcess', false);
  if (autoProcess && grace <= 0) {
    items.push({
      id: 'prunerr.safety.noGrace',
      severity: 'warning',
      source: 'prunerr',
      title: 'Automatic processing with no grace period',
      detail: 'Flagged items are deleted on the next scheduled run with no window to object. A few days of grace costs nothing and catches rule mistakes.',
      href: SETTINGS_SAFETY,
    });
  }
}

// ----------------------------------------------------------------------------
// Report
// ----------------------------------------------------------------------------

async function build(): Promise<StackHealthReport> {
  const items: InsightItem[] = [];
  const checkedAt = new Date().toISOString();

  const health = await getSystemHealth();
  checkConnections(health, items);

  const [sonarr, radarr] = await Promise.all([checkArr('sonarr', items), checkArr('radarr', items)]);

  const safe = async (name: string, fn: () => void | Promise<void>) => {
    try {
      await fn();
    } catch (error) {
      logger.debug(`Insights: ${name} check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  await safe('sync', () => checkSyncAndScans(health, items));
  await safe('deletionJobs', () => checkDeletionJobs(items));
  await safe('mappings', () => checkFolderMappings(items));
  await safe('disk', () => checkDisk(items));
  await safe('watchHistory', () => checkWatchHistory(items));
  await safe('access', () => checkAccess(items));
  await safe('safety', () => checkDeletionSafety(items));

  const rank: Record<InsightSeverity, number> = { critical: 0, warning: 1, info: 2, ok: 3 };
  items.sort((a, b) => rank[a.severity] - rank[b.severity]);

  return {
    checkedAt,
    overall: worstSeverity(items),
    counts: countBySeverity(items),
    items,
    connections: health.services,
    arr: [sonarr, radarr].filter((r): r is StackServiceReport => r !== null),
    acknowledgedCount: 0,
  };
}

/** The report with acknowledgements applied; the cache holds the raw findings so an ack shows at once. */
export async function getStackHealth(options: { refresh?: boolean } = {}): Promise<StackHealthReport> {
  return applyAcknowledgements(await getRawStackHealth(options));
}

async function getRawStackHealth(options: { refresh?: boolean } = {}): Promise<StackHealthReport> {
  if (!options.refresh && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.report;
  if (inFlight) return inFlight;
  inFlight = build()
    .then((report) => {
      cached = { at: Date.now(), report };
      return report;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Drop the cached report; the next call rebuilds it. */
export function invalidateStackHealth(): void {
  cached = null;
}
