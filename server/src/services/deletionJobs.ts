/**
 * The background deletion worker.
 *
 * Delete Now and Delete All used to run inside the HTTP request, with a modal
 * blocking the app until Sonarr/Radarr had finished — minutes, on NAS-backed
 * storage. Now they create jobs and return at once. This module runs the
 * jobs, one lane per service (Sonarr jobs don't queue behind Radarr jobs),
 * with the per-item work still done by deleteQueueItemNow, so REST, MCP and
 * the scheduler all delete the same way.
 *
 * Job state lives in the deletion_jobs table and is broadcast to the UI as it
 * changes (see routes/deletionJobs.ts for the SSE feed).
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import deletionJobsRepo, {
  ACTIVE_JOB_STATUSES,
  type DeletionJob,
  type DeletionJobPatch,
  type DeletionJobStatus,
  type NewDeletionJob,
} from '../db/repositories/deletionJobs';
import logger from '../utils/logger';
import { holdState } from './availabilityVerdict';
import type { DeletionProgress } from './deletion';
import { getServiceLogs } from './serviceDiagnostics';
import {
  deleteQueueItemNow,
  inspectQueueItem,
  readyQueueIds,
  sendDeletionCompleteNotification,
} from './deletionQueue';

// ============================================================================
// Shapes
// ============================================================================

export type DeletionLane = 'Sonarr' | 'Radarr' | null;

/** The job as the API and the UI see it. */
export interface DeletionJobView {
  id: number;
  queueId: string;
  kind: 'media' | 'episode';
  mediaItemId: number;
  title: string;
  /** 'movie' | 'tv' | 'episode' — the client's naming. */
  type: string;
  service: DeletionLane;
  size: number;
  deletionAction: string;
  resetOverseerr: boolean;
  ruleId: number | null;
  batchId: string | null;
  requestedBy: string;
  status: DeletionJobStatus;
  stage: string | null;
  step: string | null;
  message: string | null;
  stepStartedAt: string | null;
  attempts: number;
  error: string | null;
  upstreamStatus: number | null;
  failedStep: string | null;
  failedService: string | null;
  fileSizeFreed: number | null;
  overseerrReset: boolean | null;
  stepDurationsMs: Record<string, number>;
  /** Lines from the service's own log explaining a failure, newest first. */
  upstreamLog: string[];
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

export interface EnqueueResult {
  ok: true;
  job: DeletionJobView;
  /** A live job already existed for this queue entry; it is the one returned. */
  alreadyQueued: boolean;
}

export interface EnqueueFailure {
  ok: false;
  status: 400 | 404 | 409;
  error: string;
}

export interface BatchEnqueueResult {
  batchId: string;
  queued: DeletionJobView[];
  alreadyQueued: number;
  skipped: Array<{ queueId: string; error: string }>;
}

// ============================================================================
// Configuration
// ============================================================================

function envInt(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? Math.max(min, parsed) : fallback;
}

/** Jobs run at once per service (DELETION_JOB_CONCURRENCY, default 1). */
export function laneConcurrency(): number {
  return envInt('DELETION_JOB_CONCURRENCY', 1, 1);
}

/** Finished jobs are kept this long for the panel's history. */
const FINISHED_RETENTION_DAYS = 7;

// ============================================================================
// Views and events
// ============================================================================

export function toJobView(job: DeletionJob): DeletionJobView {
  let stepDurationsMs: Record<string, number> = {};
  if (job.step_durations) {
    try {
      const parsed = JSON.parse(job.step_durations);
      if (parsed && typeof parsed === 'object') stepDurationsMs = parsed as Record<string, number>;
    } catch {
      /* malformed; leave empty */
    }
  }
  return {
    id: job.id,
    queueId: job.queue_id,
    kind: job.kind,
    mediaItemId: job.media_item_id,
    title: job.title,
    type: job.media_type === 'show' ? 'tv' : job.media_type,
    service: job.service,
    size: job.file_size,
    deletionAction: job.deletion_action,
    resetOverseerr: Boolean(job.reset_overseerr),
    ruleId: job.rule_id,
    batchId: job.batch_id,
    requestedBy: job.requested_by,
    status: job.status,
    stage: job.stage,
    step: job.step,
    message: job.message,
    stepStartedAt: job.step_started_at,
    attempts: job.attempts,
    error: job.error,
    upstreamStatus: job.upstream_status,
    failedStep: job.failed_step,
    failedService: job.failed_service,
    fileSizeFreed: job.file_size_freed,
    overseerrReset: job.overseerr_reset === null ? null : Boolean(job.overseerr_reset),
    stepDurationsMs,
    upstreamLog: parseLines(job.upstream_log),
    createdAt: job.created_at,
    startedAt: job.started_at,
    finishedAt: job.finished_at,
    updatedAt: job.updated_at,
  };
}

function parseLines(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((l): l is string => typeof l === 'string') : [];
  } catch {
    return [];
  }
}

