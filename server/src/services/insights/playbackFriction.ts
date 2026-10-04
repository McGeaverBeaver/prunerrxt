/**
 * Playback friction: where playback struggles, inferred from what the
 * history provider records.
 *
 * Only Tautulli keeps the fields this needs: the transcode decision, the
 * player and platform, how far the viewer got. From those, three things are
 * real and actionable: which clients force transcodes (and what codec they
 * choke on), which titles always transcode, and which plays were abandoned
 * early (started, dropped under a fifth of the way in, often restarted).
 * Buffering counts and client errors are not persisted anywhere, so this is
 * inference about friction, not a measurement of failures, and the block
 * says so. Without Tautulli the block explains what it would need.
 */
import { getDatabase } from '../../db';
import { getRecentSessions, type PlaySession, type SessionProvider } from './sessions';
import { labelCodec } from './libraryQuality';
import { countBySeverity, worstSeverity, type InsightCounts, type InsightItem, type InsightSeverity } from './types';

export interface DecisionShare {
  directPlay: number;
  directStream: number;
  transcode: number;
  total: number;
}

export interface ClientFriction {
  /** `Platform · Player`, e.g. `Roku · Living room TV`. */
  client: string;
  platform: string;
  plays: number;
  transcodes: number;
  /** 0..1 */
  transcodeRate: number;
  /** Codecs of the titles that transcoded on this client, most common first. */
  codecs: string[];
}

export interface TitleFriction {
  title: string;
  mediaType: 'movie' | 'episode' | 'other';
  plays: number;
  transcodes: number;
  transcodeRate: number;
  codec: string | null;
  resolution: string | null;
  mediaItemId: number | null;
}

export interface AbandonedPlay {
  title: string;
  user: string;
  client: string;
  stoppedAt: string;
  percentComplete: number;
  transcode: boolean;
}

export interface PlaybackFrictionReport {
  checkedAt: string;
  overall: InsightSeverity;
  counts: InsightCounts;
  items: InsightItem[];
  provider: SessionProvider;
  /** False when the provider cannot supply playback detail; the rest is then empty. */
  available: boolean;
  note: string | null;
  windowDays: number;
  decisions: DecisionShare;
  /** Clients with the highest transcode rate, at least 3 plays. */
  clients: ClientFriction[];
  /** Titles that transcode most, at least 2 plays. */
  titles: TitleFriction[];
  abandoned: { count: number; rate: number; recent: AbandonedPlay[] };
  /** Plays stopped under 20 % that the same user restarted within a day: "tried again". */
  retried: number;
}

const CACHE_TTL_MS = 5 * 60_000;
const WINDOW_DAYS = 30;
const ABANDON_BELOW_PERCENT = 20;
let cached: { at: number; report: PlaybackFrictionReport } | null = null;

function decisionOf(s: PlaySession): 'directPlay' | 'directStream' | 'transcode' | null {
  const d = (s.transcodeDecision ?? '').toLowerCase();
  if (d === 'direct play') return 'directPlay';
  if (d === 'copy' || d === 'direct stream') return 'directStream';
  if (d === 'transcode') return 'transcode';
  return null;
}

function clientOf(s: PlaySession): string {
  const platform = s.platform || s.product || 'Unknown';
  const player = s.player || s.product || '';
  return player && player !== platform ? `${platform} · ${player}` : platform;
}

