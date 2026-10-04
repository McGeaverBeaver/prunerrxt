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
 * The verdict logic itself is in availabilityVerdict.ts.
 */
import logger from '../utils/logger';
import mediaItemsRepo from '../db/repositories/mediaItems';
import { logActivity } from '../db/repositories/activity';
import type { MediaItem } from '../types';
import type { ArrRelease, SonarrSeason } from './types';
import { getRadarrService, getSonarrService } from './init';
import { archiveItems } from './mediaActions';
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

let lastSearchAt = 0;
let passRunning: Promise<CheckQueueResult> | null = null;
let kickTimer: NodeJS.Timeout | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function throttle(): Promise<void> {
  const wait = lastSearchAt + searchGapMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastSearchAt = Date.now();
}

function unknownReport(reason: AvailabilityReport['reasons'][number], current: AvailabilityReport['current'], service: AvailabilityReport['service'], error?: string): AvailabilityReport {
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
    indexers: null,
    ...(error ? { error } : {}),
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

  let indexers: { total: number; failing: number } | null = null;
  try {
    indexers = await radarr.getIndexerHealth();
  } catch {
    indexers = null;
  }

  let releases: ArrRelease[];
  try {
    await throttle();
    releases = await radarr.getReleases(item.radarr_id);
  } catch (error) {
    return unknownReport('search_failed', current, 'radarr', (error as Error).message);
  }
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
    return unknownReport('search_failed', current, 'sonarr', (error as Error).message);
  }

  let indexers: { total: number; failing: number } | null = null;
  try {
    indexers = await sonarr.getIndexerHealth();
  } catch {
    indexers = null;
  }

  const releases: ReleaseSummary[] = [];
  let withReleases = 0;
  for (const seasonNumber of seasonNumbers) {
    try {
      await throttle();
      const found = await sonarr.getSeasonReleases(item.sonarr_id, seasonNumber);
      if (found.length > 0) withReleases += 1;
      releases.push(...found.map(summariseRelease));
    } catch (error) {
      return unknownReport('search_failed', current, 'sonarr', `season ${seasonNumber}: ${(error as Error).message}`);
    }
  }
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

/**
 * Check one item now, store the verdict, and apply the archive mode. A fresh
 * verdict is reused unless `force` is set.
 */
export async function checkItem(item: MediaItem, options: { force?: boolean; actorName?: string } = {}): Promise<CheckItemResult> {
  const settings = getArchiveSettings();
  const existing = parseAvailability(item.availability);
  if (!options.force && existing && !isStale(existing, settings.recheckDays)) {
    return { item, report: existing, archived: false };
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
  skipped: number;
}

/** Queued items that still need a verdict (none yet, or an old one). */
export function itemsNeedingCheck(settings: ArchiveSettings = getArchiveSettings(), now: Date = new Date()): MediaItem[] {
  return mediaItemsRepo
    .getPendingDeletion()
    .filter((item) => isStale(parseAvailability(item.availability), settings.recheckDays, now));
}

/**
 * Give every queued item a verdict. Runs one pass at a time; a call while a
 * pass is running joins it rather than starting another.
 */
export function checkQueue(options: { limit?: number; actorName?: string } = {}): Promise<CheckQueueResult> {
  if (passRunning) return passRunning;
  passRunning = (async () => {
    const result: CheckQueueResult = { checked: 0, replaceable: 0, atRisk: 0, unknown: 0, archived: 0, skipped: 0 };
    const settings = getArchiveSettings();
    if (!settings.enabled) return result;
    const limit = options.limit ?? MAX_ITEMS_PER_PASS;
    const items = itemsNeedingCheck(settings);
    result.skipped = Math.max(0, items.length - limit);
    for (const item of items.slice(0, limit)) {
      try {
        const { report, archived } = await checkItem(item, { actorName: options.actorName });
        result.checked += 1;
        if (archived) result.archived += 1;
        if (report.verdict === 'replaceable') result.replaceable += 1;
        else if (report.verdict === 'at_risk') result.atRisk += 1;
        else result.unknown += 1;
      } catch (error) {
        logger.warn(`Availability check failed for "${item.title}"`, { error: (error as Error).message });
      }
    }
    if (result.checked > 0) {
      logger.info(`Availability pass: ${result.checked} checked, ${result.replaceable} replaceable, ${result.atRisk} at risk, ${result.unknown} unknown, ${result.archived} archived`);
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

/** Tests only. */
export function resetAvailabilityState(options: { searchGapMs?: number } = {}): void {
  searchGapMs = options.searchGapMs ?? DEFAULT_SEARCH_GAP_MS;
  lastSearchAt = 0;
  passRunning = null;
  if (kickTimer) clearTimeout(kickTimer);
  kickTimer = null;
}
