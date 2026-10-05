/**
 * Archive, the half that talks to Radarr and Sonarr.
 *
 * `checkItem` runs one interactive search for a queued item (a movie, or up
 * to three seasons of a show), stores the verdict on the row, and applies the
 * `archive` mode when the verdict is at-risk. `checkQueue` does that for
 * every queued item without a fresh verdict, one at a time with a pause
 * between searches so a long queue does not hammer the indexers; the
 * scheduler runs it, and queueing kicks it in the background.
 *
 * Outages pause the checks rather than poison the verdicts. Before a pass
 * touches a service it asks that app's indexer status; when every enabled
 * indexer is backed off, or a search fails outright or is rate-limited, that
 * service is paused and its items are left unchecked (which the queue treats
 * as held, so nothing is deleted on a guess). Every scheduled run probes a
 * paused service again and resumes it the moment the indexers are back. A
 * verdict is only ever stored when the search actually answered.
 *
 * The verdict logic itself is in availabilityVerdict.ts.
 */
import { isAxiosError } from 'axios';
import logger from '../utils/logger';
import mediaItemsRepo from '../db/repositories/mediaItems';
import { logActivity } from '../db/repositories/activity';
import type { MediaItem } from '../types';
import type { ArrRelease, SonarrSeason } from './types';
import type { IndexerHealth } from './arrHttp';
import { getRadarrService, getSonarrService } from './init';
import { archiveItems } from './mediaActions';
import { linkToArr } from './arrLink';
import { registerAvailabilityKick } from './availabilityKick';
import {
  describeReasons,
  getArchiveSettings,
  isStale,
  judge,
  parseAvailability,
  parseResolution,
  summariseRelease,
  type ArchiveSettings,
  type AvailabilityReport,
  type ReleaseSummary,
} from './availabilityVerdict';

/** Pause between two searches: indexers rate-limit, and nothing here is urgent. */
const DEFAULT_SEARCH_GAP_MS = 3_000;
let searchGapMs = DEFAULT_SEARCH_GAP_MS;
/** How many seasons of a show to search: first, middle and last with files. */
const SEASONS_PER_SHOW = 3;
/** One background pass handles at most this many items. */
const MAX_ITEMS_PER_PASS = 40;
/** Back-off after a failed search or an unreachable app: 5, 15, 30, 60 minutes. */
const BACKOFF_MS = [5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000];
/** When every indexer is down and none says when it will retry. */
const INDEXERS_DOWN_PAUSE_MS = 15 * 60_000;
/** A rate limit without a Retry-After header waits this long. */
const RATE_LIMIT_PAUSE_MS = 10 * 60_000;

export type ArrService = 'radarr' | 'sonarr';
export type PauseReason = 'indexers_down' | 'rate_limited' | 'search_failed' | 'unreachable';

export interface ServicePause {
  service: ArrService;
  reason: PauseReason;
  detail: string;
  since: string;
  /** When the next probe may try again. */
  until: string;
  /** Consecutive failures behind this pause; drives the back-off. */
  failures: number;
}

export interface AvailabilityStatus {
  enabled: boolean;
  paused: ServicePause[];
  /** Queued movies/shows still without a verdict. */
  unchecked: number;
  lastPassAt: string | null;
}

/** Thrown by a check that could not get an answer; the service is paused when it is raised. */
export class AvailabilityPausedError extends Error {
  constructor(public readonly pause: ServicePause) {
    super(describePause(pause));
    this.name = 'AvailabilityPausedError';
  }
}

let lastSearchAt = 0;
let lastPassAt: string | null = null;
let passRunning: Promise<CheckQueueResult> | null = null;
let kickTimer: NodeJS.Timeout | null = null;
const pauses: Record<ArrService, ServicePause | null> = { radarr: null, sonarr: null };
const failureCounts: Record<ArrService, number> = { radarr: 0, sonarr: 0 };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function throttle(): Promise<void> {
  const wait = lastSearchAt + searchGapMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastSearchAt = Date.now();
}

const SERVICE_LABEL: Record<ArrService, string> = { radarr: 'Radarr', sonarr: 'Sonarr' };