async function build(refresh: boolean): Promise<PlaybackFrictionReport> {
  const result = await getRecentSessions(WINDOW_DAYS, refresh);
  const checkedAt = new Date().toISOString();
  const empty: DecisionShare = { directPlay: 0, directStream: 0, transcode: 0, total: 0 };

  if (!result.hasPlaybackDetail) {
    const note =
      result.provider === 'none'
        ? 'No watch history provider is configured.'
        : result.provider === 'tracearr'
          ? 'Tracearr does not expose transcode decisions or players to Prunerr, so playback friction cannot be read. Tautulli records both.'
          : 'Reading history straight from the media server gives plays but not transcode decisions or players. Tautulli records both; point the watch history provider at it to fill this in.';
    return {
      checkedAt,
      overall: 'ok',
      counts: { critical: 0, warning: 0, info: 0, ok: 0 },
      items: [],
      provider: result.provider,
      available: false,
      note,
      windowDays: WINDOW_DAYS,
      decisions: empty,
      clients: [],
      titles: [],
      abandoned: { count: 0, rate: 0, recent: [] },
      retried: 0,
    };
  }

  const sessions = result.sessions.filter((s) => s.mediaType !== 'other');
  const decisions: DecisionShare = { ...empty };
  for (const s of sessions) {
    const d = decisionOf(s);
    if (!d) continue;
    decisions[d] += 1;
    decisions.total += 1;
  }

  // Codec and resolution per title, from the synced items, keyed by rating key.
  const db = getDatabase();
  const keys = [...new Set(sessions.map((s) => s.ratingKey).filter((k): k is string => Boolean(k)))];
  const mediaByKey = new Map<string, { id: number; codec: string | null; resolution: string | null; title: string }>();
  for (let i = 0; i < keys.length; i += 500) {
    const chunk = keys.slice(i, i + 500);
    const rows = db
      .prepare<string[], { id: number; plex_id: string; video_codec: string | null; codec: string | null; resolution: string | null; title: string }>(
        `SELECT id, plex_id, video_codec, codec, resolution, title FROM media_items WHERE plex_id IN (${chunk.map(() => '?').join(',')})`
      )
      .all(...chunk);
    for (const r of rows) mediaByKey.set(r.plex_id, { id: r.id, codec: r.video_codec ?? r.codec, resolution: r.resolution, title: r.title });
  }
  // Episodes carry their own rating key; the show is what the library knows. Fall back by title.
  const mediaByTitle = new Map<string, { id: number; codec: string | null; resolution: string | null }>();
  for (const s of sessions) {
    if (mediaByTitle.has(s.title)) continue;
    const row = db
      .prepare<[string], { id: number; video_codec: string | null; codec: string | null; resolution: string | null }>(
        `SELECT id, video_codec, codec, resolution FROM media_items WHERE title = ? AND status != 'deleted' LIMIT 1`
      )
      .get(s.title);
    if (row) mediaByTitle.set(s.title, { id: row.id, codec: row.video_codec ?? row.codec, resolution: row.resolution });
  }
  const mediaFor = (s: PlaySession) => (s.ratingKey && mediaByKey.get(s.ratingKey)) || mediaByTitle.get(s.title) || null;

  // Clients.
  const byClient = new Map<string, { platform: string; plays: number; transcodes: number; codecs: Map<string, number> }>();
  for (const s of sessions) {
    const d = decisionOf(s);
    if (!d) continue;
    const key = clientOf(s);
    const cur = byClient.get(key) ?? { platform: s.platform || s.product || 'Unknown', plays: 0, transcodes: 0, codecs: new Map() };
    cur.plays += 1;
    if (d === 'transcode') {
      cur.transcodes += 1;
      const codec = labelCodec(mediaFor(s)?.codec);
      if (codec !== 'Unknown') cur.codecs.set(codec, (cur.codecs.get(codec) ?? 0) + 1);
    }
    byClient.set(key, cur);
  }
  const clients: ClientFriction[] = [...byClient.entries()]
    .filter(([, v]) => v.plays >= 3)
    .map(([client, v]) => ({
      client,
      platform: v.platform,
      plays: v.plays,
      transcodes: v.transcodes,
      transcodeRate: v.transcodes / v.plays,
      codecs: [...v.codecs.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c).slice(0, 3),
    }))
    .sort((a, b) => b.transcodeRate - a.transcodeRate || b.plays - a.plays)
    .slice(0, 10);

  // Titles.
  const byTitle = new Map<string, { mediaType: PlaySession['mediaType']; plays: number; transcodes: number }>();
  for (const s of sessions) {
    const d = decisionOf(s);
    if (!d) continue;
    const cur = byTitle.get(s.title) ?? { mediaType: s.mediaType, plays: 0, transcodes: 0 };
    cur.plays += 1;
    if (d === 'transcode') cur.transcodes += 1;
    byTitle.set(s.title, cur);
  }
  const titles: TitleFriction[] = [...byTitle.entries()]
    .filter(([, v]) => v.plays >= 2 && v.transcodes > 0)
    .map(([title, v]) => {
      const media = mediaByTitle.get(title) ?? null;
      return {
        title,
        mediaType: v.mediaType,
        plays: v.plays,
        transcodes: v.transcodes,
        transcodeRate: v.transcodes / v.plays,
        codec: media ? labelCodec(media.codec) : null,
        resolution: media?.resolution ?? null,
        mediaItemId: media?.id ?? null,
      };
    })
    .sort((a, b) => b.transcodes - a.transcodes || b.transcodeRate - a.transcodeRate)
    .slice(0, 10);

  // Abandoned and retried.
  const withProgress = sessions.filter((s) => s.percentComplete !== null);
  const abandonedSessions = withProgress.filter((s) => (s.percentComplete ?? 100) < ABANDON_BELOW_PERCENT && (s.durationSec ?? 0) >= 60);
  let retried = 0;
  for (const a of abandonedSessions) {
    const again = sessions.some(
      (s) => s !== a && s.user === a.user && s.title === a.title && s.stoppedAt > a.stoppedAt && s.stoppedAt.getTime() - a.stoppedAt.getTime() < 24 * 60 * 60 * 1000
    );
    if (again) retried += 1;
  }
  const abandoned = {
    count: abandonedSessions.length,
    rate: withProgress.length ? abandonedSessions.length / withProgress.length : 0,
    recent: abandonedSessions.slice(0, 10).map((s) => ({
      title: s.title,
      user: s.user,
      client: clientOf(s),
      stoppedAt: s.stoppedAt.toISOString(),
      percentComplete: Math.round(s.percentComplete ?? 0),
      transcode: decisionOf(s) === 'transcode',
    })),
  };

  // Findings.
  const items: InsightItem[] = [];
  if (decisions.total >= 10 && decisions.transcode / decisions.total >= 0.4) {
    const worst = clients[0];
    items.push({
      id: 'playback.transcodeRate',
      severity: 'warning',
      source: 'tautulli',
      title: `${Math.round((decisions.transcode / decisions.total) * 100)}% of plays transcoded in the last ${WINDOW_DAYS} days`,
      detail: `${decisions.transcode} of ${decisions.total} plays. ${worst ? `${worst.client} transcodes ${Math.round(worst.transcodeRate * 100)}% of what it plays${worst.codecs.length ? `, mostly ${worst.codecs.join(' and ')} files` : ''}.` : ''} Each transcode costs CPU and quality; a client that supports the codec, or a profile that avoids it, fixes most of them.`,
    });
  }
  for (const c of clients.slice(0, 3)) {
    if (c.transcodeRate >= 0.8 && c.plays >= 5 && decisions.total >= 10 && decisions.transcode / decisions.total < 0.4) {
      items.push({
        id: `playback.client.${c.client}`,
        severity: 'info',
        source: 'tautulli',
        title: `${c.client} transcodes nearly everything it plays`,
        detail: `${c.transcodes} of ${c.plays} plays${c.codecs.length ? `, mostly ${c.codecs.join(' and ')}` : ''}. That device probably cannot decode the codec; the fix is on the client or in the quality profile, not in the library.`,
      });
    }
  }
  if (withProgress.length >= 20 && abandoned.rate >= 0.25) {
    items.push({
      id: 'playback.abandoned',
      severity: 'info',
      source: 'tautulli',
      title: `${Math.round(abandoned.rate * 100)}% of plays were dropped in the first fifth`,
      detail: `${abandoned.count} of ${withProgress.length} plays stopped under ${ABANDON_BELOW_PERCENT}% in; ${retried} were tried again within a day, which is the shape of a playback problem rather than a change of mind.`,
    });
  }

  return {
    checkedAt,
    overall: worstSeverity(items),
    counts: countBySeverity(items),
    items,
    provider: result.provider,
    available: true,
    note: sessions.length === 0 ? result.note ?? `No plays recorded in the last ${WINDOW_DAYS} days.` : null,
    windowDays: WINDOW_DAYS,
    decisions,
    clients,
    titles,
    abandoned,
    retried,
  };
}

export async function getPlaybackFriction(options: { refresh?: boolean } = {}): Promise<PlaybackFrictionReport> {
  if (!options.refresh && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.report;
  const report = await build(options.refresh === true);
  cached = { at: Date.now(), report };
  return report;
}

export function invalidatePlaybackFriction(): void {
  cached = null;
}
