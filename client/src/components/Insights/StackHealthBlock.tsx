import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useState } from 'react';
import { Activity, Check, Eye, EyeOff, RefreshCw, ShieldCheck, Undo2 } from 'lucide-react';

import { Card } from '@/components/common/Card';
import { ErrorState } from '@/components/common/ErrorState';
import { useAcknowledgeStackItem, useMediaServerName, useSettings, useStackHealth } from '@/hooks/useApi';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/components/common/Toast';
import { CONNECTIONS_SETTINGS_PATH, serviceHomeUrl } from '@/lib/links';
import { cn, formatRelativeTime } from '@/lib/utils';
import type { StackHealthReport } from '@/types';

import { InsightRow, SeverityBadge } from './InsightItems';
import { SEVERITY_STYLE } from './severity';

function ConnectionDots({ report, mediaServer }: { report: StackHealthReport; mediaServer: string }) {
  const { t } = useTranslation('insights');
  const { data: settings } = useSettings();
  const configured = report.connections.filter((c) => c.configured);
  if (configured.length === 0) {
    return (
      <p className="text-[12px] text-surface-500">
        {t('stack.noServices', 'No services configured yet.')}{' '}
        <Link to={CONNECTIONS_SETTINGS_PATH} className="text-accent-text hover:underline">
          {t('stack.setUp', 'Set them up')}
        </Link>
      </p>
    );
  }
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1.5">
      {configured.map((c) => {
        const name = c.service === 'plex' ? mediaServer : c.service.charAt(0).toUpperCase() + c.service.slice(1);
        const arr = report.arr.find((a) => a.service === c.service);
        const href = serviceHomeUrl(settings, c.service);
        const label = (
          <>
            <span className={cn('h-2 w-2 rounded-full', c.connected ? 'bg-emerald-500' : 'bg-ruby-500')} aria-hidden />
            <span className="text-[12.5px] text-surface-200">{name}</span>
            {arr?.version && <span className="font-mono text-[11px] text-surface-500">{arr.version}</span>}
            {c.connected && typeof c.responseTimeMs === 'number' && <span className="text-[11px] text-surface-500">{c.responseTimeMs}ms</span>}
            {arr?.queue && arr.queue.totalCount > 0 && (
              <span className={cn('text-[11px]', arr.queue.errors ? 'text-ruby-text' : 'text-surface-500')}>
                {t('stack.queueCount', '{{count}} in queue', { count: arr.queue.totalCount })}
              </span>
            )}
          </>
        );
        return (
          <li key={c.service} className="flex items-center gap-1.5">
            {href ? (
              <a href={href} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 hover:underline">
                {label}
              </a>
            ) : (
              label
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Stack health: one list of what is wrong across Prunerr and the apps it
 * talks to, worst first, each with a next step. An empty list is the good
 * news, and says so.
 */
export function StackHealthBlock() {
  const { t } = useTranslation('insights');
  const mediaServer = useMediaServerName();
  const query = useStackHealth();
  const report = query.data;
  const auth = useAuth();
  const { addToast } = useToast();
  const ack = useAcknowledgeStackItem();
  const [showAcknowledged, setShowAcknowledged] = useState(false);
  const canAck = auth.can('operator');

  const overallStyle = report ? SEVERITY_STYLE[report.overall] : SEVERITY_STYLE.info;
  const active = (report?.items ?? []).filter((i) => !i.acknowledged);
  const acknowledged = (report?.items ?? []).filter((i) => i.acknowledged);

  const toggleAck = (id: string, undo: boolean) =>
    ack.mutate(
      { id, undo },
      { onError: (err) => addToast({ type: 'error', title: t('stack.ackFailed', 'Could not update the finding'), message: err instanceof Error ? err.message : String(err) }) }
    );

  const ackButton = (id: string, undo: boolean) => (
    <button
      type="button"
      onClick={() => toggleAck(id, undo)}
      disabled={ack.isPending}
      title={undo ? t('stack.unacknowledge', 'Bring this finding back') : t('stack.acknowledge', 'Acknowledge: hide this finding until it gets worse')}
      aria-label={undo ? t('stack.unacknowledgeShort', 'Unacknowledge') : t('stack.acknowledgeShort', 'Acknowledge')}
      className="inline-flex h-9 w-9 items-center justify-center rounded-[10px] border border-surface-600/80 text-surface-300 transition-colors hover:bg-surface-700/60 hover:text-surface-50 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
    >
      {undo ? <Undo2 className="h-4 w-4" aria-hidden /> : <Check className="h-4 w-4" aria-hidden />}
    </button>
  );

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className={cn('rounded-lg border p-1.5', overallStyle.ring)}>
            <Activity className={cn('h-4 w-4', overallStyle.text)} aria-hidden />
          </div>
          <div>
            <h2 className="font-display text-[15px] font-semibold text-surface-50">{t('stack.title', 'Stack health')}</h2>
            <p className="text-[12px] text-surface-400">
              {t('stack.subtitle', 'Prunerr, {{mediaServer}}, Sonarr, Radarr and the watch history provider, checked together.', { mediaServer })}
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
        <div className="mt-4 space-y-2">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="skeleton-shimmer h-12 rounded-xl" />
          ))}
        </div>
      ) : query.isError || !report ? (
        <div className="mt-4">
          <ErrorState error={query.error instanceof Error ? query.error : new Error(String(query.error))} title={t('stack.loadFailed', 'Could not check the stack')} retry={() => void query.refetch()} />
        </div>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {report.counts.critical > 0 && <SeverityBadge severity="critical" count={report.counts.critical} />}
            {report.counts.warning > 0 && <SeverityBadge severity="warning" count={report.counts.warning} />}
            {report.counts.info > 0 && <SeverityBadge severity="info" count={report.counts.info} />}
            {active.length === 0 && <SeverityBadge severity="ok" />}
            {acknowledged.length > 0 && (
              <button
                type="button"
                onClick={() => setShowAcknowledged((v) => !v)}
                className="inline-flex items-center gap-1.5 rounded-full border border-surface-700/60 bg-surface-800/40 px-2.5 py-0.5 text-[11px] font-semibold text-surface-400 transition-colors hover:text-surface-200"
              >
                {showAcknowledged ? <EyeOff className="h-3 w-3" aria-hidden /> : <Eye className="h-3 w-3" aria-hidden />}
                {showAcknowledged
                  ? t('stack.hideAcknowledged', 'Hide {{count}} acknowledged', { count: acknowledged.length })
                  : t('stack.showAcknowledged', 'Show {{count}} acknowledged', { count: acknowledged.length })}
              </button>
            )}
          </div>

          <div className="mt-3">
            <ConnectionDots report={report} mediaServer={mediaServer} />
          </div>

          {active.length === 0 ? (
            <div className="mt-4 flex items-center gap-3 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.06] px-4 py-3">
              <ShieldCheck className="h-5 w-5 text-emerald-text" aria-hidden />
              <div>
                <p className="text-[13px] font-semibold text-surface-50">{t('stack.allClear', 'Nothing needs attention')}</p>
                <p className="text-[12px] text-surface-400">
                  {acknowledged.length > 0
                    ? t('stack.allClearAcked', 'Every remaining finding has been acknowledged. An acknowledged finding comes back on its own if it gets worse.')
                    : t('stack.allClearBody', 'Every configured service answers, the apps report no health problems, and nothing in Prunerr is stale or stuck.')}
                </p>
              </div>
            </div>
          ) : (
            <ul className="mt-4 space-y-2">
              {active.map((item) => (
                <li key={item.id}>
                  <InsightRow item={item} mediaServer={mediaServer} action={canAck ? ackButton(item.id, false) : undefined} />
                </li>
              ))}
            </ul>
          )}

          {showAcknowledged && acknowledged.length > 0 && (
            <div className="mt-4">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-surface-500">
                {t('stack.acknowledgedTitle', 'Acknowledged')}
              </p>
              <ul className="space-y-2">
                {acknowledged.map((item) => (
                  <li key={item.id}>
                    <InsightRow item={item} mediaServer={mediaServer} action={canAck ? ackButton(item.id, true) : undefined} />
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
