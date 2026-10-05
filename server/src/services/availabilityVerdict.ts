/**
 * Archive: can a queued title be downloaded again?
 *
 * Before PrunerrXT deletes a movie or show it asks the app that owns it (Radarr
 * or Sonarr) what the indexers can offer right now, and turns the answer into
 * one of three verdicts:
 *
 *   replaceable  something as good as the file on disk is out there;
 *   at_risk      nothing is, or what is would be a downgrade, or it hangs on
 *                a few seeders;
 *   unknown      the question could not be answered (the app is not linked,
 *                every indexer is down, the search failed).
 *
 * What happens to an at-risk item is the `archive_mode` setting: `ask` holds
 * it in the queue until a person decides, `archive` protects it at once and
 * takes it out of the queue, `delete` records the verdict and carries on.
 *
 * This module is the pure half: the verdict logic, the settings and the
 * "is this item held" test. It talks to nothing, so the deletion service can
 * import it without a cycle. The checker that calls Radarr and Sonarr lives
 * in availability.ts.
 */
import settingsRepo from '../db/repositories/settings';
import type { MediaItem } from '../types';

export type AvailabilityVerdict = 'replaceable' | 'at_risk' | 'unknown';

export type AvailabilityReason =
  /** No indexer offered a release. */
  | 'no_releases'
  /** The best release on offer is a lower resolution than the file on disk. */
  | 'downgrade'
  /** Same resolution, but every release is under half the size of the file on disk. */
  | 'smaller'
  /** Only torrents, and the best of them has fewer seeders than the floor. */
  | 'low_seeders'
  /** At least one of the show's seasons has no season pack on offer. */
  | 'missing_seasons'
  /** The item carries no Radarr/Sonarr id, so nothing could be asked. */
  | 'not_linked'
  /** Every enabled indexer is currently failing, so an empty answer means nothing. */
  | 'indexers_down'
  /** The app has no enabled indexer at all, so it can never find anything. */
  | 'no_indexers'
  /** Radarr/Sonarr is not configured. */
  | 'no_service'
  /** The search itself failed; see `error`. */
  | 'search_failed';

export type ArchiveMode = 'ask' | 'archive' | 'delete';

export interface ArchiveSettings {
  enabled: boolean;
  mode: ArchiveMode;
  /** A torrent-only title needs at least this many seeders on its best release. */
  minSeeders: number;
  /** A verdict older than this is checked again before it is acted on. */
  recheckDays: number;
}

export const ARCHIVE_SETTING_KEYS = {
  enabled: 'archive_enabled',
  mode: 'archive_mode',
  minSeeders: 'archive_minSeeders',
  recheckDays: 'archive_recheckDays',
} as const;

export const ARCHIVE_DEFAULTS: ArchiveSettings = { enabled: true, mode: 'ask', minSeeders: 5, recheckDays: 7 };

export function getArchiveSettings(): ArchiveSettings {
  const mode = settingsRepo.getValue(ARCHIVE_SETTING_KEYS.mode, ARCHIVE_DEFAULTS.mode);
  return {
    enabled: settingsRepo.getBoolean(ARCHIVE_SETTING_KEYS.enabled, ARCHIVE_DEFAULTS.enabled),
    mode: mode === 'archive' || mode === 'delete' ? mode : 'ask',
    minSeeders: Math.max(0, settingsRepo.getNumber(ARCHIVE_SETTING_KEYS.minSeeders, ARCHIVE_DEFAULTS.minSeeders)),
    recheckDays: Math.max(1, settingsRepo.getNumber(ARCHIVE_SETTING_KEYS.recheckDays, ARCHIVE_DEFAULTS.recheckDays)),
  };
}

/** One release as the verdict sees it: enough to compare, nothing to download. */
export interface ReleaseSummary {
  title: string;
  indexer: string;
  protocol: 'usenet' | 'torrent';
  sizeBytes: number;
  ageDays: number;
  seeders: number | null;
  /** Vertical resolution (480, 720, 1080, 2160); null when the app could not tell. */
  resolution: number | null;
  qualityName: string;
}

export interface CurrentFile {
  sizeBytes: number | null;
  resolution: number | null;
  qualityName: string | null;
}

export interface JudgeInput {
  current: CurrentFile;
  releases: ReleaseSummary[];
  indexers: { total: number; failing: number } | null;
  /** Shows: how many seasons were searched, and how many had at least one pack. */
  seasons?: { checked: number; withReleases: number };
  minSeeders: number;
}

/** The stored verdict: what was decided and the numbers behind it. */
export interface AvailabilityReport {
  verdict: AvailabilityVerdict;
  reasons: AvailabilityReason[];
  checkedAt: string;
  service: 'radarr' | 'sonarr' | null;
  releases: number;
  usenet: number;
  torrents: number;
  /** Highest seeder count among the torrents on offer; null when there are none. */
  maxSeeders: number | null;
  best: { title: string; indexer: string; protocol: string; sizeBytes: number; resolution: number | null; qualityName: string; ageDays: number } | null;
  current: CurrentFile;
  indexers: { total: number; failing: number } | null;
  seasons?: { checked: number; withReleases: number };
  error?: string;
}

