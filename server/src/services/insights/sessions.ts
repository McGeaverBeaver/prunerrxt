/**
 * Recent play sessions in one shape, whichever provider records them.
 *
 * Tautulli keeps the richest record (transcode decision, player, platform,
 * how far the viewer got) and is read live. Tracearr and the media server's
 * own history are already mirrored into `watch_history_cache` by the sync,
 * so they are read from there, without the playback detail Tautulli has.
 * The watch-patterns block works from any of them; playback friction needs
 * Tautulli's fields and says so when they are missing.
 */
import settingsRepo from '../../db/repositories/settings';
import { getDatabase } from '../../db';
import logger from '../../utils/logger';
import { getTautulliService } from '../init';

export type SessionProvider = 'tautulli' | 'tracearr' | 'mediaServer' | 'none';

export interface PlaySession {
  stoppedAt: Date;
  user: string;
  mediaType: 'movie' | 'episode' | 'other';
  ratingKey: string | null;
  /** The film, or the episode's show. */
  title: string;
  /** Show title for an episode, null for a film. */
  showTitle: string | null;
  /** Counted as watched by the provider. */
  watched: boolean;
  /** 0..100 when the provider reports it. */
  percentComplete: number | null;
  /** Seconds actually played, when known. */
  durationSec: number | null;
  /** Tautulli only: `direct play`, `copy` or `transcode`. */
  transcodeDecision: string | null;
  platform: string | null;
  player: string | null;
  product: string | null;
  pausedSec: number | null;
}

export interface SessionsResult {
  provider: SessionProvider;
  /** How many days back the sessions reach. */
  days: number;
  sessions: PlaySession[];
  /** True when the provider records transcode decisions and players (Tautulli). */
  hasPlaybackDetail: boolean;
  /** Why there are no sessions, when there are none. */
  note: string | null;
}

const CACHE_TTL_MS = 5 * 60_000;
const cache = new Map<number, { at: number; result: SessionsResult }>();

export function activeSessionProvider(): SessionProvider {
  const provider = settingsRepo.getValue('watch_history_provider');
  const configured = (name: string, key = 'apiKey') => Boolean(settingsRepo.getValue(`${name}_url`) && settingsRepo.getValue(`${name}_${key}`));
  if (provider === 'tautulli') return configured('tautulli') ? 'tautulli' : 'none';
  if (provider === 'tracearr') return configured('tracearr') ? 'tracearr' : 'none';
  if (provider === 'plex' || provider === 'mediaServer') return 'mediaServer';
  // Legacy installs never stored the choice: Tracearr if set up, else Tautulli if set up, else the server itself.
  if (configured('tracearr')) return 'tracearr';
  if (configured('tautulli')) return 'tautulli';
  return 'mediaServer';
}

async function fromTautulli(days: number): Promise<PlaySession[]> {
  const tautulli = getTautulliService();
  if (!tautulli) return [];
  const history = await tautulli.getRecentlyWatched(days);
  return history
    .filter((h) => !h.live && h.stopped)
    .map((h) => ({
      stoppedAt: new Date(h.stopped * 1000),
      user: h.friendlyName || h.user || 'unknown',
      mediaType: h.mediaType === 'movie' ? 'movie' : h.mediaType === 'episode' ? 'episode' : 'other',
      ratingKey: h.ratingKey || null,
      title: h.mediaType === 'episode' ? h.grandparentTitle || h.fullTitle : h.title || h.fullTitle,
      showTitle: h.mediaType === 'episode' ? h.grandparentTitle || null : null,
      watched: h.watchedStatus >= 1 || h.percentComplete >= 85,
      percentComplete: Number.isFinite(h.percentComplete) ? h.percentComplete : null,
      durationSec: Number.isFinite(h.duration) ? h.duration : null,
      transcodeDecision: h.transcodeDecision || null,
      platform: h.platform || null,
      player: h.player || null,
      product: h.product || null,
      pausedSec: Number.isFinite(h.pausedCounter) ? h.pausedCounter : null,
    }));
}

function fromCache(days: number): PlaySession[] {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const rows = getDatabase()
    .prepare<[string], { plex_rating_key: string; username: string; watched: number; stopped_at: string; media_title: string | null; media_type: string | null; show_title: string | null }>(
      `SELECT plex_rating_key, username, watched, stopped_at, media_title, media_type, show_title
       FROM watch_history_cache WHERE stopped_at >= ? ORDER BY stopped_at DESC LIMIT 20000`
    )
    .all(since);
  return rows.map((r) => ({
    stoppedAt: new Date(r.stopped_at),
    user: r.username || 'unknown',
    mediaType: r.media_type === 'movie' ? 'movie' : r.media_type === 'episode' ? 'episode' : 'other',
    ratingKey: r.plex_rating_key || null,
    title: r.show_title || r.media_title || 'Unknown',
    showTitle: r.show_title,
    watched: r.watched === 1,
    percentComplete: null,
    durationSec: null,
    transcodeDecision: null,
    platform: null,
    player: null,
    product: null,
    pausedSec: null,
  }));
}

export async function getRecentSessions(days = 90, refresh = false): Promise<SessionsResult> {
  const hit = cache.get(days);
  if (!refresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.result;

  const provider = activeSessionProvider();
  let sessions: PlaySession[] = [];
  let note: string | null = null;
  try {
    if (provider === 'tautulli') {
      sessions = await fromTautulli(days);
    } else if (provider === 'tracearr' || provider === 'mediaServer') {
      sessions = fromCache(days);
      if (sessions.length === 0) note = 'No sessions cached yet. History fills in during the next library sync.';
    } else {
      note = 'No watch history provider is configured.';
    }
  } catch (error) {
    note = `Could not read history: ${error instanceof Error ? error.message : String(error)}`;
    logger.debug(`Insights: sessions unavailable: ${note}`);
  }
  sessions.sort((a, b) => b.stoppedAt.getTime() - a.stoppedAt.getTime());

  const result: SessionsResult = { provider, days, sessions, hasPlaybackDetail: provider === 'tautulli', note };
  cache.set(days, { at: Date.now(), result });
  return result;
}

export function invalidateSessions(): void {
  cache.clear();
}
