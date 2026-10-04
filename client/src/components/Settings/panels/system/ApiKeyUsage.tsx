import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, RefreshCw, Trash2 } from 'lucide-react';

import { cn, formatRelativeTime } from '@/lib/utils';
import type { ApiKeyUsageSummary, ApiKeyUseOutcome } from '@/services/api';

function Stat({ label, value, tone = 'default' }: { label: string; value: string; tone?: 'default' | 'warn' | 'ok' }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-xl border border-surface-700/60 bg-surface-800/40 px-3 py-2.5">
      <span className="text-[10.5px] font-semibold uppercase tracking-wider text-surface-500">{label}</span>
      <span
        className={cn(
          'truncate font-display text-[14px] font-semibold',
          tone === 'warn' ? 'text-ruby-text' : tone === 'ok' ? 'text-emerald-text' : 'text-surface-50'
        )}
      >
        {value}
      </span>
    </div>
  );
}

function OutcomeBadge({ outcome }: { outcome: ApiKeyUseOutcome }) {
  const { t } = useTranslation('settings');
  const label =
    outcome === 'ok'
      ? t('apiKey.usage.outcome.ok', 'accepted')
      : outcome === 'invalid'
        ? t('apiKey.usage.outcome.invalid', 'wrong key')
        : t('apiKey.usage.outcome.disabled', 'key off');
  return (
    <span
      className={cn(
        'rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
        outcome === 'ok' ? 'bg-emerald-500/15 text-emerald-text' : 'bg-ruby-500/15 text-ruby-text'
      )}
    >
      {label}
    </span>
  );
}

/**
 * How the API key is being used: when it was last accepted, how busy it is,
 * which clients present it, and the most recent requests, including the ones
 * that were refused. Lets an admin see at a glance whether the key is in use
 * before switching it off or regenerating it, and whether anything is
 * knocking with a wrong key.
 */
