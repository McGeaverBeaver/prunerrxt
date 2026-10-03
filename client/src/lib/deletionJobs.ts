import type { TFunction } from 'i18next';
import type { DeletionJob, DeletionJobStatus } from '@/types';

/** "3m 12s" / "42s" / "15 ms" for step durations and elapsed times. */
export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** Milliseconds the job has spent on its current step. */
export function stepElapsedMs(job: DeletionJob, now: number): number | null {
  if (!job.stepStartedAt) return null;
  if (job.status !== 'running' && job.status !== 'verifying') return null;
  return Math.max(0, now - new Date(job.stepStartedAt).getTime());
}

/** What the job is doing, as a short phrase: "deleting files in Radarr". */
export function stepLabel(job: DeletionJob, t: TFunction<'queue'>): string {
  const service = job.service ?? 'Sonarr/Radarr';
  if (job.status === 'verifying') {
    return t('jobs.step.verifying', 'waiting for {{service}} to finish deleting', { service });
  }
  switch (job.step) {
    case 'unmonitor':
      return t('jobs.step.unmonitor', 'unmonitoring in {{service}}', { service });
    case 'delete_files':
      return t('jobs.step.deleteFiles', 'deleting files in {{service}}', { service });
    case 'remove':
      return t('jobs.step.remove', 'removing from {{service}}', { service });
    case 'overseerr_reset':
      return t('jobs.step.resetSeerr', 'resetting in Seerr');
    default:
      return job.status === 'pending' ? t('jobs.step.pending', 'waiting to start') : t('jobs.step.starting', 'starting');
  }
}

/** A step name on its own, for the per-step duration chips. */
export function stepName(step: string, t: TFunction<'queue'>): string {
  switch (step) {
    case 'unmonitor':
      return t('jobs.stepName.unmonitor', 'Unmonitor');
    case 'delete_files':
      return t('jobs.stepName.deleteFiles', 'Delete files');
    case 'remove':
      return t('jobs.stepName.remove', 'Remove');
    case 'overseerr_reset':
      return t('jobs.stepName.resetSeerr', 'Reset in Seerr');
    default:
      return step;
  }
}

export function statusLabel(status: DeletionJobStatus, t: TFunction<'queue'>): string {
  switch (status) {
    case 'pending':
      return t('jobs.status.pending', 'Pending');
    case 'running':
      return t('jobs.status.running', 'Deleting');
    case 'verifying':
      return t('jobs.status.verifying', 'Verifying');
    case 'done':
      return t('jobs.status.done', 'Done');
    case 'reconciled':
      return t('jobs.status.reconciled', 'Already deleted');
    case 'failed':
      return t('jobs.status.failed', 'Failed');
    case 'cancelled':
      return t('jobs.status.cancelled', 'Cancelled');
  }
}

export function isActiveJob(job: DeletionJob | undefined): job is DeletionJob {
  return !!job && (job.status === 'pending' || job.status === 'running' || job.status === 'verifying');
}

/** "2 of 4" for a job inside a Delete All batch; counts the batch's jobs seen so far. */
export function batchPosition(job: DeletionJob, all: DeletionJob[]): { index: number; total: number } | null {
  if (!job.batchId) return null;
  const batch = all.filter((other) => other.batchId === job.batchId).sort((a, b) => a.id - b.id);
  if (batch.length <= 1) return null;
  const finished = batch.filter((other) => other.status !== 'pending' && other.status !== 'running' && other.status !== 'verifying').length;
  return { index: Math.min(batch.length, finished + 1), total: batch.length };
}
