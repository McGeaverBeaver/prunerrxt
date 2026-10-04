import { useTranslation } from 'react-i18next';
import { TrendingDown, TrendingUp, Minus } from 'lucide-react';

import { useInsightHistory } from '@/hooks/useApi';
import { cn, formatBytes } from '@/lib/utils';
import type { InsightSnapshot } from '@/types';

interface TrendDef {
  key: string;
  label: string;
  value: (s: InsightSnapshot) => number | null;
  format: (n: number) => string;
  /** Whether a rise is good news (plays) or bad (never played, transcodes, problems). */
  upIsGood: boolean;
}

/**
 * How the headline numbers moved since the oldest snapshot in the window.
 * Appears once two days of snapshots exist; until then the page simply has
 * no trend to show.
 */
export function TrendStrip() {
  const { t } = useTranslation('insights');
  const { data: rows } = useInsightHistory(90);
  if (!rows || rows.length < 2) return null;

  const first = rows[0]!;
  const last = rows[rows.length - 1]!;
  const days = Math.max(1, Math.round((new Date(last.capturedAt).getTime() - new Date(first.capturedAt).getTime()) / 86_400_000));
  if (days < 1) return null;

  const defs: TrendDef[] = [
    { key: 'problems', label: t('trend.problems', 'Stack problems'), value: (s) => s.stackCritical + s.stackWarning, format: (n) => n.toLocaleString(), upIsGood: false },
    { key: 'never', label: t('trend.neverPlayed', 'Never played'), value: (s) => s.neverPlayedBytes, format: (n) => formatBytes(n, 1), upIsGood: false },
    { key: 'sd', label: t('trend.sd', 'SD titles'), value: (s) => s.sdCount, format: (n) => n.toLocaleString(), upIsGood: false },
    { key: 'plays', label: t('trend.plays', 'Plays, 30 days'), value: (s) => s.plays30, format: (n) => n.toLocaleString(), upIsGood: true },
    { key: 'transcode', label: t('trend.transcode', 'Transcode rate'), value: (s) => s.transcodeRate30, format: (n) => `${Math.round(n * 100)}%`, upIsGood: false },
  ];

  const cells = defs
    .map((d) => {
      const a = d.value(first);
      const b = d.value(last);
      if (a === null || b === null) return null;
      const delta = b - a;
      const dir = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
      const good = dir === 'flat' ? null : (dir === 'up') === d.upIsGood;
      return { ...d, a, b, delta, dir, good };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);

  return (
    <div className="rounded-2xl border border-surface-700/50 bg-surface-900/60 px-4 py-3">
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-surface-500">
        {t('trend.title', 'Over the last {{days}} days', { days })}
      </p>
      <ul className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3 lg:grid-cols-5">
        {cells.map((c) => {
          const Icon = c.dir === 'up' ? TrendingUp : c.dir === 'down' ? TrendingDown : Minus;
          return (
            <li key={c.key} className="min-w-0">
              <p className="truncate text-[11px] text-surface-400">{c.label}</p>
              <p className="flex items-baseline gap-1.5">
                <span className="font-display text-[15px] font-semibold text-surface-50">{c.format(c.b)}</span>
                <span className={cn('inline-flex items-center gap-0.5 text-[11px]', c.good === null ? 'text-surface-500' : c.good ? 'text-emerald-text' : 'text-ruby-text')}>
                  <Icon className="h-3 w-3" aria-hidden />
                  {c.dir === 'flat' ? t('trend.flat', 'no change') : t('trend.from', 'from {{value}}', { value: c.format(c.a) })}
                </span>
              </p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