/** `qualityName` and `resolution` from a Radarr/Sonarr quality block. */
export function summariseRelease(r: {
  title: string;
  indexer: string;
  protocol: string;
  size: number;
  age: number;
  seeders?: number | null;
  quality?: { quality?: { name?: string; resolution?: number } };
}): ReleaseSummary {
  const resolution = r.quality?.quality?.resolution;
  return {
    title: r.title,
    indexer: r.indexer,
    protocol: r.protocol === 'usenet' ? 'usenet' : 'torrent',
    sizeBytes: Number(r.size) || 0,
    ageDays: Number(r.age) || 0,
    seeders: typeof r.seeders === 'number' ? r.seeders : null,
    resolution: typeof resolution === 'number' && resolution > 0 ? resolution : null,
    qualityName: r.quality?.quality?.name ?? 'Unknown',
  };
}

/** "1080", "4k", "sd", "720p" → vertical lines, or null. */
export function parseResolution(value: string | number | null | undefined): number | null {
  if (typeof value === 'number') return value > 0 ? value : null;
  if (!value) return null;
  const v = String(value).trim().toLowerCase();
  if (v === '4k' || v === 'uhd' || v === '2160p') return 2160;
  if (v === '8k') return 4320;
  if (v === 'sd') return 480;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Pick the release to show as "best": highest resolution, then largest.
 * A bigger file at the same resolution is the usual sign of a better encode.
 */
export function bestRelease(releases: ReleaseSummary[]): ReleaseSummary | null {
  let best: ReleaseSummary | null = null;
  for (const r of releases) {
    if (!best) {
      best = r;
      continue;
    }
    const a = r.resolution ?? 0;
    const b = best.resolution ?? 0;
    if (a > b || (a === b && r.sizeBytes > best.sizeBytes)) best = r;
  }
  return best;
}

/**
 * Turn what the indexers offered into a verdict. Pure, so it is testable
 * against hand-written release lists.
 */
export function judge(input: JudgeInput, now: Date = new Date()): Omit<AvailabilityReport, 'service'> {
  const { current, releases, indexers, seasons, minSeeders } = input;
  const reasons: AvailabilityReason[] = [];
  const usenet = releases.filter((r) => r.protocol === 'usenet').length;
  const torrents = releases.length - usenet;
  const seeders = releases.filter((r) => r.protocol === 'torrent' && r.seeders !== null).map((r) => r.seeders as number);
  const maxSeeders = seeders.length > 0 ? Math.max(...seeders) : null;
  const best = bestRelease(releases);

  const base = {
    checkedAt: now.toISOString(),
    releases: releases.length,
    usenet,
    torrents,
    maxSeeders,
    best: best
      ? {
          title: best.title,
          indexer: best.indexer,
          protocol: best.protocol,
          sizeBytes: best.sizeBytes,
          resolution: best.resolution,
          qualityName: best.qualityName,
          ageDays: best.ageDays,
        }
      : null,
    current,
    indexers,
    ...(seasons ? { seasons } : {}),
  };

  if (releases.length === 0) {
    if (indexers && indexers.total === 0) {
      return { ...base, verdict: 'unknown', reasons: ['no_indexers'] };
    }
    if (indexers && indexers.failing >= indexers.total) {
      return { ...base, verdict: 'unknown', reasons: ['indexers_down'] };
    }
    return { ...base, verdict: 'at_risk', reasons: ['no_releases'] };
  }

  // Would what comes back be as good as what is on disk?
  const bestResolution = best?.resolution ?? null;
  let comparable = releases;
  if (current.resolution !== null && bestResolution !== null) {
    if (bestResolution < current.resolution) {
      reasons.push('downgrade');
    } else {
      comparable = releases.filter((r) => (r.resolution ?? 0) >= (current.resolution as number));
      const largest = Math.max(...comparable.map((r) => r.sizeBytes));
      if (current.sizeBytes && largest > 0 && largest < current.sizeBytes * 0.5) {
        reasons.push('smaller');
      }
    }
  }

  // Would it actually download? Usenet needs no seeders; torrents do.
  const comparableUsenet = comparable.some((r) => r.protocol === 'usenet');
  if (!comparableUsenet) {
    const comparableSeeders = comparable
      .filter((r) => r.protocol === 'torrent')
      .map((r) => r.seeders ?? 0);
    const top = comparableSeeders.length > 0 ? Math.max(...comparableSeeders) : 0;
    if (top < minSeeders) reasons.push('low_seeders');
  }

  if (seasons && seasons.checked > 0 && seasons.withReleases < seasons.checked) {
    reasons.push('missing_seasons');
  }

  return { ...base, verdict: reasons.length > 0 ? 'at_risk' : 'replaceable', reasons };
}

/** The stored JSON, or null when the item was never checked or the column is garbage. */
export function parseAvailability(raw: string | null | undefined): AvailabilityReport | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<AvailabilityReport>;
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.verdict !== 'replaceable' && parsed.verdict !== 'at_risk' && parsed.verdict !== 'unknown') return null;
    return {
      verdict: parsed.verdict,
      reasons: Array.isArray(parsed.reasons) ? (parsed.reasons as AvailabilityReason[]) : [],
      checkedAt: typeof parsed.checkedAt === 'string' ? parsed.checkedAt : '',
      service: parsed.service === 'radarr' || parsed.service === 'sonarr' ? parsed.service : null,
      releases: Number(parsed.releases) || 0,
      usenet: Number(parsed.usenet) || 0,
      torrents: Number(parsed.torrents) || 0,
      maxSeeders: typeof parsed.maxSeeders === 'number' ? parsed.maxSeeders : null,
      best: parsed.best && typeof parsed.best === 'object' ? parsed.best : null,
      current: parsed.current && typeof parsed.current === 'object' ? parsed.current : { sizeBytes: null, resolution: null, qualityName: null },
      indexers: parsed.indexers && typeof parsed.indexers === 'object' ? parsed.indexers : null,
      ...(parsed.seasons ? { seasons: parsed.seasons } : {}),
      ...(typeof parsed.error === 'string' ? { error: parsed.error } : {}),
    };
  } catch {
    return null;
  }
}

