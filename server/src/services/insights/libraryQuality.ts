/**
 * Library quality: what the library is made of, and where it is weakest.
 *
 * Resolution and codec per item are already synced from the media server;
 * Sonarr and Radarr know which files sit below their profile's cutoff. Put
 * together: the share of 4K / 1080p / 720p / SD by count and by bytes, the
 * codec mix (x264 vs HEVC vs AV1 tells you what will transcode), HDR, items
 * below cutoff, and the low-quality items nobody has watched, which are the
 * best deletion candidates in the whole library.
 */
import { getDatabase } from '../../db';
import logger from '../../utils/logger';
import { getRadarrService, getSonarrService } from '../init';
import { fetchCutoffUnmetCount } from '../arrDiagnostics';
import { countBySeverity, worstSeverity, type InsightCounts, type InsightItem, type InsightSeverity } from './types';

export type ResolutionBucket = '4K' | '1440p' | '1080p' | '720p' | 'SD' | 'Unknown';
const BUCKET_ORDER: ResolutionBucket[] = ['4K', '1440p', '1080p', '720p', 'SD', 'Unknown'];

export interface ShareBucket {
  label: string;
  count: number;
  bytes: number;
  /** Share of items, 0..1. */
  countShare: number;
  /** Share of bytes, 0..1. */
  bytesShare: number;
}

export interface LowQualityItem {
  id: number;
  title: string;
  type: 'movie' | 'show';
  year: number | null;
  resolution: ResolutionBucket;
  codec: string | null;
  sizeBytes: number;
  playCount: number;
  lastWatchedAt: string | null;
  addedAt: string | null;
}

export interface CutoffReport {
  service: 'sonarr' | 'radarr';
  label: 'Sonarr' | 'Radarr';
  /** Movies (Radarr) or episodes (Sonarr) below their profile cutoff; null when it could not be read. */
  belowCutoff: number | null;
  unit: 'movies' | 'episodes';
}

export interface LibraryQualityReport {
  checkedAt: string;
  overall: InsightSeverity;
  counts: InsightCounts;
  items: InsightItem[];
  totals: { items: number; movies: number; shows: number; bytes: number };
  byResolution: ShareBucket[];
  byCodec: ShareBucket[];
  hdr: { count: number; share: number; byFormat: Array<{ label: string; count: number }> };
  /** Average bitrate per resolution bucket, kbps, where known. */
  bitrateByResolution: Array<{ label: string; avgKbps: number; samples: number }>;
  cutoff: CutoffReport[];
  /** Low-resolution items never played, largest first. */
  lowQualityUnwatched: LowQualityItem[];
  /** Bytes held by SD and 720p items that nobody has played. */
  lowQualityUnwatchedBytes: number;
  lowQualityUnwatchedCount: number;
}

const CACHE_TTL_MS = 5 * 60_000;
let cached: { at: number; report: LibraryQualityReport } | null = null;

/** Plex writes `1080`, `4k`, `sd`; Jellyfin `4k`, `1080`, `576`; Sonarr-derived values are normalised to `2160`. */
export function bucketResolution(raw: string | null | undefined): ResolutionBucket {
  if (!raw) return 'Unknown';
  const value = raw.trim().toLowerCase();
  if (!value) return 'Unknown';
  if (value === '4k' || value === 'uhd' || value === '2160' || value === '2160p') return '4K';
  if (value === '1440' || value === '1440p') return '1440p';
  if (value === '1080' || value === '1080p') return '1080p';
  if (value === '720' || value === '720p') return '720p';
  if (value === 'sd' || value === '576' || value === '480' || value === '576p' || value === '480p') return 'SD';
  const dims = /^(\d{3,5})\s*[x×]\s*(\d{3,5})$/.exec(value);
  if (dims?.[1]) {
    const width = Number(dims[1]);
    if (width >= 3400) return '4K';
    if (width >= 2400) return '1440p';
    if (width >= 1700) return '1080p';
    if (width >= 1100) return '720p';
    return 'SD';
  }
  const n = Number(value);
  if (Number.isFinite(n)) {
    if (n >= 2000) return '4K';
    if (n >= 1400) return '1440p';
    if (n >= 1000) return '1080p';
    if (n >= 700) return '720p';
    if (n > 0) return 'SD';
  }
  return 'Unknown';
}

