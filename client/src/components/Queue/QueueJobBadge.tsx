import { useTranslation } from 'react-i18next';
import { Loader2, RotateCcw } from 'lucide-react';
import { Badge } from '@/components/common/Badge';
import { formatElapsed, stepElapsedMs, stepLabel } from '@/lib/deletionJobs';
import type { DeletionJob } from '@/types';

interface QueueJobBadgeProps {
  job: DeletionJob;
  now: number;
  onRetry?: () => void;
  compact?: boolean;
}

/**
 * The inline state of a queue row's background deletion: Pending, Deleting
 * (step + elapsed), Verifying, Failed (reason, with retry) or Done.
 */
export function QueueJobBadge({ job, now, onRetry, compact = false }: QueueJobBadgeProps) {
  const { t } = useTranslation('queue');
  const elapsed = stepElapsedMs(job, now);
  const elapsedText = elapsed !== null && elapsed >= 1000 ? ` · ${formatElapsed(elapsed)}` : '';

  switch (job.status) {
    case 'pending':
      return (
        <Badge variant="muted" size={compact ? 'sm' : 'md'}>
          {t('jobs.badge.pending', 'Queued to delete')}
        </Badge>
      );
    case 'running':
      return (
        <Badge variant="accent" size={compact ? 'sm' : 'md'} title={stepLabel(job, t)}>
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
          {compact ? t('jobs.badge.deleting', 'Deleting') : `${t('jobs.badge.deleting', 'Deleting')}: ${stepLabel(job, t)}`}
          {elapsedText}
        </Badge>
      );
    case 'verifying':
      return (
        <Badge variant="warning" size={compact ? 'sm' : 'md'} title={stepLabel(job, t)}>
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
          {t('jobs.badge.verifying', 'Verifying')}
          {elapsedText}
        </Badge>
      );
    case 'done':
      return (
        <Badge variant="success" size={compact ? 'sm' : 'md'}>
          {t('jobs.badge.done', 'Deleted')}
        </Badge>
      );
    case 'reconciled':
      return (
        <Badge variant="success" size={compact ? 'sm' : 'md'}>
          {t('jobs.badge.reconciled', 'Already deleted')}
        </Badge>
      );
    case 'failed':
      return (
        <span className="inline-flex max-w-full items-center gap-1.5">
          <Badge variant="danger" size={compact ? 'sm' : 'md'} title={job.error ?? undefined} className="max-w-[16rem] truncate">
            {t('jobs.badge.failed', 'Failed')}
            {job.error && !compact ? `: ${job.error}` : ''}
          </Badge>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-accent-text hover:bg-surface-700/60"
              title={t('jobs.panel.retry', 'Retry')}
            >
              <RotateCcw className="h-3 w-3" aria-hidden />
              {t('jobs.panel.retry', 'Retry')}
            </button>
          )}
        </span>
      );
    default:
      return null;
  }
}

export default QueueJobBadge;