const events = new EventEmitter();
events.setMaxListeners(100);

/** Subscribe to job changes; returns the unsubscribe function. */
export function onDeletionJobChange(listener: (job: DeletionJobView) => void): () => void {
  events.on('job', listener);
  return () => events.off('job', listener);
}

function emit(job: DeletionJob | null): void {
  if (!job) return;
  try {
    events.emit('job', toJobView(job));
  } catch (error) {
    logger.debug(`Deletion job listener failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function patch(id: number, changes: DeletionJobPatch): DeletionJob | null {
  const job = deletionJobsRepo.update(id, changes);
  emit(job);
  return job;
}

// ============================================================================
// Enqueueing
// ============================================================================

export function laneFor(kind: 'media' | 'episode', mediaType: string, item?: { sonarr_id?: number | null; radarr_id?: number | null }): DeletionLane {
  if (kind === 'episode') return 'Sonarr';
  if (item?.sonarr_id) return 'Sonarr';
  if (item?.radarr_id) return 'Radarr';
  if (mediaType === 'show') return 'Sonarr';
  if (mediaType === 'movie') return 'Radarr';
  return null;
}

export interface EnqueueOptions {
  /** Who asked, for the job row and the activity log. */
  actorName: string;
  deletionType?: 'manual' | 'automatic';
  batchId?: string | null;
}

/**
 * Queue one deletion. Returns the existing live job instead of a second one
 * when the entry is already being deleted.
 */
export function enqueueDeleteNow(rawId: string, options: EnqueueOptions): EnqueueResult | EnqueueFailure {
  const inspected = inspectQueueItem(rawId);
  if (!inspected.ok) return { ok: false, status: inspected.status, error: inspected.error };

  const base = {
    queue_id: rawId,
    batch_id: options.batchId ?? null,
    requested_by: options.actorName,
    deletion_type: options.deletionType ?? 'manual',
  };

  let input: NewDeletionJob;
  if (inspected.kind === 'episode') {
    const { row } = inspected;
    input = {
      ...base,
      kind: 'episode',
      media_item_id: row.media_item_id,
      title: inspected.title,
      media_type: 'episode',
      service: 'Sonarr',
      file_size: row.file_size || 0,
      deletion_action: row.deletion_action,
      reset_overseerr: false,
      rule_id: null,
    };
  } else {
    const { item } = inspected;
    // Archive's hold is a hold: an at-risk or unchecked title is not deleted
    // by hand either, until someone archives it or chooses Delete anyway.
    const hold = holdState(item);
    if (hold.held) {
      const why =
        hold.reason === 'unchecked'
          ? 'its re-acquisition check has not run yet'
          : hold.reason === 'unknown'
            ? 'its re-acquisition check could not decide'
            : 'it may not be downloadable again';
      return { ok: false, status: 409, error: `"${item.title}" is held by Archive because ${why}. Archive it, or choose Delete anyway, before deleting it.` };
    }
    const itemAny = item as unknown as Record<string, unknown>;
    input = {
      ...base,
      kind: 'media',
      media_item_id: item.id,
      title: item.title,
      media_type: item.type,
      service: laneFor('media', item.type, item),
      file_size: item.file_size || 0,
      deletion_action: String(itemAny['deletion_action'] ?? 'unmonitor_and_delete'),
      reset_overseerr: Boolean(itemAny['reset_overseerr']),
      rule_id: (itemAny['matched_rule_id'] as number | null | undefined) ?? null,
    };
  }

  const created = deletionJobsRepo.create(input);
  if (!created) {
    const existing = deletionJobsRepo.findActiveByQueueId(rawId);
    if (existing) return { ok: true, job: toJobView(existing), alreadyQueued: true };
    // Lost a race with a job that finished between the insert and the lookup.
    const retried = deletionJobsRepo.create(input);
    if (!retried) return { ok: false, status: 400, error: 'This item is already being deleted' };
    emit(retried);
    schedulePump();
    return { ok: true, job: toJobView(retried), alreadyQueued: false };
  }

  logger.info(`Queued deletion job #${created.id} for "${created.title}" (${created.service ?? 'no service'}, requested by ${options.actorName})`);
  emit(created);
  schedulePump();
  return { ok: true, job: toJobView(created), alreadyQueued: false };
}

/**
 * Queue every item the queue says is due (or everything queued, with
 * `force`), as one batch that gets a single completion notification.
 */
export function enqueueReadyItems(options: { force: boolean; actorName: string }): BatchEnqueueResult {
  const batchId = randomUUID();
  const queued: DeletionJobView[] = [];
  const skipped: Array<{ queueId: string; error: string }> = [];
  let alreadyQueued = 0;

  for (const queueId of readyQueueIds(options.force)) {
    const result = enqueueDeleteNow(queueId, { actorName: options.actorName, batchId });
    if (!result.ok) {
      skipped.push({ queueId, error: result.error });
    } else if (result.alreadyQueued) {
      alreadyQueued += 1;
    } else {
      queued.push(result.job);
    }
  }

  if (queued.length > 0) {
    logger.info(`Queued ${queued.length} deletion job(s) as batch ${batchId} (requested by ${options.actorName})`);
  }
  return { batchId, queued, alreadyQueued, skipped };
}

// ============================================================================
// Controls
// ============================================================================

export function listJobs(recentLimit = 50): { active: DeletionJobView[]; recent: DeletionJobView[] } {
  return {
    active: deletionJobsRepo.listActive().map(toJobView),
    recent: deletionJobsRepo.listFinished(recentLimit).map(toJobView),
  };
}

export function getJob(id: number): DeletionJobView | null {
  const job = deletionJobsRepo.getById(id);
  return job ? toJobView(job) : null;
}

/** Only a job that has not started can be cancelled; a step in flight runs to its end. */
export function cancelJob(id: number): { ok: true; job: DeletionJobView } | { ok: false; status: 404 | 409; error: string } {
  const job = deletionJobsRepo.getById(id);
  if (!job) return { ok: false, status: 404, error: 'Job not found' };
  if (job.status !== 'pending') {
    return {
      ok: false,
      status: 409,
      error:
        job.status === 'running' || job.status === 'verifying'
          ? 'This deletion is already in progress and cannot be cancelled mid-step'
          : 'This job has already finished',
    };
  }
  const updated = patch(id, {
    status: 'cancelled',
    message: 'Cancelled before it started',
    finished_at: new Date().toISOString(),
  })!;
  logger.info(`Cancelled deletion job #${id} for "${job.title}"`);
  return { ok: true, job: toJobView(updated) };
}

/** Put a failed or cancelled job back in line. Its attempt count carries over. */
export function retryJob(id: number): { ok: true; job: DeletionJobView } | { ok: false; status: 404 | 409; error: string } {
  const job = deletionJobsRepo.getById(id);
  if (!job) return { ok: false, status: 404, error: 'Job not found' };
  if (job.status !== 'failed' && job.status !== 'cancelled') {
    return { ok: false, status: 409, error: 'Only a failed or cancelled job can be retried' };
  }
  const inspected = inspectQueueItem(job.queue_id);
  if (!inspected.ok) return { ok: false, status: 409, error: inspected.error };
  if (deletionJobsRepo.findActiveByQueueId(job.queue_id)) {
    return { ok: false, status: 409, error: 'This item is already being deleted' };
  }
  const updated = patch(id, {
    status: 'pending',
    stage: null,
    step: null,
    step_started_at: null,
    message: 'Retrying',
    error: null,
    upstream_status: null,
    failed_step: null,
    failed_service: null,
    finished_at: null,
  })!;
  logger.info(`Retrying deletion job #${id} for "${job.title}"`);
  schedulePump();
  return { ok: true, job: toJobView(updated) };
}

export function clearFinishedJobs(): number {
  const removed = deletionJobsRepo.deleteFinished();
  events.emit('cleared');
  return removed;
}

export function onDeletionJobsCleared(listener: () => void): () => void {
  events.on('cleared', listener);
  return () => events.off('cleared', listener);
}

/**
 * Media items a scheduled run must leave alone because a job owns them. Never
 * throws: a scheduled run should not fail because this table can't be read.
 */
export function activeJobMediaItemIds(): Set<number> {
  try {
    return deletionJobsRepo.activeMediaItemIds();
  } catch (error) {
    logger.debug(`Could not read active deletion jobs: ${error instanceof Error ? error.message : String(error)}`);
    return new Set();
  }
}

/**
 * Resolve once no job is pending, running or verifying (or the timeout
 * passes). For tests and for shutdown logging.
 */
export async function waitForDeletionJobsIdle(timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (deletionJobsRepo.listActive().length === 0 && runningDeletionJobCount() === 0) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// ============================================================================
// The worker
// ============================================================================

const LANES: DeletionLane[] = ['Sonarr', 'Radarr', null];
const runningPerLane = new Map<DeletionLane, number>();
let stopped = true;
let pumpScheduled = false;
const notifiedBatches = new Set<string>();

function schedulePump(): void {
  if (stopped || pumpScheduled) return;
  pumpScheduled = true;
  setImmediate(() => {
    pumpScheduled = false;
    pump();
  });
}

function pump(): void {
  if (stopped) return;
  const limit = laneConcurrency();
  for (const lane of LANES) {
    while ((runningPerLane.get(lane) ?? 0) < limit) {
      const job = deletionJobsRepo.claimNextPending(lane);
      if (!job) break;
      runningPerLane.set(lane, (runningPerLane.get(lane) ?? 0) + 1);
      emit(job);
      void runJob(job).finally(() => {
        runningPerLane.set(lane, Math.max(0, (runningPerLane.get(lane) ?? 1) - 1));
        schedulePump();
      });
    }
  }
}

/** One line for the job list: what happened, in terms of files, not of records. */
export function jobDoneMessage(
  result: { reconciled?: boolean; filesDeleted?: boolean; leftOnDisk?: string; fileSizeFreedFormatted: string; deletionAction: string },
  service: string | null | undefined
): string {
  const app = service ?? 'Sonarr/Radarr';
  if (result.reconciled) return `Already deleted in ${app}; removed from the queue`;
  if (result.leftOnDisk) return `${app} reported the delete but ${result.leftOnDisk} is still on disk; nothing freed`;
  if (result.deletionAction === 'unmonitor_only') return `Unmonitored in ${app}`;
  if (result.filesDeleted === false) return `${app} had no file to delete; removed from the catalogue, nothing freed`;
  return `Deleted, ${result.fileSizeFreedFormatted} freed`;
}

async function runJob(job: DeletionJob): Promise<void> {
  const id = job.id;
  let currentStep: string | null = null;
  let lastWrite = 0;

  const onProgress = (progress: DeletionProgress): void => {
    const changes: DeletionJobPatch = {
      stage: progress.stage,
      message: progress.message,
      status: progress.stage === 'verifying' ? 'verifying' : 'running',
    };
    if (progress.step && progress.step !== currentStep) {
      currentStep = progress.step;
      changes.step = progress.step;
      changes.step_started_at = new Date().toISOString();
    }
    // File-by-file events can arrive in bursts; a step change or a stage
    // change is always written, plain progress at most a few times a second.
    const now = Date.now();
    const important = changes.step !== undefined || progress.stage === 'verifying' || progress.stage === 'complete' || progress.stage === 'error';
    if (!important && now - lastWrite < 250) return;
    lastWrite = now;
    if (progress.stage === 'complete' || progress.stage === 'error') return; // the result write below covers these
    patch(id, changes);
  };

  try {
    const result = await deleteQueueItemNow(job.queue_id, {
      deletionType: job.deletion_type,
      actorName: job.requested_by,
      // Batches get one summary notification at the end instead of one per item.
      notify: !job.batch_id,
      onProgress,
    });

    if (result.ok) {
      const status: DeletionJobStatus = result.reconciled ? 'reconciled' : 'done';
      patch(id, {
        status,
        stage: 'complete',
        step: null,
        message: jobDoneMessage(result, job.service),
        file_size_freed: result.fileSizeFreed,
        overseerr_reset: result.overseerrReset === undefined ? null : result.overseerrReset ? 1 : 0,
        step_durations: JSON.stringify(result.stepDurationsMs ?? {}),
        finished_at: new Date().toISOString(),
      });
      logger.info(`Deletion job #${id} ${status}: "${job.title}"`);
    } else {
      const upstreamLog = await upstreamLogFor(job, result.service ?? job.service);
      patch(id, {
        status: 'failed',
        stage: 'error',
        message: result.error,
        error: result.error,
        upstream_status: result.upstreamStatus ?? null,
        failed_step: result.step ?? null,
        failed_service: result.service ?? null,
        step_durations: JSON.stringify(result.stepDurationsMs ?? {}),
        upstream_log: upstreamLog.length > 0 ? JSON.stringify(upstreamLog) : null,
        finished_at: new Date().toISOString(),
      });
      logger.error(`Deletion job #${id} failed: "${job.title}": ${result.error}${upstreamLog.length > 0 ? ` | ${job.service} log: ${upstreamLog[0]}` : ''}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    patch(id, {
      status: 'failed',
      stage: 'error',
      message,
      error: message,
      finished_at: new Date().toISOString(),
    });
    logger.error(`Deletion job #${id} crashed: "${job.title}": ${message}`);
  }

  if (job.batch_id) await finishBatchIfDone(job.batch_id);
}

/**
 * What Sonarr/Radarr logged (warnings and errors) since the job started that
 * mentions the item, so a failed job carries the real reason, not just
 * "timed out". Never throws; no log means an empty list.
 */
async function upstreamLogFor(job: DeletionJob, service: string | null): Promise<string[]> {
  if (service !== 'Sonarr' && service !== 'Radarr') return [];
  try {
    const since = job.started_at ? new Date(job.started_at) : new Date(Date.now() - 60 * 60 * 1000);
    const { lines } = await getServiceLogs(service === 'Sonarr' ? 'sonarr' : 'radarr', { level: 'warn', limit: 100, since });
    const needles = [job.title.toLowerCase()];
    const mentioned = lines.filter((line) => needles.some((n) => line.toLowerCase().includes(n)));
    const picked = mentioned.length > 0 ? mentioned : lines.filter((line) => /delet|recycl|DiskTransfer/i.test(line));
    return picked.slice(0, 8);
  } catch (error) {
    logger.debug(`Could not read the ${service} log for job #${job.id}: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

/** One DELETION_COMPLETE notification per Delete All, once its last job ends. */
async function finishBatchIfDone(batchId: string): Promise<void> {
  if (notifiedBatches.has(batchId)) return;
  const jobs = deletionJobsRepo.listByBatch(batchId);
  if (jobs.some((j) => (ACTIVE_JOB_STATUSES as readonly string[]).includes(j.status))) return;
  notifiedBatches.add(batchId);

  const done = jobs.filter((j) => j.status === 'done');
  const failed = jobs.filter((j) => j.status === 'failed').length;
  const freed = done.reduce((sum, j) => sum + (j.file_size_freed || 0), 0);
  logger.info(`Deletion batch ${batchId} finished: ${done.length} deleted, ${jobs.filter((j) => j.status === 'reconciled').length} reconciled, ${failed} failed`);
  await sendDeletionCompleteNotification(
    done.map((j) => ({ title: j.title, type: j.media_type, ruleId: j.rule_id })),
    freed,
    failed
  );
}

/**
 * Start the worker: resume anything interrupted by the last shutdown, drop
 * stale history, and run whatever is pending.
 */
export function startDeletionJobWorker(): void {
  stopped = false;
  const resumed = deletionJobsRepo.requeueInterrupted();
  if (resumed.length > 0) {
    logger.warn(`Resuming ${resumed.length} deletion job(s) interrupted by the last shutdown: ${resumed.map((j) => `"${j.title}"`).join(', ')}`);
    resumed.forEach(emit);
  }
  const purged = deletionJobsRepo.deleteFinished(FINISHED_RETENTION_DAYS);
  if (purged > 0) logger.debug(`Purged ${purged} finished deletion job(s) older than ${FINISHED_RETENTION_DAYS} days`);
  schedulePump();
}

/** Stop claiming new jobs; running ones finish on their own (or resume after restart). */
export function stopDeletionJobWorker(): void {
  stopped = true;
}

/** How many jobs are running right now, for shutdown logging. */
export function runningDeletionJobCount(): number {
  let total = 0;
  for (const count of runningPerLane.values()) total += count;
  return total;
}
