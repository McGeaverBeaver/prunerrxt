/**
 * Watch state: what the plays on one title add up to, per viewer.
 *
 * The sync already stores a play count, a last-watched date and the names of
 * everyone who watched. That cannot tell "someone is halfway through season
 * three" from "everyone finished it a year ago", and that distinction is
 * what a rule needs before it deletes a show. This module turns the raw
 * plays a provider reports into:
 *
 *   - who has started it, who has finished it, and who is in progress;
 *   - for a show, how many of its episodes have been watched by anyone;
 *   - a completion share the rules engine can compare against.
 *
 * "In progress" means the viewer has not finished and played it within the
 * in-progress window (30 days by default, `watch_state_in_progress_days`).
 * A movie is finished by a viewer when any of their plays reached the
 * provider's watched threshold; a show when they have watched every episode
 * the library holds.
 *
 * What a provider can see decides how good this is. Tautulli records partial
 * plays, so a movie stopped at 40 % shows as in progress. Plex's own history
 * only records plays that reached the watched threshold, so under the direct
 * provider a movie is never in progress, while a show still is as long as
 * episodes remain unwatched and someone played one recently. Jellyfin and
 * Emby behave like Plex direct unless the Playback Reporting plugin is in.
 */
import settingsRepo from '../db/repositories/settings';

/** One play of one movie or episode by one viewer, as every provider can report it. */
export interface PlayRecord {
  user: string;
  /** The movie's or the episode's own id on the media server. */
  ratingKey: string | null;
  /** Reached the provider's watched threshold. */
  watched: boolean;
  stoppedAt: Date;
}

export interface WatchState {
  /** Viewers with at least one play. */
  startedBy: string[];
  /** Viewers who finished it (a movie) or every episode the library holds (a show). */
  completedBy: string[];
  /** Viewers who started, have not finished, and played it within the window. */
  inProgressUsers: string[];
  /** Latest play per viewer, ISO. */
  lastPlayedByUser: Record<string, string>;
  /** Distinct episodes with a finished play by anyone; 0 or 1 for a movie. */
  episodesWatched: number;
  /** Episodes the library holds for a show; null for a movie or when unknown. */
  episodesTotal: number | null;
  /** 0..1: a movie is 0 or 1; a show is episodesWatched / episodesTotal; null when the total is unknown. */
  completion: number | null;
  computedAt: string;
}

export const DEFAULT_IN_PROGRESS_DAYS = 30;
export const IN_PROGRESS_DAYS_SETTING = 'watch_state_in_progress_days';

export function inProgressWindowDays(): number {
  const value = settingsRepo.getNumber(IN_PROGRESS_DAYS_SETTING, DEFAULT_IN_PROGRESS_DAYS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_IN_PROGRESS_DAYS;
}

export interface ComputeWatchStateOptions {
  isShow: boolean;
  /** Episodes the library holds, for a show. */
  episodeCount?: number | null;
  now?: Date;
  inProgressDays?: number;
}

/** Pure: the same plays always give the same state. */
export function computeWatchState(plays: readonly PlayRecord[], options: ComputeWatchStateOptions): WatchState {
  const now = options.now ?? new Date();
  const windowMs = (options.inProgressDays ?? DEFAULT_IN_PROGRESS_DAYS) * 24 * 60 * 60 * 1000;
  const episodesTotal = options.isShow && options.episodeCount && options.episodeCount > 0 ? options.episodeCount : null;

  const byUser = new Map<string, { last: Date; lastWatched: boolean; watchedKeys: Set<string>; anyWatched: boolean }>();
  const watchedKeys = new Set<string>();

  for (const play of plays) {
    const user = (play.user || '').trim();
    if (!user) continue;
    const key = play.ratingKey ?? '';
    const entry = byUser.get(user) ?? { last: play.stoppedAt, lastWatched: play.watched, watchedKeys: new Set<string>(), anyWatched: false };
    if (play.stoppedAt >= entry.last) {
      entry.last = play.stoppedAt;
      entry.lastWatched = play.watched;
    }
    if (play.watched) {
      entry.anyWatched = true;
      if (key) {
        entry.watchedKeys.add(key);
        watchedKeys.add(key);
      }
    }
    byUser.set(user, entry);
  }

  const startedBy: string[] = [];
  const completedBy: string[] = [];
  const inProgressUsers: string[] = [];
  const lastPlayedByUser: Record<string, string> = {};

  for (const [user, entry] of byUser) {
    startedBy.push(user);
    lastPlayedByUser[user] = entry.last.toISOString();

    let complete: boolean;
    if (options.isShow) {
      complete = episodesTotal !== null && entry.watchedKeys.size >= episodesTotal;
    } else {
      complete = entry.anyWatched;
    }
    if (complete) {
      completedBy.push(user);
      continue;
    }
    const recent = now.getTime() - entry.last.getTime() <= windowMs;
    // A show is in progress while its viewer keeps coming back; a movie only
    // when the last play was cut short (a finished movie is complete above).
    if (recent) inProgressUsers.push(user);
  }

  const sortNames = (a: string, b: string) => a.localeCompare(b);
  startedBy.sort(sortNames);
  completedBy.sort(sortNames);
  inProgressUsers.sort(sortNames);

  const episodesWatched = options.isShow ? watchedKeys.size : watchedKeys.size > 0 || completedBy.length > 0 ? 1 : 0;
  let completion: number | null;
  if (options.isShow) {
    completion = episodesTotal === null ? null : Math.min(1, episodesWatched / episodesTotal);
  } else {
    completion = completedBy.length > 0 ? 1 : 0;
  }

  return {
    startedBy,
    completedBy,
    inProgressUsers,
    lastPlayedByUser,
    episodesWatched,
    episodesTotal,
    completion,
    computedAt: now.toISOString(),
  };
}

/** The empty state for a title nobody has played. */
export function emptyWatchState(now: Date = new Date()): WatchState {
  return {
    startedBy: [],
    completedBy: [],
    inProgressUsers: [],
    lastPlayedByUser: {},
    episodesWatched: 0,
    episodesTotal: null,
    completion: null,
    computedAt: now.toISOString(),
  };
}

/** Cached Tracearr / media-server history rows in the provider-neutral shape. */
export function cacheEntriesToPlays(
  entries: ReadonlyArray<{ plex_rating_key: string; username: string; watched: boolean; stopped_at: string }>
): PlayRecord[] {
  return entries.map((e) => ({
    user: e.username,
    ratingKey: e.plex_rating_key || null,
    watched: e.watched,
    stoppedAt: new Date(e.stopped_at),
  }));
}

export function parseWatchState(raw: string | null | undefined): WatchState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<WatchState>;
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      startedBy: Array.isArray(parsed.startedBy) ? parsed.startedBy.map(String) : [],
      completedBy: Array.isArray(parsed.completedBy) ? parsed.completedBy.map(String) : [],
      inProgressUsers: Array.isArray(parsed.inProgressUsers) ? parsed.inProgressUsers.map(String) : [],
      lastPlayedByUser: parsed.lastPlayedByUser && typeof parsed.lastPlayedByUser === 'object' ? (parsed.lastPlayedByUser as Record<string, string>) : {},
      episodesWatched: typeof parsed.episodesWatched === 'number' ? parsed.episodesWatched : 0,
      episodesTotal: typeof parsed.episodesTotal === 'number' ? parsed.episodesTotal : null,
      completion: typeof parsed.completion === 'number' ? parsed.completion : null,
      computedAt: typeof parsed.computedAt === 'string' ? parsed.computedAt : '',
    };
  } catch {
    return null;
  }
}
