import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, AlertTriangle } from 'lucide-react';
import { useDeletionJobs } from '@/contexts/DeletionJobsContext';
import { batchPosition, formatElapsed, stepElapsedMs, stepLabel } from '@/lib/deletionJobs';
import { DeletionJobsPanel } from '@/components/Queue/DeletionJobsPanel';

/**
 * The one line in the sidebar that says what is being deleted right now:
 * "Deleting 2 of 4 · Example Movie: deleting files in Radarr (3m 12s)".
 * Clicking it opens the jobs panel. Hidden when nothing is running and
 * nothing recently failed.
 */
export function DeletionJobsIndicator() {
  const { active, recent, now } = useDeletionJobs();
  const { t } = useTranslation('queue');
  const [open, setOpen] = useState(false);

  const current = active.find((job) => job.status === 'running' || job.status === 'verifying') ?? active[0];
  const failed = recent.filter((job) => job.status === 'failed');

  if (!current && failed.length === 0) return null;

  let headline: string;
  let detail: string | null = null;
  if (current) {
    const position = batchPosition(current, [...active, ...recent]);
    headline = position
      ? t('jobs.indicator.deletingOf', 'Deleting {{index}} of {{total}}', position)
      : active.length > 1
        ? t('jobs.indicator.deletingCount', 'Deleting {{count}} items', { count: active.length })
        : t('jobs.indicator.deleting', 'Deleting');
    const elapsed = stepElapsedMs(current, now);
    detail = `${current.title}: ${stepLabel(current, t)}${elapsed !== null && elapsed >= 1000 ? ` (${formatElapsed(elapsed)})` : ''}`;
  } else {
    headline = t('jobs.indicator.failed', '{{count}} deletion failed', { count: failed.length });
    detail = failed[0]!.title;
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={
          current
            ? 'mx-4 mb-2 flex w-[calc(100%-2rem)] items-start gap-3 rounded-xl border border-accent-500/20 bg-accent-500/10 px-3 py-2.5 text-left transition-colors hover:bg-accent-500/15'
            : 'mx-4 mb-2 flex w-[calc(100%-2rem)] items-start gap-3 rounded-xl border border-ruby-500/20 bg-ruby-500/10 px-3 py-2.5 text-left transition-colors hover:bg-ruby-500/15'
        }
        title={t('jobs.indicator.open', 'Show deletion jobs')}
      >
        {current ? (
          <Loader2 className="mt-0.5 h-4 w-4 flex-shrink-0 animate-spin text-accent-text" aria-hidden />
        ) : (
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-ruby-text" aria-hidden />
        )}
        <span className="min-w-0 flex-1">
          <span className={`block text-sm font-medium ${current ? 'text-surface-50' : 'text-ruby-text'}`}>{headline}</span>
          {detail && <span className="block truncate text-xs text-surface-400">{detail}</span>}
        </span>
      </button>
      <DeletionJobsPanel isOpen={open} onClose={() => setOpen(false)} />
    </>
  );
}

export default DeletionJobsIndicator;