export function describePause(pause: ServicePause): string {
  const label = SERVICE_LABEL[pause.service];
  const retry = `retrying after ${pause.until}`;
  switch (pause.reason) {
    case 'indexers_down':
      return `${label}: every enabled indexer is currently failing (${pause.detail}); ${retry}`;
    case 'rate_limited':
      return `${label} is rate-limiting searches (${pause.detail}); ${retry}`;
    case 'unreachable':
      return `${label} could not be reached (${pause.detail}); ${retry}`;
    default:
      return `${label}'s release search failed (${pause.detail}); ${retry}`;
  }
}

/** The pause for a service, or null once its time is up or it was cleared. */
export function getPause(service: ArrService, now: Date = new Date()): ServicePause | null {
  const pause = pauses[service];
  if (!pause) return null;
  return new Date(pause.until).getTime() > now.getTime() ? pause : null;
}

function pauseService(service: ArrService, reason: PauseReason, detail: string, untilMs?: number): ServicePause {
  failureCounts[service] += 1;
  const failures = failureCounts[service];
  const backoff = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length) - 1]!;
  const now = Date.now();
  const until = untilMs && untilMs > now ? untilMs : now + backoff;
  const previous = pauses[service];
  const pause: ServicePause = {
    service,
    reason,
    detail,
    since: previous?.since ?? new Date(now).toISOString(),
    until: new Date(until).toISOString(),
    failures,
  };
  pauses[service] = pause;
  logger.warn(`Archive checks paused: ${describePause(pause)}`);
  return pause;
}

function resumeService(service: ArrService): void {
  if (pauses[service]) logger.info(`Archive checks resumed for ${SERVICE_LABEL[service]}`);
  pauses[service] = null;
  failureCounts[service] = 0;
}

