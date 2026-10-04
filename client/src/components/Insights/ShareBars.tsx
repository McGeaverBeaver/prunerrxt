import { cn } from '@/lib/utils';

export interface ShareRow {
  label: string;
  /** 0..1 */
  share: number;
  /** Shown at the right edge, e.g. "1,204 · 3.2 TB". */
  caption: string;
  tone?: 'accent' | 'emerald' | 'violet' | 'ruby' | 'muted';
}

const TONE: Record<NonNullable<ShareRow['tone']>, string> = {
  accent: 'bg-accent-500',
  emerald: 'bg-emerald-500',
  violet: 'bg-violet-500',
  ruby: 'bg-ruby-500',
  muted: 'bg-surface-500',
};

/** Horizontal share bars; the simplest honest chart for "how much of the library is X". */
export function ShareBars({ rows, ariaLabel }: { rows: ShareRow[]; ariaLabel: string }) {
  const max = Math.max(0.0001, ...rows.map((r) => r.share));
  return (
    <ul className="space-y-1.5" aria-label={ariaLabel}>
      {rows.map((row) => (
        <li key={row.label} className="grid grid-cols-[72px_1fr_auto] items-center gap-2 text-[12px]">
          <span className="truncate font-medium text-surface-200">{row.label}</span>
          <span className="h-2 overflow-hidden rounded-full bg-surface-800/80">
            <span
              className={cn('block h-full rounded-full', TONE[row.tone ?? 'accent'])}
              style={{ width: `${Math.max(1.5, (row.share / max) * 100)}%` }}
              aria-hidden
            />
          </span>
          <span className="whitespace-nowrap font-mono text-[11px] text-surface-400">
            {Math.round(row.share * 100)}% <span className="text-surface-500">· {row.caption}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