/** `hevc`/`h265` → `HEVC`, `h264`/`avc` → `H.264`, `av1` → `AV1`; the rest capitalised. */
export function labelCodec(raw: string | null | undefined): string {
  if (!raw) return 'Unknown';
  const value = raw.trim().toLowerCase();
  if (!value) return 'Unknown';
  if (value === 'hevc' || value === 'h265' || value === 'h.265' || value === 'x265') return 'HEVC';
  if (value === 'h264' || value === 'avc' || value === 'h.264' || value === 'x264' || value === 'avc1') return 'H.264';
  if (value === 'av1') return 'AV1';
  if (value === 'vc1' || value === 'vc-1') return 'VC-1';
  if (value === 'mpeg4' || value === 'xvid' || value === 'divx') return 'MPEG-4';
  if (value === 'mpeg2video' || value === 'mpeg2') return 'MPEG-2';
  if (value === 'vp9') return 'VP9';
  return value.toUpperCase();
}

function labelHdr(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim().toLowerCase();
  if (!value || value === 'none' || value === 'sdr') return null;
  if (value === 'dv' || value === 'dolby vision') return 'Dolby Vision';
  if (value === 'hdr10+') return 'HDR10+';
  if (value === 'hdr10') return 'HDR10';
  if (value === 'hlg') return 'HLG';
  if (value === 'hdr') return 'HDR';
  return raw;
}

interface Row {
  id: number;
  title: string;
  type: 'movie' | 'show';
  year: number | null;
  resolution: string | null;
  video_codec: string | null;
  codec: string | null;
  hdr: string | null;
  bitrate: number | null;
  file_size: number | null;
  play_count: number;
  last_watched_at: string | null;
  added_at: string | null;
}

function shares(map: Map<string, { count: number; bytes: number }>, totalCount: number, totalBytes: number, order?: string[]): ShareBucket[] {
  const entries = [...map.entries()].map(([label, v]) => ({
    label,
    count: v.count,
    bytes: v.bytes,
    countShare: totalCount ? v.count / totalCount : 0,
    bytesShare: totalBytes ? v.bytes / totalBytes : 0,
  }));
  if (order) {
    entries.sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label));
  } else {
    entries.sort((a, b) => b.count - a.count);
  }
  return entries;
}

async function cutoffFor(service: 'sonarr' | 'radarr'): Promise<CutoffReport | null> {
  const instance = service === 'sonarr' ? getSonarrService() : getRadarrService();
  if (!instance) return null;
  const label = service === 'sonarr' ? 'Sonarr' : 'Radarr';
  const unit = service === 'sonarr' ? 'episodes' : 'movies';
  try {
    return { service, label, belowCutoff: await fetchCutoffUnmetCount(instance.httpClient), unit };
  } catch (error) {
    logger.debug(`Insights: ${label} cutoff count failed: ${error instanceof Error ? error.message : String(error)}`);
    return { service, label, belowCutoff: null, unit };
  }
}

