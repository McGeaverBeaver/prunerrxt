import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ExternalLink, ChevronRight } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { InsightItem, InsightSeverity } from '@/types';

import { SEVERITY_STYLE, useSeverityLabel, useSourceLabel } from './severity';

export function SeverityBadge({ severity, count }: { severity: InsightSeverity; count?: number }) {
  const label = useSeverityLabel();
  const style = SEVERITY_STYLE[severity];
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold', style.ring, style.text)}>
      <span className={cn('h-1.5 w-1.5 rounded-full', style.dot)} aria-hidden />
      {typeof count === 'number' ? `${count} ${label(severity).toLowerCase()}` : label(severity)}
    </span>
  );
}

/**
 * One finding: severity, where it came from, what it is, and where to go.
 * Internal links stay in the router; external ones (an app's wiki, its own
 * UI) open in a new tab.
 */
export function InsightRow({ item, mediaServer, action }: { item: InsightItem; mediaServer: string; action?: ReactNode }) {
  const { t } = useTranslation('insights');
  const sourceLabel = useSourceLabel();
  const style = SEVERITY_STYLE[item.severity];
  const Icon = style.Icon;
  const dimmed = Boolean(item.acknowledged);

  const body = (
    <>
      <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', style.text)} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold text-surface-50">
          {item.title}
          <span className="ml-2 rounded-sm bg-surface-700/50 px-1.5 py-0.5 align-middle text-[10px] font-semibold uppercase tracking-wide text-surface-400">
            {sourceLabel(item.source, mediaServer)}
          </span>
        </p>
        {item.detail && <p className="mt-0.5 text-[12px] leading-relaxed text-surface-400">{item.detail}</p>}
      </div>
      {item.href && (
        <span className="ml-auto shrink-0 self-center text-surface-500">
          {item.external ? <ExternalLink className="h-3.5 w-3.5" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />}
        </span>
      )}
    </>
  );

  const className = cn(
    'flex min-w-0 flex-1 items-start gap-3 rounded-xl border px-3.5 py-3 transition-colors',
    style.ring,
    dimmed && 'opacity-60',
    item.href && 'hover:border-surface-500/60 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-500/40'
  );

  let main: ReactNode;
  if (item.href && item.external) {
    main = (
      <a href={item.href} target="_blank" rel="noopener noreferrer" className={className} title={t('openExternal', 'Opens in a new tab')}>
        {body}
      </a>
    );
  } else if (item.href) {
    main = (
      <Link to={item.href} className={className}>
        {body}
      </Link>
    );
  } else {
    main = <div className={className}>{body}</div>;
  }

  // The action sits beside the link, never inside it: a button inside an
  // anchor is invalid markup and the two would fight over the click.
  if (!action) return main;
  return (
    <div className="flex items-stretch gap-2">
      {main}
      <div className="flex shrink-0 items-center">{action}</div>
    </div>
  );
}
