/**
 * Watch patterns: how much the library is actually used.
 *
 * Plays per week and active viewers come from the recent sessions (Tautulli
 * live, or the cached Tracearr / media-server history). What is never
 * played, and what has gone quiet, comes from the per-item play counts the
 * sync keeps. Both feed the rules engine, so seeing them here is what makes
 * a "not watched in a year" rule feel safe to switch on.
 */
import { getDatabase } from '../../db';
import { getRecentSessions, type SessionProvider } from './sessions';
import { countBySeverity, worstSeverity, type InsightCounts, type InsightItem, type InsightSeverity } from './types';

export interface WeekPoint {
  /** Monday of the week, ISO date. */
  weekStart: string;
  plays: number;
  users: number;
  movies: number;
  episodes: number;
}

export interface ViewerStat {
  user: string;
  plays: number;
  lastSeen: string;
  /** Share of all plays in the window, 0..1. */
  share: number;
}

export interface QuietItem {
  id: number;
  title: string;
  type: 'movie' | 'show';
  year: number | null;
  sizeBytes: number;
  playCount: number;
  lastWatchedAt: string | null;
  addedAt: string | null;
}

export interface WatchPatternsReport {
  checkedAt: string;
  overall: InsightSeverity;
  counts: InsightCounts;
  items: InsightItem[];
  provider: SessionProvider;
  note: string | null;
  windowDays: number;
  /** Last 12 weeks, oldest first. */
  weekly: WeekPoint[];
  last30: { plays: number; users: number; movies: number; episodes: number; hoursWatched: number | null };
  previous30: { plays: number; users: number };
  knownUsers: number;
  viewers: ViewerStat[];
  /** Shows with plays in the window, most played first. */
  topShows: Array<{ title: string; plays: number; users: number }>;
  topMovies: Array<{ title: string; plays: number; users: number }>;
  library: {
    items: number;
    bytes: number;
    neverPlayed: { count: number; bytes: number };
    /** Never played, and added more than 90 days ago: has had its chance. */
    neverPlayedOld: { count: number; bytes: number };
    playedLast90: { count: number };
    quietOverYear: { count: number; bytes: number };
  };
  /** Largest items with no play in a year (or ever), largest first. */
  quietLargest: QuietItem[];
}

const CACHE_TTL_MS = 5 * 60_000;
const WINDOW_DAYS = 90;
let cached: { at: number; report: WatchPatternsReport } | null = null;

function mondayOf(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay();
  const diff = (day + 6) % 7;
  d.setUTCDate(d.getUTCDate() - diff);
  return d.toISOString().slice(0, 10);
}