async function build(): Promise<LibraryQualityReport> {
  const db = getDatabase();
  const rows = db
    .prepare<[], Row>(
      `SELECT id, title, type, year, resolution, video_codec, codec, hdr, bitrate, file_size, play_count, last_watched_at, added_at
       FROM media_items
       WHERE status != 'deleted' AND type IN ('movie', 'show')`
    )
    .all();

  const totals = { items: rows.length, movies: 0, shows: 0, bytes: 0 };
  const byRes = new Map<string, { count: number; bytes: number }>();
  const byCodec = new Map<string, { count: number; bytes: number }>();
  const hdrByFormat = new Map<string, number>();
  const bitrateAcc = new Map<string, { sum: number; n: number }>();
  const lowUnwatched: LowQualityItem[] = [];
  let lowBytes = 0;
  let hdrCount = 0;

  const bump = (map: Map<string, { count: number; bytes: number }>, key: string, bytes: number) => {
    const cur = map.get(key) ?? { count: 0, bytes: 0 };
    cur.count += 1;
    cur.bytes += bytes;
    map.set(key, cur);
  };

  for (const row of rows) {
    const bytes = row.file_size ?? 0;
    totals.bytes += bytes;
    if (row.type === 'movie') totals.movies += 1;
    else totals.shows += 1;

    const res = bucketResolution(row.resolution);
    bump(byRes, res, bytes);
    const codec = labelCodec(row.video_codec ?? row.codec);
    bump(byCodec, codec, bytes);

    const hdr = labelHdr(row.hdr);
    if (hdr) {
      hdrCount += 1;
      hdrByFormat.set(hdr, (hdrByFormat.get(hdr) ?? 0) + 1);
    }

    if (row.bitrate && row.bitrate > 0 && res !== 'Unknown') {
      const acc = bitrateAcc.get(res) ?? { sum: 0, n: 0 };
      // Plex stores kbps for most items; a value in bps is normalised down.
      const kbps = row.bitrate > 200_000 ? row.bitrate / 1000 : row.bitrate;
      acc.sum += kbps;
      acc.n += 1;
      bitrateAcc.set(res, acc);
    }

    if ((res === 'SD' || res === '720p') && (row.play_count ?? 0) === 0 && !row.last_watched_at) {
      lowBytes += bytes;
      lowUnwatched.push({
        id: row.id,
        title: row.title,
        type: row.type,
        year: row.year,
        resolution: res,
        codec: row.video_codec ?? row.codec,
        sizeBytes: bytes,
        playCount: row.play_count ?? 0,
        lastWatchedAt: row.last_watched_at,
        addedAt: row.added_at,
      });
    }
  }
  lowUnwatched.sort((a, b) => b.sizeBytes - a.sizeBytes);

  const [sonarr, radarr] = await Promise.all([cutoffFor('sonarr'), cutoffFor('radarr')]);
  const cutoff = [sonarr, radarr].filter((c): c is CutoffReport => c !== null);

  // Findings, so the block has a verdict and not only charts.
  const items: InsightItem[] = [];
  const sd = byRes.get('SD');
  if (sd && totals.items > 0 && sd.count / totals.items >= 0.1) {
    items.push({
      id: 'library.sdShare',
      severity: 'info',
      source: 'prunerr',
      title: `${Math.round((sd.count / totals.items) * 100)}% of the library is standard definition`,
      detail: `${sd.count} items. Worth a rule that flags SD items with no plays, or an upgrade pass in Sonarr/Radarr.`,
      href: '/rules',
    });
  }
  if (lowUnwatched.length > 0) {
    items.push({
      id: 'library.lowUnwatched',
      severity: lowBytes > 100 * 1024 ** 3 ? 'warning' : 'info',
      source: 'prunerr',
      title: `${lowUnwatched.length} low-resolution item${lowUnwatched.length === 1 ? '' : 's'} nobody has played`,
      detail: `SD and 720p items with no recorded plays, ${(lowBytes / 1024 ** 3).toFixed(1)} GB in total. The clearest deletion candidates in the library.`,
      href: '/library',
    });
  }
  for (const c of cutoff) {
    if (c.belowCutoff && c.belowCutoff > 0) {
      items.push({
        id: `library.cutoff.${c.service}`,
        severity: 'info',
        source: c.service,
        title: `${c.belowCutoff.toLocaleString()} ${c.unit} below their quality cutoff in ${c.label}`,
        detail: `${c.label} wants a better file for these but has not found one. Check the profile cutoffs and indexers if the number never moves.`,
      });
    }
  }
  const unknown = byRes.get('Unknown');
  if (unknown && totals.items > 0 && unknown.count / totals.items >= 0.2) {
    items.push({
      id: 'library.unknownResolution',
      severity: 'info',
      source: 'prunerr',
      title: `${unknown.count} items have no resolution recorded`,
      detail: 'The media server has not analysed their files yet, or the sync predates the field. A library sync after a Plex "Analyze" fills it in.',
      href: '/library',
    });
  }

  return {
    checkedAt: new Date().toISOString(),
    overall: worstSeverity(items),
    counts: countBySeverity(items),
    items,
    totals,
    byResolution: shares(byRes, totals.items, totals.bytes, BUCKET_ORDER),
    byCodec: shares(byCodec, totals.items, totals.bytes),
    hdr: {
      count: hdrCount,
      share: totals.items ? hdrCount / totals.items : 0,
      byFormat: [...hdrByFormat.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count),
    },
    bitrateByResolution: BUCKET_ORDER.filter((b) => bitrateAcc.has(b)).map((b) => {
      const acc = bitrateAcc.get(b)!;
      return { label: b, avgKbps: Math.round(acc.sum / acc.n), samples: acc.n };
    }),
    cutoff,
    lowQualityUnwatched: lowUnwatched.slice(0, 15),
    lowQualityUnwatchedBytes: lowBytes,
    lowQualityUnwatchedCount: lowUnwatched.length,
  };
}

export async function getLibraryQuality(options: { refresh?: boolean } = {}): Promise<LibraryQualityReport> {
  if (!options.refresh && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.report;
  const report = await build();
  cached = { at: Date.now(), report };
  return report;
}

export function invalidateLibraryQuality(): void {
  cached = null;
}
