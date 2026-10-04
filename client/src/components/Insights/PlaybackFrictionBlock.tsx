import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { MonitorPlay, RefreshCw } from 'lucide-react';

import { Card } from '@/components/common/Card';
import { ErrorState } from '@/components/common/ErrorState';
import { useMediaServerName, usePlaybackFriction } from '@/hooks/useApi';
import { CONNECTIONS_SETTINGS_PATH } from '@/lib/links';
import { cn, formatRelativeTime } from '@/lib/utils';

import { InsightRow, SeverityBadge } from './InsightItems';
import { ShareBars } from './ShareBars';

/**
 * Playback friction: transcode share, the clients and titles that force
 * transcodes, and plays dropped early. Inference from Tautulli's session
 * records, not a measurement of failures, and the block says so. Without
 * Tautulli it explains what it would need instead of showing zeros.
 */
export function PlaybackFrictionBlock() {
  const { t } = useTranslation('insights');
  const mediaServer = useMediaServerName();
  const query = usePlaybackFriction();
  const report = query.data;

  const pct = (n: number, total: number) => (total ? Math.round((n / total) * 100) : 0);

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="rounded-lg border border-amber-500/25 bg-amber-500/[0.08] p-1.5">
            <MonitorPlay className="h-4 w-4 text-accent-text" aria-hidden />
          </div>
          <div>
            <h2 className="font-display text-[15px] font-semibold text-surface-50">{t('playback.title', 'Playback friction')}</h2>
            <p className="text-[12px] text-surface-400">
              {t('playback.subtitle', 'Transcodes and abandoned plays over the last {{days}} days, inferred from Tautulli’s session records.', { days: report?.windowDays ?? 30 })}
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
          {[...Array(2)].map((_, i) => (
            <div key={i} className="skeleton-shimmer h-24 rounded-xl" />
          ))}
        </div>
      ) : query.isError || !report ? (
        <div className="mt-4">
          <ErrorState error={query.error instanceof Error ? query.error : new Error(String(query.error))} title={t('playback.loadFailed', 'Could not read playback history')} retry={() => void query.refetch()} />
        </div>
      ) : !report.available ? (
        <div className="mt-4 rounded-xl border border-surface-700/60 bg-surface-800/40 px-4 py-3">
          <p className="text-[13px] font-semibold text-surface-50">{t('playback.unavailable', 'Needs Tautulli')}</p>
          <p className="mt-0.5 text-[12px] leading-relaxed text-surface-400">{report.note}</p>
          <Link to={CONNECTIONS_SETTINGS_PATH} className="mt-2 inline-block text-[12px] text-accent-text hover:underline">
            {t('playback.changeProvider', 'Change the watch history provider')}
          </Link>
        </div>
      ) : report.decisions.total === 0 ? (
        <p className="mt-4 text-[13px] text-surface-400">{report.note ?? t('playback.noPlays', 'No plays recorded in this window.')}</p>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {report.items.length === 0 && <SeverityBadge severity="ok" />}
            {report.counts.warning > 0 && <SeverityBadge severity="warning" count={report.counts.warning} />}
            {report.counts.info > 0 && <SeverityBadge severity="info" count={report.counts.info} />}
            <span className="text-[12px] text-surface-400">
              {t('playback.decisionSummary', '{{total}} plays · {{direct}}% direct play · {{stream}}% direct stream · {{transcode}}% transcode', {
                total: report.decisions.total.toLocaleString(),
                direct: pct(report.decisions.directPlay, report.decisions.total),
                stream: pct(report.decisions.directStream, report.decisions.total),
                transcode: pct(report.decisions.transcode, report.decisions.total),
              })}
            </span>
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div className="rounded-xl border border-surface-700/60 bg-surface-800/30 p-3.5">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-surface-500">{t('playback.byClient', 'Transcode rate by client')}</p>
              {report.clients.length === 0 ? (
                <p className="text-[12px] text-surface-500">{t('playback.fewPlays', 'Not enough plays per client yet (3 needed).')}</p>
              ) : (
                <ShareBars
                  rows={report.clients.slice(0, 8).map((c) => ({
                    label: c.client,
                    share: c.transcodeRate,
                    caption: `${c.transcodes}/${c.plays}${c.codecs.length ? ` · ${c.codecs.join(', ')}` : ''}`,
                    tone: c.transcodeRate >= 0.5 ? 'ruby' : c.transcodeRate >= 0.2 ? 'accent' : 'emerald',
                  }))}
                  ariaLabel={t('playback.byClient', 'Transcode rate by client')}
                />
              )}
            </div>
            <div className="rounded-xl border border-surface-700/60 bg-surface-800/30 p-3.5">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-surface-500">{t('playback.byTitle', 'Titles that transcode most')}</p>
              {report.titles.length === 0 ? (
                <p className="text-[12px] text-surface-500">{t('playback.noTranscodedTitles', 'No title transcoded more than once.')}</p>
              ) : (
                <ol className="space-y-1 text-[12.5px]">
                  {report.titles.slice(0, 8).map((title) => (
                    <li key={title.title} className="flex items-baseline gap-2">
                      {title.mediaItemId ? (
                        <Link to={`/library/${title.mediaItemId}`} className="min-w-0 flex-1 truncate text-surface-100 hover:underline">
                          {title.title}
                        </Link>
                      ) : (
                        <span className="min-w-0 flex-1 truncate text-surface-100">{title.title}</span>
                      )}
                      {title.codec && <span className="font-mono text-[11px] text-surface-500">{title.codec}</span>}
                      <span className="font-mono text-[11px] text-surface-400">
                        {title.transcodes}/{title.plays}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>

          <div className="mt-4 rounded-xl border border-surface-700/60 bg-surface-800/30 p-3.5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-surface-500">{t('playback.abandoned', 'Plays dropped in the first fifth')}</p>
              <p className="text-[12px] text-surface-400">
                {t('playback.abandonedSummary', '{{count}} plays ({{pct}}%), {{retried}} tried again within a day', {
                  count: report.abandoned.count,
                  pct: Math.round(report.abandoned.rate * 100),
                  retried: report.retried,
                })}
              </p>
            </div>
            {report.abandoned.recent.length > 0 && (
              <ul className="mt-2 divide-y divide-surface-700/50 rounded-lg border border-surface-700/50 bg-surface-900/40">
                {report.abandoned.recent.slice(0, 6).map((a, i) => (
                  <li key={`${a.stoppedAt}-${i}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-1.5 text-[12px]">
                    <span className="min-w-0 flex-1 truncate text-surface-100">{a.title}</span>
                    <span className="text-surface-400">{a.user}</span>
                    <span className="text-surface-500">{a.client}</span>
                    <span className="font-mono text-[11px] text-surface-400">{a.percentComplete}%</span>
                    {a.transcode && <span className="rounded bg-ruby-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-ruby-text">{t('playback.transcoded', 'transcoded')}</span>}
                    <span className="text-[11px] text-surface-500">{formatRelativeTime(a.stoppedAt)}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-[11px] text-surface-500">
              {t('playback.caveat', 'Buffering and client errors are not recorded anywhere Prunerr can read, so this is the shape of friction, not a count of failures.')}
            </p>
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
        </>
      )}
    </Card>
  );
}
