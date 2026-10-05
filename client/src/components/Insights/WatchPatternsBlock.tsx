import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { PlayCircle, RefreshCw, Users } from 'lucide-react';

import { Card } from '@/components/common/Card';
import { ErrorState } from '@/components/common/ErrorState';
import { useMediaServerName, useWatchPatterns } from '@/hooks/useApi';
import { cn, formatBytes, formatRelativeTime } from '@/lib/utils';
import type { WeekPoint } from '@/types';

import { InsightRow, SeverityBadge } from './InsightItems';
import { ShareBars } from './ShareBars';

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'up' | 'down' }) {
  return (
    <div className="rounded-xl border border-surface-700/60 bg-surface-800/30 px-3.5 py-3">
      <p className="text-[10.5px] font-semibold uppercase tracking-wider text-surface-500">{label}</p>
      <p className="mt-0.5 font-display text-[18px] font-semibold text-surface-50">{value}</p>
      {sub && <p className={cn('text-[11px]', tone === 'up' ? 'text-emerald-text' : tone === 'down' ? 'text-ruby-text' : 'text-surface-500')}>{sub}</p>}
    </div>
  );
}

/** Twelve weekly columns, movies stacked on episodes. Hand-drawn, like the rest of the app's charts. */
function WeeklyBars({ weeks }: { weeks: WeekPoint[] }) {
  const { t } = useTranslation('insights');
  const max = Math.max(1, ...weeks.map((w) => w.plays));
  return (
    <div className="flex h-28 items-end gap-1.5" role="img" aria-label={t('watch.weeklyAria', 'Plays per week for the last 12 weeks')}>
      {weeks.map((w) => {
        const total = (w.plays / max) * 100;
        const episodes = w.plays ? (w.episodes / w.plays) * total : 0;
        return (
          <div key={w.weekStart} className="group relative flex h-full flex-1 flex-col justify-end" title={`${w.weekStart}: ${w.plays} plays, ${w.users} viewers`}>
            <div className="w-full overflow-hidden rounded-t-md bg-surface-800/70" style={{ height: `${Math.max(2, total)}%` }}>
              <div className="w-full bg-accent-500/80" style={{ height: `${total ? 100 - (episodes / total) * 100 : 0}%` }} />
              <div className="w-full bg-emerald-500/70" style={{ height: `${total ? (episodes / total) * 100 : 0}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Watch patterns: plays per week, who watches, what is popular, and how much
 * of the library has never been played or has gone quiet. The last part is
 * the rules engine's input, shown so a "not watched in a year" rule can be
 * judged before it runs.
 */
export function WatchPatternsBlock() {
  const { t } = useTranslation('insights');
  const mediaServer = useMediaServerName();
  const query = useWatchPatterns();
  const report = query.data;

  const trend = (now: number, before: number): { sub: string; tone: 'up' | 'down' | undefined } => {
    if (before === 0) return { sub: t('watch.noPrevious', 'no plays the month before'), tone: undefined };
    const pct = Math.round(((now - before) / before) * 100);
    return { sub: t('watch.vsPrevious', '{{pct}}% vs the month before', { pct: pct > 0 ? `+${pct}` : String(pct) }), tone: pct > 0 ? 'up' : pct < 0 ? 'down' : undefined };
  };

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/8 p-1.5">
            <PlayCircle className="h-4 w-4 text-emerald-text" aria-hidden />
          </div>
          <div>
            <h2 className="font-display text-[15px] font-semibold text-surface-50">{t('watch.title', 'Watch patterns')}</h2>
            <p className="text-[12px] text-surface-400">
              {report?.provider === 'tautulli'
                ? t('watch.subtitleTautulli', 'Plays from Tautulli over the last {{days}} days, and the play counts the sync keeps per title.', { days: report.windowDays })
                : t('watch.subtitle', 'Plays recorded over the last {{days}} days, and the play counts the sync keeps per title.', { days: report?.windowDays ?? 90 })}
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
            className="inline-flex min-h-[36px] items-center gap-1.5 rounded-[10px] border border-surface-600/80 px-2.5 text-[11.5px] font-semibold text-surface-200 transition-colors hover:bg-surface-700/60 hover:text-surface-50 disabled:opacity-50 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-500/60"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', query.isFetching && 'animate-spin motion-reduce:animate-none')} aria-hidden />
            {t('refresh', 'Refresh')}
          </button>
        </div>
      </div>

      {query.isLoading ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="skeleton-shimmer h-16 rounded-xl" />
          ))}
        </div>
      ) : query.isError || !report ? (
        <div className="mt-4">
          <ErrorState error={query.error instanceof Error ? query.error : new Error(String(query.error))} title={t('watch.loadFailed', 'Could not read watch history')} retry={() => void query.refetch()} />
        </div>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {report.items.length === 0 && <SeverityBadge severity="ok" />}
            {report.counts.warning > 0 && <SeverityBadge severity="warning" count={report.counts.warning} />}
            {report.counts.info > 0 && <SeverityBadge severity="info" count={report.counts.info} />}
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label={t('watch.plays30', 'Plays, last 30 days')} value={report.last30.plays.toLocaleString()} {...trend(report.last30.plays, report.previous30.plays)} />
            <Stat
              label={t('watch.viewers30', 'Viewers, last 30 days')}
              value={report.last30.users.toLocaleString()}
              sub={report.knownUsers > 0 ? t('watch.ofKnown', 'of {{count}} synced users', { count: report.knownUsers }) : undefined}
            />
            <Stat
              label={t('watch.mix30', 'Movies · episodes')}
              value={`${report.last30.movies.toLocaleString()} · ${report.last30.episodes.toLocaleString()}`}
              sub={report.last30.hoursWatched !== null ? t('watch.hours', '{{hours}} hours watched', { hours: report.last30.hoursWatched.toLocaleString() }) : undefined}
            />
            <Stat
              label={t('watch.playedRecently', 'Titles played, 90 days')}
              value={report.library.playedLast90.count.toLocaleString()}
              sub={t('watch.ofLibrary', 'of {{total}} in the library', { total: report.library.items.toLocaleString() })}
            />
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-5">
            <div className="rounded-xl border border-surface-700/60 bg-surface-800/30 p-3.5 lg:col-span-3">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-surface-500">{t('watch.weekly', 'Plays per week')}</p>
                <p className="flex items-center gap-3 text-[10.5px] text-surface-500">
                  <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-xs bg-accent-500/80" /> {t('watch.movies', 'Movies')}</span>
                  <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-xs bg-emerald-500/70" /> {t('watch.episodes', 'Episodes')}</span>
                </p>
              </div>
              {report.weekly.every((w) => w.plays === 0) ? (
                <p className="py-8 text-center text-[12px] text-surface-500">{report.note ?? t('watch.noPlays', 'No plays recorded in this window.')}</p>
              ) : (
                <WeeklyBars weeks={report.weekly} />
              )}
            </div>
            <div className="rounded-xl border border-surface-700/60 bg-surface-800/30 p-3.5 lg:col-span-2">
              <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-surface-500">
                <Users className="h-3.5 w-3.5" aria-hidden />
                {t('watch.viewers', 'Who watches')}
              </p>
              {report.viewers.length === 0 ? (
                <p className="text-[12px] text-surface-500">{t('watch.noViewers', 'Nobody yet.')}</p>
              ) : (
                <ShareBars
                  rows={report.viewers.slice(0, 6).map((v) => ({ label: v.user, share: v.share, caption: t('watch.playsCount', '{{count}} plays', { count: v.plays }), tone: 'emerald' }))}
                  ariaLabel={t('watch.viewers', 'Who watches')}
                />
              )}
            </div>
          </div>

          {(report.topShows.length > 0 || report.topMovies.length > 0) && (
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              {[
                { key: 'shows', label: t('watch.topShows', 'Most played shows'), rows: report.topShows },
                { key: 'movies', label: t('watch.topMovies', 'Most played movies'), rows: report.topMovies },
              ]
                .filter((g) => g.rows.length > 0)
                .map((g) => (
                  <div key={g.key} className="rounded-xl border border-surface-700/60 bg-surface-800/30 p-3.5">
                    <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-surface-500">{g.label}</p>
                    <ol className="space-y-1 text-[12.5px]">
                      {g.rows.slice(0, 5).map((r, i) => (
                        <li key={r.title} className="flex items-baseline gap-2">
                          <span className="w-4 text-right font-mono text-[11px] text-surface-500">{i + 1}</span>
                          <span className="min-w-0 flex-1 truncate text-surface-100">{r.title}</span>
                          <span className="font-mono text-[11px] text-surface-400">{t('watch.playsByUsers', '{{plays}} plays · {{users}} viewers', { plays: r.plays, users: r.users })}</span>
                        </li>
                      ))}
                    </ol>
                  </div>
                ))}
            </div>
          )}

          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <Stat
              label={t('watch.neverPlayed', 'Never played')}
              value={report.library.neverPlayed.count.toLocaleString()}
              sub={t('watch.sizeShare', '{{size}} · {{pct}}% of titles', { size: formatBytes(report.library.neverPlayed.bytes, 1), pct: report.library.items ? Math.round((report.library.neverPlayed.count / report.library.items) * 100) : 0 })}
            />
            <Stat
              label={t('watch.neverPlayedOld', 'Never played, added 90+ days ago')}
              value={report.library.neverPlayedOld.count.toLocaleString()}
              sub={formatBytes(report.library.neverPlayedOld.bytes, 1)}
            />
            <Stat label={t('watch.quietYear', 'No play in a year')} value={report.library.quietOverYear.count.toLocaleString()} sub={formatBytes(report.library.quietOverYear.bytes, 1)} />
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

          {report.quietLargest.length > 0 && (
            <div className="mt-4">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-surface-500">{t('watch.quietLargest', 'Largest titles with no play in a year')}</p>
              <ul className="divide-y divide-surface-700/50 rounded-lg border border-surface-700/50 bg-surface-900/40">
                {report.quietLargest.map((item) => (
                  <li key={item.id}>
                    <Link to={`/library/${item.id}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2 text-[12.5px] hover:bg-surface-800/60">
                      <span className="min-w-0 flex-1 truncate text-surface-100">
                        {item.title}
                        {item.year && <span className="text-surface-500"> ({item.year})</span>}
                      </span>
                      <span className="rounded-sm bg-surface-700/50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-surface-400">
                        {item.type === 'movie' ? t('library.movie', 'Movie') : t('library.show', 'Show')}
                      </span>
                      <span className="font-mono text-[11px] text-surface-300">{formatBytes(item.sizeBytes, 1)}</span>
                      <span className="text-[11px] text-surface-500">
                        {item.lastWatchedAt ? t('watch.lastPlayed', 'last played {{when}}', { when: formatRelativeTime(item.lastWatchedAt) }) : t('watch.neverPlayedShort', 'never played')}
                      </span>
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
