import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Film, Gauge, RefreshCw } from 'lucide-react';

import { Card } from '@/components/common/Card';
import { ErrorState } from '@/components/common/ErrorState';
import { useLibraryQuality, useMediaServerName } from '@/hooks/useApi';
import { cn, formatBytes, formatRelativeTime } from '@/lib/utils';
import type { ShareBucket } from '@/types';

import { InsightRow, SeverityBadge } from './InsightItems';
import { ShareBars, type ShareRow } from './ShareBars';

const RESOLUTION_TONE: Record<string, ShareRow['tone']> = { '4K': 'violet', '1440p': 'violet', '1080p': 'accent', '720p': 'emerald', SD: 'ruby', Unknown: 'muted' };

function toRows(buckets: ShareBucket[], by: 'count' | 'bytes', toneFor?: (label: string) => ShareRow['tone']): ShareRow[] {
  return buckets
    .filter((b) => b.count > 0)
    .map((b) => ({
      label: b.label,
      share: by === 'count' ? b.countShare : b.bytesShare,
      caption: by === 'count' ? b.count.toLocaleString() : formatBytes(b.bytes, 1),
      tone: toneFor ? toneFor(b.label) : 'accent',
    }));
}

/**
 * Library quality: the resolution and codec mix by count and by bytes, HDR,
 * what sits below its cutoff in Sonarr/Radarr, and the low-resolution items
 * nobody has played, which are the clearest deletion candidates.
 */