async function build(refresh: boolean): Promise<WatchPatternsReport> {
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const result = await getRecentSessions(WINDOW_DAYS, refresh);
  const sessions = result.sessions;

  // Weekly series for the last 12 weeks, always 12 points even when empty.
  const weeks = new Map<string, WeekPoint>();
  for (let i = 11; i >= 0; i--) {
    const key = mondayOf(new Date(now - i * 7 * dayMs));
    weeks.set(key, { weekStart: key, plays: 0, users: 0, movies: 0, episodes: 0 });
  }
  const weekUsers = new Map<string, Set<string>>();
  for (const s of sessions) {
    const key = mondayOf(s.stoppedAt);
    const point = weeks.get(key);
    if (!point) continue;
    point.plays += 1;
    if (s.mediaType === 'movie') point.movies += 1;
    else if (s.mediaType === 'episode') point.episodes += 1;
    const set = weekUsers.get(key) ?? new Set<string>();
    set.add(s.user);
    weekUsers.set(key, set);
  }
  for (const [key, set] of weekUsers) {
    const point = weeks.get(key);
    if (point) point.users = set.size;
  }

  const since30 = now - 30 * dayMs;
  const since60 = now - 60 * dayMs;
  const last30 = sessions.filter((s) => s.stoppedAt.getTime() >= since30);
  const prev30 = sessions.filter((s) => s.stoppedAt.getTime() >= since60 && s.stoppedAt.getTime() < since30);
  const hours = result.hasPlaybackDetail ? last30.reduce((sum, s) => sum + (s.durationSec ?? 0), 0) / 3600 : null;

  // Viewers over the whole window.
  const byUser = new Map<string, { plays: number; lastSeen: Date }>();
  for (const s of sessions) {
    const cur = byUser.get(s.user) ?? { plays: 0, lastSeen: s.stoppedAt };
    cur.plays += 1;
    if (s.stoppedAt > cur.lastSeen) cur.lastSeen = s.stoppedAt;
    byUser.set(s.user, cur);
  }
  const viewers: ViewerStat[] = [...byUser.entries()]
    .map(([user, v]) => ({ user, plays: v.plays, lastSeen: v.lastSeen.toISOString(), share: sessions.length ? v.plays / sessions.length : 0 }))
    .sort((a, b) => b.plays - a.plays)
    .slice(0, 12);

  const top = (type: 'movie' | 'episode') => {
    const map = new Map<string, { plays: number; users: Set<string> }>();
    for (const s of sessions) {
      if (s.mediaType !== type) continue;
      const cur = map.get(s.title) ?? { plays: 0, users: new Set<string>() };
      cur.plays += 1;
      cur.users.add(s.user);
      map.set(s.title, cur);
    }
    return [...map.entries()]
      .map(([title, v]) => ({ title, plays: v.plays, users: v.users.size }))
      .sort((a, b) => b.plays - a.plays)
      .slice(0, 8);
  };

  const db = getDatabase();
  const knownUsers = db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM plex_users').get()?.n ?? 0;

  const nowIso = new Date(now).toISOString();
  const ago90 = new Date(now - 90 * dayMs).toISOString();
  const ago365 = new Date(now - 365 * dayMs).toISOString();
  const agg = db
    .prepare<[string, string, string, string, string], { items: number; bytes: number; never: number; never_bytes: number; never_old: number; never_old_bytes: number; played90: number; quiet: number; quiet_bytes: number }>(
      `SELECT
         COUNT(*) AS items,
         COALESCE(SUM(file_size), 0) AS bytes,
         SUM(CASE WHEN COALESCE(play_count, 0) = 0 AND last_watched_at IS NULL THEN 1 ELSE 0 END) AS never,
         COALESCE(SUM(CASE WHEN COALESCE(play_count, 0) = 0 AND last_watched_at IS NULL THEN file_size ELSE 0 END), 0) AS never_bytes,
         SUM(CASE WHEN COALESCE(play_count, 0) = 0 AND last_watched_at IS NULL AND added_at IS NOT NULL AND added_at < ? THEN 1 ELSE 0 END) AS never_old,
         COALESCE(SUM(CASE WHEN COALESCE(play_count, 0) = 0 AND last_watched_at IS NULL AND added_at IS NOT NULL AND added_at < ? THEN file_size ELSE 0 END), 0) AS never_old_bytes,
         SUM(CASE WHEN last_watched_at IS NOT NULL AND last_watched_at >= ? THEN 1 ELSE 0 END) AS played90,
         SUM(CASE WHEN last_watched_at IS NULL OR last_watched_at < ? THEN 1 ELSE 0 END) AS quiet,
         COALESCE(SUM(CASE WHEN last_watched_at IS NULL OR last_watched_at < ? THEN file_size ELSE 0 END), 0) AS quiet_bytes
       FROM media_items WHERE status != 'deleted' AND type IN ('movie', 'show')`
    )
    .get(ago90, ago90, ago90, ago365, ago365)!;

  const quietLargest = db
    .prepare<[string], QuietItem & { last_watched_at: string | null; added_at: string | null; file_size: number | null; play_count: number }>(
      `SELECT id, title, type, year, file_size, play_count, last_watched_at, added_at
       FROM media_items
       WHERE status != 'deleted' AND type IN ('movie', 'show') AND (last_watched_at IS NULL OR last_watched_at < ?)
       ORDER BY file_size DESC LIMIT 10`
    )
    .all(ago365)
    .map((r) => ({
      id: r.id,
      title: r.title,
      type: r.type,
      year: r.year,
      sizeBytes: r.file_size ?? 0,
      playCount: r.play_count ?? 0,
      lastWatchedAt: r.last_watched_at,
      addedAt: r.added_at,
    }));

  // Findings.
  const items: InsightItem[] = [];
  if (result.provider === 'none') {
    items.push({
      id: 'watch.noProvider',
      severity: 'warning',
      source: 'prunerr',
      title: 'No watch history provider is configured',
      detail: 'Plays and watched dates cannot be read, so every item looks unwatched. Pick a provider under Settings → Connections → Watch history.',
      href: '/settings?section=connections',
    });
  } else if (sessions.length === 0 && result.note?.startsWith('Could not read history')) {
    // The provider is configured but did not answer: a broken read, not an idle household.
    const name = result.provider === 'tautulli' ? 'Tautulli' : result.provider === 'tracearr' ? 'Tracearr' : 'the media server';
    items.push({
      id: 'watch.providerError',
      severity: 'warning',
      source: result.provider === 'tautulli' ? 'tautulli' : result.provider === 'tracearr' ? 'tracearr' : 'mediaServer',
      title: `Could not read play history from ${name}`,
      detail: `${result.note}. Plays per week, viewers and playback friction are empty until it answers; per-title play counts from the last sync are unaffected.`,
      href: '/settings?section=connections',
    });
  } else if (sessions.length === 0 && result.note) {
    items.push({ id: 'watch.noSessions', severity: 'info', source: 'prunerr', title: 'No play sessions in the last 90 days', detail: result.note, href: '/settings?section=connections' });
  } else if (last30.length === 0 && prev30.length > 0) {
    items.push({
      id: 'watch.wentQuiet',
      severity: 'info',
      source: 'prunerr',
      title: 'No plays in the last 30 days, after plays the month before',
      detail: 'Either the household stopped watching or the provider stopped reporting. Check the provider before trusting watch-based rules.',
      href: '/settings?section=connections',
    });
  }
  if (agg.items > 0 && agg.never_old / agg.items >= 0.25) {
    items.push({
      id: 'watch.neverPlayedOld',
      severity: 'info',
      source: 'prunerr',
      title: `${Math.round((agg.never_old / agg.items) * 100)}% of the library has never been played after 90+ days`,
      detail: `${agg.never_old.toLocaleString()} titles, ${(agg.never_old_bytes / 1024 ** 3).toFixed(0)} GB. A rule on "never watched, added more than 90 days ago" would reclaim it with a grace period to object.`,
      href: '/rules',
    });
  }
  if (viewers.length >= 2 && viewers[0]!.share >= 0.8) {
    items.push({
      id: 'watch.oneViewer',
      severity: 'info',
      source: 'prunerr',
      title: `${viewers[0]!.user} accounts for ${Math.round(viewers[0]!.share * 100)}% of all plays`,
      detail: `${knownUsers} users are synced but one of them does most of the watching. Rules that spare anything "watched by anyone" are effectively rules about one person.`,
    });
  }
  if (knownUsers > 0 && last30.length > 0) {
    const activeNow = new Set(last30.map((s) => s.user)).size;
    if (activeNow < knownUsers / 2 && knownUsers >= 4) {
      items.push({
        id: 'watch.inactiveUsers',
        severity: 'info',
        source: 'prunerr',
        title: `${knownUsers - activeNow} of ${knownUsers} users have not watched anything this month`,
        detail: 'Not a problem, just worth knowing when a rule protects content "requested by" or "watched by" them.',
      });
    }
  }

  return {
    checkedAt: nowIso,
    overall: worstSeverity(items),
    counts: countBySeverity(items),
    items,
    provider: result.provider,
    note: result.note,
    windowDays: WINDOW_DAYS,
    weekly: [...weeks.values()],
    last30: {
      plays: last30.length,
      users: new Set(last30.map((s) => s.user)).size,
      movies: last30.filter((s) => s.mediaType === 'movie').length,
      episodes: last30.filter((s) => s.mediaType === 'episode').length,
      hoursWatched: hours === null ? null : Math.round(hours),
    },
    previous30: { plays: prev30.length, users: new Set(prev30.map((s) => s.user)).size },
    knownUsers,
    viewers,
    topShows: top('episode'),
    topMovies: top('movie'),
    // SUM() over an empty library is NULL, not 0; a fresh install must not
    // turn that into a NOT NULL failure when the snapshot is stored.
    library: {
      items: agg.items ?? 0,
      bytes: agg.bytes ?? 0,
      neverPlayed: { count: agg.never ?? 0, bytes: agg.never_bytes ?? 0 },
      neverPlayedOld: { count: agg.never_old ?? 0, bytes: agg.never_old_bytes ?? 0 },
      playedLast90: { count: agg.played90 ?? 0 },
      quietOverYear: { count: agg.quiet ?? 0, bytes: agg.quiet_bytes ?? 0 },
    },
    quietLargest,
  };
}

export async function getWatchPatterns(options: { refresh?: boolean } = {}): Promise<WatchPatternsReport> {
  if (!options.refresh && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.report;
  const report = await build(options.refresh === true);
  cached = { at: Date.now(), report };
  return report;
}

export function invalidateWatchPatterns(): void {
  cached = null;
}
