import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, CheckCircle, XCircle, Clock, MinusCircle, RotateCcw, Ban, Trash2, ChevronDown, ChevronRight } from 'lucide-react';
import { Card } from '@/components/common/Card';
import { Button } from '@/components/common/Button';
import { Badge } from '@/components/common/Badge';
import { useToast } from '@/components/common/Toast';
import { formatBytes, formatRelativeTime, cn } from '@/lib/utils';
import type { FolderBatchSummary, FolderJob } from '@/types';

interface Props {
  batches: FolderBatchSummary[];
  jobs: Map<number, FolderJob>;
  connected: boolean;
  canAct: boolean;
  onCancelBatch: (batchId: string) => Promise<void>;
  onCancelJob: (id: number) => Promise<void>;
  onRetryJob: (id: number) => Promise<void>;
  onClearFinished: () => Promise<void>;
}

/**
 * Progress of the bulk batches: one bar per batch with its counts, the rest
 * of the batch cancellable while it runs, failures listed with a retry.
 */
export function FolderJobsPanel({ batches, jobs, connected, canAct, onCancelBatch, onCancelJob, onRetryJob, onClearFinished }: Props) {
  const { t } = useTranslation('folders');
  const { addToast } = useToast();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | number | null>(null);

  if (batches.length === 0) return null;
  const anyFinished = batches.some((b) => b.pending === 0 && b.running === 0);

  const run = async (key: string | number, fn: () => Promise<void>, failTitle: string) => {
    setBusy(key);
    try {
      await fn();
    } catch (error) {
      addToast({ type: 'error', title: failTitle, message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  };

  const toggle = (batchId: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(batchId)) next.delete(batchId);
      else next.add(batchId);
      return next;
    });

  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-surface-50">
          {t('jobs.title', 'Bulk jobs')}
          {!connected && <span className="ml-2 text-xs font-normal text-surface-500">{t('jobs.polling', '(live updates paused; refreshing every few seconds)')}</span>}
        </h2>
        {anyFinished && canAct && (
          <Button variant="ghost" size="sm" onClick={() => void run('clear', onClearFinished, t('jobs.clearFailed', 'Could not clear'))} disabled={busy === 'clear'}>
            <Trash2 className="h-4 w-4" />
            <span className="ml-1">{t('jobs.clear', 'Clear finished')}</span>
          </Button>
        )}
      </div>
      <ul className="space-y-3">
        {batches.map((batch) => {
          const finished = batch.pending === 0 && batch.running === 0;
          const completed = batch.done + batch.failed + batch.cancelled;
          const percent = batch.total > 0 ? Math.round((completed / batch.total) * 100) : 0;
          const batchJobs = [...jobs.values()].filter((j) => j.batchId === batch.batchId);
          const running = batchJobs.find((j) => j.status === 'running');
          const failed = batchJobs.filter((j) => j.status === 'failed').sort((a, b) => (a.finishedAt ?? '').localeCompare(b.finishedAt ?? ''));
          const expanded = open.has(batch.batchId);
          const actionLabel =
            batch.action === 'delete' ? t('jobs.action.delete', 'Delete') : batch.action === 'import' ? t('jobs.action.import', 'Import') : t('jobs.action.fix', 'Fix permissions');
          return (
            <li key={batch.batchId} className="rounded-lg border border-surface-700/40 bg-surface-800/40 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" onClick={() => toggle(batch.batchId)} className="flex items-center gap-1 text-sm font-medium text-surface-50">
                  {expanded ? <ChevronDown className="h-4 w-4 text-surface-500" /> : <ChevronRight className="h-4 w-4 text-surface-500" />}
                  {t('jobs.batchTitle', '{{action}} {{count}} folders', { action: actionLabel, count: batch.total })}
                </button>
                {finished ? (
                  <Badge variant={batch.failed > 0 ? 'danger' : 'success'} size="sm">
                    {batch.failed > 0 ? t('jobs.finishedWithFailures', 'finished, {{count}} failed', { count: batch.failed }) : t('jobs.finished', 'finished')}
                  </Badge>
                ) : (
                  <Badge variant="accent" size="sm">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    {t('jobs.progress', '{{done}} of {{total}}', { done: completed, total: batch.total })}
                  </Badge>
                )}
                {batch.action === 'delete' && batch.freedBytes > 0 && <Badge variant="muted" size="sm">{t('jobs.freed', '{{size}} freed', { size: formatBytes(batch.freedBytes) })}</Badge>}
                <span className="text-xs text-surface-500">
                  {t('jobs.by', 'by {{who}}', { who: batch.requestedBy })} · {formatRelativeTime(batch.finishedAt ?? batch.createdAt)}
                </span>
                {!finished && canAct && batch.pending > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto"
                    disabled={busy === batch.batchId}
                    onClick={() => void run(batch.batchId, () => onCancelBatch(batch.batchId), t('jobs.cancelFailed', 'Could not cancel'))}
                    title={t('jobs.cancelRest', 'Stop the remaining {{count}}', { count: batch.pending })}
                  >
                    <Ban className="h-4 w-4" />
                    <span className="ml-1">{t('jobs.cancelRest', 'Stop the remaining {{count}}', { count: batch.pending })}</span>
                  </Button>
                )}
              </div>
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface-700/60">
                <div className={cn('h-full rounded-full transition-all', batch.failed > 0 ? 'bg-ruby-500/70' : 'bg-accent-500')} style={{ width: `${percent}%` }} />
              </div>
              <p className="mt-1.5 truncate text-xs text-surface-400">
                {running
                  ? t('jobs.working', 'Working on {{name}}: {{message}}', { name: running.name, message: running.message ?? '' })
                  : finished
                    ? t('jobs.counts', '{{done}} done, {{failed}} failed, {{cancelled}} cancelled', { done: batch.done, failed: batch.failed, cancelled: batch.cancelled })
                    : t('jobs.waiting', 'Waiting for its turn')}
              </p>
              {expanded && (
                <ul className="mt-3 max-h-72 space-y-1 overflow-y-auto pr-1">
                  {[...failed, ...batchJobs.filter((j) => j.status !== 'failed')].map((job) => (
                    <JobRow
                      key={job.id}
                      job={job}
                      canAct={canAct}
                      busy={busy === job.id}
                      onCancel={() => void run(job.id, () => onCancelJob(job.id), t('jobs.cancelFailed', 'Could not cancel'))}
                      onRetry={() => void run(job.id, () => onRetryJob(job.id), t('jobs.retryFailed', 'Could not retry'))}
                    />
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function JobRow({ job, canAct, busy, onCancel, onRetry }: { job: FolderJob; canAct: boolean; busy: boolean; onCancel: () => void; onRetry: () => void }) {
  const { t } = useTranslation('folders');
  const icon =
    job.status === 'running' ? (
      <Loader2 className="h-4 w-4 animate-spin text-accent-text" />
    ) : job.status === 'pending' ? (
      <Clock className="h-4 w-4 text-surface-500" />
    ) : job.status === 'done' ? (
      <CheckCircle className="h-4 w-4 text-emerald-text" />
    ) : job.status === 'failed' ? (
      <XCircle className="h-4 w-4 text-ruby-text" />
    ) : (
      <MinusCircle className="h-4 w-4 text-surface-500" />
    );
  return (
    <li className="flex items-start gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-surface-800/60">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-surface-200" title={job.path}>
          {job.name} <span className="text-surface-500">· {job.serviceLabel}</span>
        </p>
        {(job.error || job.message) && <p className={cn('truncate', job.status === 'failed' ? 'text-ruby-text' : 'text-surface-500')} title={job.error ?? job.message ?? ''}>{job.error ?? job.message}</p>}
      </div>
      {canAct && job.status === 'pending' && (
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy} title={t('jobs.cancelJob', 'Cancel')}>
          <Ban className="h-3.5 w-3.5" />
        </Button>
      )}
      {canAct && (job.status === 'failed' || job.status === 'cancelled') && (
        <Button variant="ghost" size="sm" onClick={onRetry} disabled={busy} title={t('jobs.retryJob', 'Retry')}>
          <RotateCcw className="h-3.5 w-3.5" />
        </Button>
      )}
    </li>
  );
}