export function LibraryQualityBlock() {
  const { t } = useTranslation('insights');
  const mediaServer = useMediaServerName();
  const query = useLibraryQuality();
  const report = query.data;

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="rounded-lg border border-violet-500/25 bg-violet-500/[0.08] p-1.5">
            <Gauge className="h-4 w-4 text-violet-text" aria-hidden />
          </div>
          <div>
            <h2 className="font-display text-[15px] font-semibold text-surface-50">{t('library.title', 'Library quality')}</h2>
            <p className="text-[12px] text-surface-400">
              {t('library.subtitle', 'What the library is made of, from the last {{mediaServer}} sync and Sonarr/Radarr.', { mediaServer })}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {report && (
            <span className="text-[11px] text-surface-500" title={new Date(report.checkedAt).toLocaleString()}>
              {t('stack.checked', 'Checked {{when}}', { when: formatRelativeTime(report.checkedAt) })}
            </span>
          )}
          <button
            type="button"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
            className="inline-flex min-h-[36px] items-center gap-1.5 rounded-[10px] border border-surface-600/80 px-2.5 text-[11.5px] font-semibold text-surface-200 transition-colors hover:bg-surface-700/60 hover:text-surface-50 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', query.isFetching && 'animate-spin motion-reduce:animate-none')} aria-hidden />
            {t('refresh', 'Refresh')}
          </button>
        </div>
      </div>

      {query.isLoading ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="skeleton-shimmer h-28 rounded-xl" />
          ))}
        </div>
      ) : query.isError || !report ? (
        <div className="mt-4">
          <ErrorState error={query.error instanceof Error ? query.error : new Error(String(query.error))} title={t('library.loadFailed', 'Could not read the library')} retry={() => void query.refetch()} />
        </div>
      ) : report.totals.items === 0 ? (
        <p className="mt-4 text-[13px] text-surface-400">
          {t('library.empty', 'Nothing synced yet. Run a library sync and come back.')}{' '}
          <Link to="/library" className="text-accent-text hover:underline">
            {t('library.goToLibrary', 'Open the library')}
          </Link>
        </p>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {report.items.length === 0 && <SeverityBadge severity="ok" />}
            {report.counts.warning > 0 && <SeverityBadge severity="warning" count={report.counts.warning} />}
            {report.counts.info > 0 && <SeverityBadge severity="info" count={report.counts.info} />}
            <span className="text-[12px] text-surface-400">
              {t('library.totals', '{{items}} titles · {{movies}} movies · {{shows}} shows · {{size}}', {
                items: report.totals.items.toLocaleString(),
                movies: report.totals.movies.toLocaleString(),
                shows: report.totals.shows.toLocaleString(),
                size: formatBytes(report.totals.bytes, 1),
              })}
            </span>
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div className="rounded-xl border border-surface-700/60 bg-surface-800/30 p-3.5">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-surface-500">{t('library.byResolutionCount', 'Resolution, by titles')}</p>
              <ShareBars rows={toRows(report.byResolution, 'count', (l) => RESOLUTION_TONE[l] ?? 'accent')} ariaLabel={t('library.byResolutionCount', 'Resolution, by titles')} />
            </div>
            <div className="rounded-xl border border-surface-700/60 bg-surface-800/30 p-3.5">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-surface-500">{t('library.byResolutionBytes', 'Resolution, by disk space')}</p>
              <ShareBars rows={toRows(report.byResolution, 'bytes', (l) => RESOLUTION_TONE[l] ?? 'accent')} ariaLabel={t('library.byResolutionBytes', 'Resolution, by disk space')} />
            </div>
            <div className="rounded-xl border border-surface-700/60 bg-surface-800/30 p-3.5">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-surface-500">{t('library.byCodec', 'Video codec')}</p>
              <ShareBars rows={toRows(report.byCodec.slice(0, 6), 'count')} ariaLabel={t('library.byCodec', 'Video codec')} />
              <p className="mt-2 text-[11px] text-surface-500">
                {t('library.codecHint', 'HEVC and AV1 files are smaller but transcode for older clients; H.264 plays almost everywhere.')}
              </p>
            </div>
            <div className="rounded-xl border border-surface-700/60 bg-surface-800/30 p-3.5">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-surface-500">{t('library.hdrAndCutoff', 'HDR and upgrades')}</p>
              <dl className="space-y-1.5 text-[12.5px]">
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-surface-300">{t('library.hdr', 'HDR titles')}</dt>
                  <dd className="font-mono text-surface-50">
                    {report.hdr.count.toLocaleString()}
                    <span className="text-surface-500"> · {Math.round(report.hdr.share * 100)}%</span>
                    {report.hdr.byFormat.length > 0 && (
                      <span className="text-surface-500"> · {report.hdr.byFormat.map((f) => `${f.label} ${f.count}`).join(', ')}</span>
                    )}
                  </dd>
                </div>
                {report.cutoff.map((c) => (
                  <div key={c.service} className="flex items-baseline justify-between gap-3">
                    <dt className="text-surface-300">{t('library.belowCutoff', 'Below cutoff in {{label}}', { label: c.label })}</dt>
                    <dd className="font-mono text-surface-50">
                      {c.belowCutoff === null ? t('library.unknown', 'unknown') : `${c.belowCutoff.toLocaleString()} ${c.unit === 'movies' ? t('library.movies', 'movies') : t('library.episodes', 'episodes')}`}
                    </dd>
                  </div>
                ))}
                {report.bitrateByResolution.map((b) => (
                  <div key={b.label} className="flex items-baseline justify-between gap-3">
                    <dt className="text-surface-300">{t('library.avgBitrate', 'Average bitrate, {{label}}', { label: b.label })}</dt>
                    <dd className="font-mono text-surface-50">{(b.avgKbps / 1000).toFixed(1)} Mbps</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>

          {report.items.length > 0 && (
            <ul className="mt-4 space-y-2">
              {report.items.map((item) => (
                <li key={item.id}>
                  <InsightRow item={item} mediaServer={mediaServer} />
                </li>
              ))}
            </ul>
          )}

          {report.lowQualityUnwatched.length > 0 && (
            <div className="mt-4">
              <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-surface-500">
                <Film className="h-3.5 w-3.5" aria-hidden />
                {t('library.lowUnwatchedTitle', 'Low-resolution, never played · {{titles}} titles · {{size}}', {
                  titles: report.lowQualityUnwatchedCount.toLocaleString(),
                  size: formatBytes(report.lowQualityUnwatchedBytes, 1),
                })}
              </p>
              <ul className="divide-y divide-surface-700/50 rounded-lg border border-surface-700/50 bg-surface-900/40">
                {report.lowQualityUnwatched.map((item) => (
                  <li key={item.id}>
                    <Link to={`/library/${item.id}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2 text-[12.5px] hover:bg-surface-800/60">
                      <span className="min-w-0 flex-1 truncate text-surface-100">
                        {item.title}
                        {item.year && <span className="text-surface-500"> ({item.year})</span>}
                      </span>
                      <span className="rounded bg-surface-700/50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-surface-400">
                        {item.type === 'movie' ? t('library.movie', 'Movie') : t('library.show', 'Show')}
                      </span>
                      <span className="font-mono text-[11px] text-ruby-text">{item.resolution}</span>
                      {item.codec && <span className="font-mono text-[11px] text-surface-500">{item.codec}</span>}
                      <span className="font-mono text-[11px] text-surface-300">{formatBytes(item.sizeBytes, 1)}</span>
                      {item.addedAt && <span className="text-[11px] text-surface-500">{t('library.added', 'added {{when}}', { when: formatRelativeTime(item.addedAt) })}</span>}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