/** True when the verdict is old enough that it should be asked again. */
export function isStale(report: AvailabilityReport | null, recheckDays: number, now: Date = new Date()): boolean {
  if (!report || !report.checkedAt) return true;
  const age = now.getTime() - new Date(report.checkedAt).getTime();
  return !Number.isFinite(age) || age > recheckDays * 86_400_000;
}

export type HoldReason = 'at_risk' | 'unknown' | 'unchecked';

export interface HoldState {
  held: boolean;
  reason: HoldReason | null;
  report: AvailabilityReport | null;
}

/**
 * Whether automatic processing must leave this queued item alone.
 *
 * In `ask` mode an at-risk or unknown verdict holds the item until a person
 * chooses "delete anyway" (`availability_decision = 'delete'`). An item with
 * no verdict yet is held in both `ask` and `archive` mode: the checker runs
 * before the queue does, so this only happens while Radarr/Sonarr or their
 * indexers are down, and deleting on no answer is exactly what Archive is
 * there to prevent. `delete` mode holds nothing.
 */
export function holdState(item: Pick<MediaItem, 'availability' | 'availability_decision'>, settings: ArchiveSettings = getArchiveSettings()): HoldState {
  const report = parseAvailability(item.availability);
  if (!settings.enabled || settings.mode === 'delete') return { held: false, reason: null, report };
  if (item.availability_decision === 'delete') return { held: false, reason: null, report };
  if (!report) return { held: true, reason: 'unchecked', report };
  if (settings.mode === 'archive') return { held: false, reason: null, report };
  if (report.verdict === 'replaceable') return { held: false, reason: null, report };
  return { held: true, reason: report.verdict, report };
}

/** One line a person or an assistant can read, e.g. "No release found on any indexer". */
export function describeReasons(report: AvailabilityReport): string {
  const parts: string[] = [];
  for (const reason of report.reasons) {
    switch (reason) {
      case 'no_releases':
        parts.push(report.indexers ? `no release on any of ${report.indexers.total} indexer(s)` : 'no release on any indexer');
        break;
      case 'downgrade':
        parts.push(`best on offer is ${report.best?.resolution ?? '?'}p, file is ${report.current.resolution ?? '?'}p`);
        break;
      case 'smaller':
        parts.push('every release is under half the size of the file on disk');
        break;
      case 'low_seeders':
        parts.push(`torrents only, best has ${report.maxSeeders ?? 0} seeder(s)`);
        break;
      case 'missing_seasons':
        parts.push(`${report.seasons ? report.seasons.checked - report.seasons.withReleases : 'some'} of ${report.seasons?.checked ?? '?'} season(s) checked have no pack`);
        break;
      case 'not_linked':
        parts.push('not linked to Radarr or Sonarr');
        break;
      case 'indexers_down':
        parts.push('every indexer is currently failing');
        break;
      case 'no_indexers':
        parts.push('no enabled indexer in Radarr/Sonarr');
        break;
      case 'no_service':
        parts.push('Radarr or Sonarr is not configured');
        break;
      case 'search_failed':
        parts.push(report.error ? `search failed: ${report.error}` : 'search failed');
        break;
    }
  }
  if (parts.length === 0) {
    return report.verdict === 'replaceable'
      ? `${report.releases} release(s) available${report.best ? `, best ${report.best.qualityName} on ${report.best.indexer}` : ''}`
      : 'no details';
  }
  return parts.join('; ');
}