function retryAfterMs(error: unknown): number | null {
  if (!isAxiosError(error)) return null;
  const header = error.response?.headers?.['retry-after'];
  const seconds = typeof header === 'string' ? parseInt(header, 10) : NaN;
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

/** Turn a failed call into the pause it deserves. */
function pauseForError(service: ArrService, error: unknown, context: string): ServicePause {
  const message = error instanceof Error ? error.message : String(error);
  if (isAxiosError(error)) {
    const status = error.response?.status;
    if (status === 429) {
      const wait = retryAfterMs(error);
      return pauseService(service, 'rate_limited', `${context}: HTTP 429${wait ? `, retry after ${Math.round(wait / 1000)}s` : ''}`, Date.now() + Math.max(wait ?? 0, RATE_LIMIT_PAUSE_MS));
    }
    if (!error.response || status === 502 || status === 503 || status === 504) {
      return pauseService(service, 'unreachable', `${context}: ${message}`);
    }
  }
  return pauseService(service, 'search_failed', `${context}: ${message}`);
}

/**
 * Ask the app whether its indexers can answer at all. Pauses the service
 * (and returns false) when every enabled indexer is backed off or the app
 * cannot be reached; clears a pause and returns true otherwise.
 */
export async function probeService(service: ArrService): Promise<boolean> {
  const client = service === 'radarr' ? getRadarrService() : getSonarrService();
  if (!client) return false;
  let health: IndexerHealth;
  try {
    health = await client.getIndexerHealth();
  } catch (error) {
    pauseForError(service, error, 'indexer status');
    return false;
  }
  if (health.total > 0 && health.failing >= health.total) {
    const retryAt = health.retryAt ? new Date(health.retryAt).getTime() : null;
    pauseService(service, 'indexers_down', `${health.failing} of ${health.total}`, retryAt ? Math.min(retryAt, Date.now() + INDEXERS_DOWN_PAUSE_MS) : Date.now() + INDEXERS_DOWN_PAUSE_MS);
    return false;
  }
  resumeService(service);
  return true;
}

function unknownReport(reason: AvailabilityReport['reasons'][number], current: AvailabilityReport['current'], service: AvailabilityReport['service'], indexers: IndexerHealth | null = null): AvailabilityReport {
  return {
    verdict: 'unknown',
    reasons: [reason],
    checkedAt: new Date().toISOString(),
    service,
    releases: 0,
    usenet: 0,
    torrents: 0,
    maxSeeders: null,
    best: null,
    current,
    indexers: indexers ? { total: indexers.total, failing: indexers.failing } : null,
  };
}

/** The seasons worth searching: those with files, thinned to first, middle and last. */
export function pickSeasons(seasons: SonarrSeason[]): number[] {
  const withFiles = seasons
    .filter((s) => s.seasonNumber > 0 && (s.statistics?.episodeFileCount ?? 0) > 0)
    .map((s) => s.seasonNumber)
    .sort((a, b) => a - b);
  if (withFiles.length <= SEASONS_PER_SHOW) return withFiles;
  const middle = withFiles[Math.floor(withFiles.length / 2)]!;
  return Array.from(new Set([withFiles[0]!, middle, withFiles[withFiles.length - 1]!]));
}

/** Indexer health right before a search; an all-down answer pauses instead of searching. */
async function indexersOrPause(service: ArrService, client: { getIndexerHealth(): Promise<IndexerHealth> }): Promise<IndexerHealth | null> {
  let health: IndexerHealth | null;
  try {
    health = await client.getIndexerHealth();
  } catch (error) {
    throw new AvailabilityPausedError(pauseForError(service, error, 'indexer status'));
  }
  if (health.total > 0 && health.failing >= health.total) {
    const retryAt = health.retryAt ? new Date(health.retryAt).getTime() : null;
    throw new AvailabilityPausedError(
      pauseService(service, 'indexers_down', `${health.failing} of ${health.total}`, retryAt ? Math.min(retryAt, Date.now() + INDEXERS_DOWN_PAUSE_MS) : Date.now() + INDEXERS_DOWN_PAUSE_MS)
    );
  }
  return health;
}

async function checkMovie(item: MediaItem, settings: ArchiveSettings): Promise<AvailabilityReport> {
  const radarr = getRadarrService();
  const current = { sizeBytes: item.file_size ?? null, resolution: parseResolution(item.resolution), qualityName: null as string | null };
  if (!radarr) return unknownReport('no_service', current, null);
  if (!item.radarr_id) return unknownReport('not_linked', current, 'radarr');

  // The file Radarr holds is the better source for what is on disk.
  try {
    const movie = await radarr.findMovieById(item.radarr_id);
    if (movie?.movieFile) {
      current.sizeBytes = movie.movieFile.size || current.sizeBytes;
      current.resolution = movie.movieFile.quality?.quality?.resolution || current.resolution;
      current.qualityName = movie.movieFile.quality?.quality?.name ?? null;
    }
  } catch (error) {
    logger.debug('Could not read the Radarr movie before the availability check', { id: item.id, error });
  }

  const indexers = await indexersOrPause('radarr', radarr);
  if (indexers && indexers.total === 0) return unknownReport('no_indexers', current, 'radarr', indexers);

  let releases: ArrRelease[];
  try {
    await throttle();
    releases = await radarr.getReleases(item.radarr_id);
  } catch (error) {
    throw new AvailabilityPausedError(pauseForError('radarr', error, `search for "${item.title}"`));
  }
  resumeService('radarr');
  return { ...judge({ current, releases: releases.map(summariseRelease), indexers, minSeeders: settings.minSeeders }), service: 'radarr' };
}

async function checkShow(item: MediaItem, settings: ArchiveSettings): Promise<AvailabilityReport> {
  const sonarr = getSonarrService();
  const current = { sizeBytes: null as number | null, resolution: parseResolution(item.resolution), qualityName: null as string | null };
  if (!sonarr) return unknownReport('no_service', current, null);
  if (!item.sonarr_id) return unknownReport('not_linked', current, 'sonarr');

  let seasonNumbers: number[] = [];
  try {
    const series = await sonarr.findSeriesById(item.sonarr_id);
    if (series) seasonNumbers = pickSeasons(series.seasons ?? []);
  } catch (error) {
    throw new AvailabilityPausedError(pauseForError('sonarr', error, `series ${item.sonarr_id}`));
  }

  const indexers = await indexersOrPause('sonarr', sonarr);
  if (indexers && indexers.total === 0) return unknownReport('no_indexers', current, 'sonarr', indexers);

  const releases: ReleaseSummary[] = [];
  let withReleases = 0;
  for (const seasonNumber of seasonNumbers) {
    try {
      await throttle();
      const found = await sonarr.getSeasonReleases(item.sonarr_id, seasonNumber);
      if (found.length > 0) withReleases += 1;
      releases.push(...found.map(summariseRelease));
    } catch (error) {
      throw new AvailabilityPausedError(pauseForError('sonarr', error, `search for "${item.title}" season ${seasonNumber}`));
    }
  }
  resumeService('sonarr');
  // Per-season size is what a pack would replace; the show total is not comparable.
  return {
    ...judge({ current: { ...current, sizeBytes: null }, releases, indexers, seasons: { checked: seasonNumbers.length, withReleases }, minSeeders: settings.minSeeders }),
    service: 'sonarr',
  };
}

export interface CheckItemResult {
  item: MediaItem;
  report: AvailabilityReport;
  /** The item was archived by this check (mode `archive`, verdict at-risk). */
  archived: boolean;
}

function serviceFor(item: MediaItem): ArrService {
  return item.type === 'movie' ? 'radarr' : 'sonarr';
}

/**
 * Check one item now, store the verdict, and apply the archive mode. A fresh
 * verdict is reused unless `force` is set. Throws AvailabilityPausedError
 * when the owning app is paused (unless forced) or the search could not get
 * an answer; nothing is stored in that case.
 */
export async function checkItem(item: MediaItem, options: { force?: boolean; actorName?: string } = {}): Promise<CheckItemResult> {
  const settings = getArchiveSettings();
  const existing = parseAvailability(item.availability);
  if (!options.force && existing && !isStale(existing, settings.recheckDays)) {
    return { item, report: existing, archived: false };
  }
  const pause = getPause(serviceFor(item));
  if (pause && !options.force) throw new AvailabilityPausedError(pause);

  // The sync links by id; when that found nothing, try the folder and title
  // before calling the item unlinked (the same lookup deletion uses).
  if ((item.type === 'movie' && !item.radarr_id) || (item.type === 'show' && !item.sonarr_id)) {
    item = await linkToArr(item, 'availability check');
  }

  const report = item.type === 'movie' ? await checkMovie(item, settings) : await checkShow(item, settings);
  const updated =
    mediaItemsRepo.update(item.id, {
      availability: JSON.stringify(report),
      availability_checked_at: report.checkedAt,
      // A new verdict supersedes an old "delete anyway".
      ...(options.force ? { availability_decision: null } : {}),
    }) ?? item;

  logger.info(`Availability of "${item.title}": ${report.verdict} (${describeReasons(report)})`);

  if (report.verdict === 'at_risk' && item.status === 'pending_deletion' && settings.mode === 'archive') {
    const result = archiveItems([item.id], `Archived: ${describeReasons(report)}`, options.actorName ?? 'Archive');
    const archived = result.archived.length > 0;
    return { item: archived ? (mediaItemsRepo.getById(item.id) ?? updated) : updated, report, archived };
  }

  if (report.verdict !== 'replaceable' && item.status === 'pending_deletion' && settings.mode === 'ask' && item.availability_decision !== 'delete') {
    try {
      logActivity({
        eventType: 'protection',
        action: 'availability_hold',
        actorType: 'scheduler',
        actorName: options.actorName ?? 'Archive',
        targetType: 'media_item',
        targetId: item.id,
        targetTitle: item.title,
        metadata: JSON.stringify({ verdict: report.verdict, reasons: report.reasons, detail: describeReasons(report) }),
      });
    } catch (error) {
      logger.warn('Failed to log the availability hold', error);
    }
  }

  return { item: updated, report, archived: false };
}

export interface CheckQueueResult {
  checked: number;
  replaceable: number;
  atRisk: number;
  unknown: number;
  archived: number;
  /** Left for the next pass because the pass cap was reached. */
  skipped: number;
  /** Left unchecked because the owning app is paused. */
  paused: number;
  pauses: ServicePause[];
}

/** Queued items that still need a verdict (none yet, or an old one). */
export function itemsNeedingCheck(settings: ArchiveSettings = getArchiveSettings(), now: Date = new Date()): MediaItem[] {
  return mediaItemsRepo
    .getPendingDeletion()
    .filter((item) => isStale(parseAvailability(item.availability), settings.recheckDays, now));
}

/** What the Queue page, the connector and stack health show about the checker. */
export function getAvailabilityStatus(): AvailabilityStatus {
  const settings = getArchiveSettings();
  const now = new Date();
  return {
    enabled: settings.enabled,
    paused: (['radarr', 'sonarr'] as ArrService[]).map((s) => getPause(s, now)).filter((p): p is ServicePause => p !== null),
    unchecked: settings.enabled ? itemsNeedingCheck(settings, now).length : 0,
    lastPassAt,
  };
}

/**
 * Give every queued item a verdict. Runs one pass at a time; a call while a
 * pass is running joins it rather than starting another. A paused service is
 * probed first and skipped while still down; a failure mid-pass pauses that
 * service and the pass moves on to the other one.
 */
export function checkQueue(options: { limit?: number; actorName?: string } = {}): Promise<CheckQueueResult> {
  if (passRunning) return passRunning;
  passRunning = (async () => {
    const result: CheckQueueResult = { checked: 0, replaceable: 0, atRisk: 0, unknown: 0, archived: 0, skipped: 0, paused: 0, pauses: [] };
    const settings = getArchiveSettings();
    if (!settings.enabled) return result;
    lastPassAt = new Date().toISOString();
    const limit = options.limit ?? MAX_ITEMS_PER_PASS;
    const items = itemsNeedingCheck(settings);
    result.skipped = Math.max(0, items.length - limit);
    const batch = items.slice(0, limit);

    for (const service of ['radarr', 'sonarr'] as ArrService[]) {
      const mine = batch.filter((item) => serviceFor(item) === service);
      if (mine.length === 0) continue;
      // A paused service is probed once its time is up; still down means skip.
      if (getPause(service) || !(await probeService(service))) {
        result.paused += mine.length;
        continue;
      }
      for (const item of mine) {
        try {
          const { report, archived } = await checkItem(item, { actorName: options.actorName });
          result.checked += 1;
          if (archived) result.archived += 1;
          if (report.verdict === 'replaceable') result.replaceable += 1;
          else if (report.verdict === 'at_risk') result.atRisk += 1;
          else result.unknown += 1;
        } catch (error) {
          if (error instanceof AvailabilityPausedError) {
            // The rest of this service's items wait for the next probe.
            result.paused += mine.length - mine.indexOf(item);
            break;
          }
          logger.warn(`Availability check failed for "${item.title}"`, { error: (error as Error).message });
        }
      }
    }

    result.pauses = getAvailabilityStatus().paused;
    if (result.checked > 0 || result.paused > 0) {
      logger.info(
        `Availability pass: ${result.checked} checked, ${result.replaceable} replaceable, ${result.atRisk} at risk, ${result.unknown} unknown, ${result.archived} archived${result.paused > 0 ? `, ${result.paused} waiting (${result.pauses.map(describePause).join('; ')})` : ''}`
      );
    }
    return result;
  })().finally(() => {
    passRunning = null;
  });
  return passRunning;
}

/**
 * Ask for a background pass soon. Debounced, so a rule that queues fifty
 * items at once starts one pass, not fifty.
 */
export function kickAvailabilityChecks(delayMs: number = 5_000): void {
  if (!getArchiveSettings().enabled) return;
  if (kickTimer) clearTimeout(kickTimer);
  kickTimer = setTimeout(() => {
    kickTimer = null;
    checkQueue({ actorName: 'Archive' }).catch((error) => logger.warn('Background availability pass failed', error));
  }, delayMs);
  kickTimer.unref?.();
}

registerAvailabilityKick(() => kickAvailabilityChecks());

// A pass shortly after start-up, so items queued while the app was down (or
// by an older version) get their verdicts without waiting for the schedule.
if (process.env['NODE_ENV'] !== 'test') kickAvailabilityChecks(60_000);

/** Tests only. */
export function resetAvailabilityState(options: { searchGapMs?: number } = {}): void {
  searchGapMs = options.searchGapMs ?? DEFAULT_SEARCH_GAP_MS;
  lastSearchAt = 0;
  lastPassAt = null;
  passRunning = null;
  pauses.radarr = null;
  pauses.sonarr = null;
  failureCounts.radarr = 0;
  failureCounts.sonarr = 0;
  if (kickTimer) clearTimeout(kickTimer);
  kickTimer = null;
}
