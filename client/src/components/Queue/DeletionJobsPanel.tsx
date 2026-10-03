import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, CheckCircle, XCircle, Clock, MinusCircle, RotateCcw, Ban, Trash2 } from 'lucide-react';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/common/Button';
import { Badge } from '@/components/common/Badge';
import { useDeletionJobs } from '@/contexts/DeletionJobsContext';
import { useToast } from '@/components/common/Toast';
import { formatBytes, formatRelativeTime } from '@/lib/utils';
import { formatElapsed, statusLabel, stepElapsedMs, stepLabel, stepName } from '@/lib/deletionJobs';
import type { DeletionJob } from '@/types';

interface DeletionJobsPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Everything the worker is doing or has done lately: one row per job with
 * its step, elapsed time, per-step durations and error, plus cancel for jobs
 * that have not started and retry for ones that failed.
 */
export function DeletionJobsPanel({ isOpen, onClose }: DeletionJobsPanelProps) {
  const { active, recent, now, cancel, retry, clearFinished, connected } = useDeletionJobs();
  const { t } = useTranslation('queue');
  const { addToast } = useToast();
  const [busy, setBusy] = useState<number | null>(null);

  const run = async (id: number, action: 'cancel' | 'retry') => {
    setBusy(id);
    try {
      if (action === 'cancel') await cancel(id);
      else await retry(id);
    } catch (error) {
      addToast({
        type: 'error',
        title: action === 'cancel' ? t('jobs.panel.cancelFailed', 'Could not cancel') : t('jobs.panel.retryFailed', 'Could not retry'),
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={t('jobs.panel.title', 'Deletion jobs')} size="2xl">
      <div className="space-y-5">
        <p className="text-sm text-surface-400">
          {t('jobs.panel.intro', 'Deletions run in the background. A large file on network storage can take Sonarr or Radarr several minutes; the app stays usable meanwhile and the outcome lands here and in the Activity log.')}
          {!connected && (
            <span className="ml-1 text-xs text-surface-500">{t('jobs.panel.polling', '(live updates paused; refreshing every few seconds)')}</span>
          )}
        </p>

        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-widest text-surface-500">
            {t('jobs.panel.active', 'In progress')} {active.length > 0 && <span className="text-surface-400">({active.length})</span>}
          </h3>
          {active.length === 0 ? (
            <p className="rounded-lg bg-surface-800/40 px-3 py-4 text-center text-sm text-surface-500">{t('jobs.panel.nothingActive', 'Nothing is being deleted right now.')}</p>
          ) : (
            <ul className="space-y-2">
              {active.map((job) => (
                <JobRow key={job.id} job={job} now={now} busy={busy === job.id} onCancel={() => run(job.id, 'cancel')} onRetry={() => run(job.id, 'retry')} />
              ))}
            </ul>
          )}
        </section>

        <section>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-widest text-surface-500">{t('jobs.panel.recent', 'Recently finished')}</h3>
            {recent.length > 0 && (
              <Button variant="ghost" size="sm" onClick={() => void clearFinished()} title={t('jobs.panel.clear', 'Clear finished')}>
                <Trash2 className="h-4 w-4" />
                <span className="ml-1">{t('jobs.panel.clear', 'Clear finished')}</span>
              </Button>
            )}
          </div>
          {recent.length === 0 ? (
            <p className="rounded-lg bg-surface-800/40 px-3 py-4 text-center text-sm text-surface-500">{t('jobs.panel.nothingRecent', 'No finished deletions yet.')}</p>
          ) : (
            <ul className="max-h-80 space-y-2 overflow-y-auto pr-1">
              {recent.map((job) => (
                <JobRow key={job.id} job={job} now={now} busy={busy === job.id} onCancel={() => run(job.id, 'cancel')} onRetry={() => run(job.id, 'retry')} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </Modal>
  );
}

function JobRow({ job, now, busy, onCancel, onRetry }: { job: DeletionJob; now: number; busy: boolean; onCancel: () => void; onRetry: () => void }) {
  const { t } = useTranslation('queue');
  const elapsed = stepElapsedMs(job, now);
  const durations = Object.entries(job.stepDurationsMs ?? {}).filter(([, ms]) => typeof ms === 'number');

  const icon =
    job.status === 'running' || job.status === 'verifying' ? (
      <Loader2 className="h-4 w-4 animate-spin text-accent-text" aria-hidden />
    ) : job.status === 'pending' ? (
      <Clock className="h-4 w-4 text-surface-500" aria-hidden />
    ) : job.status === 'done' || job.status === 'reconciled' ? (
      <CheckCircle className="h-4 w-4 text-emerald-text" aria-hidden />
    ) : job.status === 'failed' ? (
      <XCircle className="h-4 w-4 text-ruby-text" aria-hidden />
    ) : (
      <MinusCircle className="h-4 w-4 text-surface-500" aria-hidden />
    );

  const badgeVariant =
    job.status === 'failed' ? 'danger' : job.status === 'done' || job.status === 'reconciled' ? 'success' : job.status === 'verifying' ? 'warning' : job.status === 'running' ? 'accent' : 'muted';

  return (
    <li className="rounded-lg border border-surface-700/40 bg-surface-800/40 px-3 py-2.5">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex-shrink-0">{icon}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium text-surface-50">{job.title}</span>
            <Badge variant={badgeVariant} size="sm">{statusLabel(job.status, t)}</Badge>
            {job.service && <span className="text-2xs uppercase tracking-wider text-surface-500">{job.service}</span>}
          </div>
          <p className="mt-0.5 text-xs text-surface-400">
            {job.status === 'running' || job.status === 'verifying' ? (
              <>
                {stepLabel(job, t)}
                {elapsed !== null && <span className="ml-1 text-surface-500">· {formatElapsed(elapsed)}</span>}
              </>
            ) : job.status === 'pending' ? (
              job.message ?? t('jobs.step.pending', 'waiting to start')
            ) : (
              <>
                {job.message}
                {job.finishedAt && <span className="ml-1 text-surface-500">· {formatRelativeTime(job.finishedAt)}</span>}
              </>
            )}
          </p>
          {job.status === 'failed' && job.error && (
            <p className="mt-1 break-words text-xs text-ruby-text">
              {job.failedStep && job.failedService
                ? t('jobs.panel.failedAt', 'Failed while {{step}} in {{service}}', { step: stepName(job.failedStep, t).toLowerCase(), service: job.failedService })
                : t('jobs.status.failed', 'Failed')}
              {job.upstreamStatus !== null && job.upstreamStatus !== undefined ? ` (HTTP ${job.upstreamStatus})` : ''}: {job.error}
            </p>
          )}
          {job.status === 'failed' && job.upstreamLog && job.upstreamLog.length > 0 && (
            <details className="mt-1 text-xs">
              <summary className="cursor-pointer text-surface-400 hover:text-surface-200">
                {t('jobs.panel.upstreamLog', 'From the {{service}} log', { service: job.failedService ?? job.service ?? 'Sonarr/Radarr' })}
              </summary>
              <ul className="mt-1 space-y-1 rounded bg-surface-900/60 p-2 font-mono text-2xs text-surface-300">
                {job.upstreamLog.map((line, idx) => (
                  <li key={idx} className="break-words">{line}</li>
                ))}
              </ul>
            </details>
          )}
          {durations.length > 0 && (
            <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-2xs text-surface-500">
              {durations.map(([step, ms]) => (
                <span key={step}>
                  {stepName(step, t)} {formatElapsed(ms)}
                </span>
              ))}
              {job.fileSizeFreed !== null && job.fileSizeFreed > 0 && <span>{t('jobs.panel.freed', '{{size}} freed', { size: formatBytes(job.fileSizeFreed) })}</span>}
              {job.attempts > 1 && <span>{t('jobs.panel.attempts', 'attempt {{count}}', { count: job.attempts })}</span>}
            </p>
          )}
        </div>
        <div className="flex flex-shrink-0 items-center gap-1">
          {job.status === 'pending' && (
            <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy} title={t('jobs.panel.cancel', 'Cancel')}>
              <Ban className="h-4 w-4" />
            </Button>
          )}
          {(job.status === 'failed' || job.status === 'cancelled') && (
            <Button variant="secondary" size="sm" onClick={onRetry} disabled={busy} title={t('jobs.panel.retry', 'Retry')}>
              <RotateCcw className="h-4 w-4" />
              <span className="ml-1">{t('jobs.panel.retry', 'Retry')}</span>
            </Button>
          )}
        </div>
      </div>
    </li>
  );
}

export default DeletionJobsPanel;