export function ApiKeyUsage({
  usage,
  refreshing,
  onRefresh,
  onClear,
}: {
  usage: ApiKeyUsageSummary;
  refreshing: boolean;
  onRefresh: () => void;
  onClear: () => void;
}) {
  const { t } = useTranslation('settings');
  const [recentOpen, setRecentOpen] = useState(false);

  const never = t('apiKey.usage.never', 'Never');
  const hasAny = usage.recent.length > 0;

  return (
    <div className="flex flex-col gap-3 rounded-xl bg-surface-800/45 px-3.5 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="font-display text-[12.5px] font-semibold text-surface-200">
            {t('apiKey.usage.title', 'Usage history')}
          </p>
          <p className="text-[11.5px] text-surface-400">
            {t('apiKey.usage.subtitle', 'Every request that sends the key is logged for {{days}} days. The web UI never sends it.', {
              days: usage.retentionDays,
            })}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            className="inline-flex min-h-[36px] items-center gap-1.5 rounded-[10px] border border-surface-600/80 px-2.5 text-[11.5px] font-semibold text-surface-200 transition-colors hover:bg-surface-700/60 hover:text-surface-50 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin motion-reduce:animate-none')} aria-hidden />
            {t('apiKey.usage.refresh', 'Refresh')}
          </button>
          <button
            type="button"
            onClick={onClear}
            disabled={!hasAny}
            className="inline-flex min-h-[36px] items-center gap-1.5 rounded-[10px] border border-surface-600/80 px-2.5 text-[11.5px] font-semibold text-surface-200 transition-colors hover:bg-surface-700/60 hover:text-surface-50 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
            {t('apiKey.usage.clear', 'Clear')}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat
          label={t('apiKey.usage.lastUsed', 'Last used')}
          value={usage.lastUsedAt ? formatRelativeTime(usage.lastUsedAt) : never}
          tone={usage.lastUsedAt ? 'ok' : 'default'}
        />
        <Stat label={t('apiKey.usage.last24h', 'Requests, 24 h')} value={usage.requestsLast24h.toLocaleString()} />
        <Stat label={t('apiKey.usage.last7d', 'Requests, 7 days')} value={usage.requestsLast7d.toLocaleString()} />
        <Stat
          label={t('apiKey.usage.refused24h', 'Refused, 24 h')}
          value={usage.refusedLast24h.toLocaleString()}
          tone={usage.refusedLast24h > 0 ? 'warn' : 'default'}
        />
      </div>

      {usage.refusedLast24h > 0 && (
        <p className="rounded-xl border border-ruby-500/25 bg-ruby-500/[0.06] px-3.5 py-2.5 text-[11.5px] text-ruby-text">
          {t(
            'apiKey.usage.refusedHint',
            'Something sent a wrong or switched-off key {{when}}. A script with an old key after a regenerate is the usual cause; an unknown address is worth a look.',
            { when: usage.lastRefusedAt ? formatRelativeTime(usage.lastRefusedAt) : '' }
          )}
        </p>
      )}

      {!hasAny ? (
        <p className="text-[12px] text-surface-400">
          {t('apiKey.usage.empty', 'The key has not been used in the last {{days}} days.', { days: usage.retentionDays })}
        </p>
      ) : (
        <>
          {usage.clients.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-surface-500">
                {t('apiKey.usage.clients', 'Clients')}
              </p>
              <ul className="flex flex-col divide-y divide-surface-700/50 rounded-lg border border-surface-700/50 bg-surface-900/40">
                {usage.clients.map((client) => (
                  <li key={`${client.userAgent ?? ''}|${client.ip ?? ''}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2 text-[12px]">
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-surface-200" title={client.userAgent ?? undefined}>
                      {client.userAgent || t('apiKey.usage.unknownClient', 'Unknown client')}
                    </span>
                    {client.ip && <span className="font-mono text-[11px] text-surface-400">{client.ip}</span>}
                    <span className="text-surface-300">
                      {t('apiKey.usage.requestCount', '{{count}} requests', { count: client.requests })}
                    </span>
                    <span className="text-surface-500">{formatRelativeTime(client.lastUsedAt)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="rounded-lg border border-surface-700/50 bg-surface-900/40">
            <button
              type="button"
              onClick={() => setRecentOpen((open) => !open)}
              aria-expanded={recentOpen}
              className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left"
            >
              <span className="text-[11px] font-semibold uppercase tracking-wider text-surface-500">
                {t('apiKey.usage.recent', 'Recent requests ({{count}})', { count: usage.recent.length })}
              </span>
              <ChevronDown className={cn('h-4 w-4 text-surface-400 transition-transform', recentOpen && 'rotate-180')} aria-hidden />
            </button>
            {recentOpen && (
              <div className="overflow-x-auto border-t border-surface-700/50">
                <table className="w-full text-left text-[11.5px]">
                  <thead className="text-[10.5px] uppercase tracking-wider text-surface-500">
                    <tr>
                      <th className="px-3 py-1.5 font-semibold">{t('apiKey.usage.col.when', 'When')}</th>
                      <th className="px-3 py-1.5 font-semibold">{t('apiKey.usage.col.request', 'Request')}</th>
                      <th className="px-3 py-1.5 font-semibold">{t('apiKey.usage.col.from', 'From')}</th>
                      <th className="px-3 py-1.5 font-semibold">{t('apiKey.usage.col.result', 'Result')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-surface-700/40">
                    {usage.recent.map((entry) => (
                      <tr key={entry.id}>
                        <td className="whitespace-nowrap px-3 py-1.5 text-surface-300" title={new Date(entry.usedAt).toLocaleString()}>
                          {formatRelativeTime(entry.usedAt)}
                        </td>
                        <td className="px-3 py-1.5 font-mono text-[11px] text-surface-200">
                          <span className="text-surface-400">{entry.source === 'mcp' ? 'MCP' : entry.method}</span> {entry.path}
                        </td>
                        <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[11px] text-surface-400" title={entry.userAgent ?? undefined}>
                          {entry.ip ?? '—'}
                        </td>
                        <td className="px-3 py-1.5">
                          <OutcomeBadge outcome={entry.outcome} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
