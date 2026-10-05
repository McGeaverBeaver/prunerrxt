/**
 * Bulk work on unmanaged folders, in the background.
 *
 * Selecting a few hundred folders and choosing delete, import or fix
 * permissions would be minutes of work; nothing should wait on it. Each
 * selection becomes a batch of jobs, one per folder, run here one at a time
 * per service (a Sonarr folder never waits behind a Radarr one), with the
 * per-folder work still done by orphanFolders.ts so REST, MCP and the bulk
 * path all behave the same. Job rows live in folder_jobs and are pushed to
 * the UI as they change (routes/folders.ts, the jobs stream).
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import folderJobsRepo, {
  ACTIVE_FOLDER_JOB_STATUSES,
  type FolderJob,
  type FolderJobAction,
  type FolderJobPatch,
  type FolderJobStatus,
} from '../db/repositories/folderJobs';
import logger from '../utils/logger';
import { formatBytes } from '../utils/format';
import { deleteFolder, fixFolderPermissions, importFolder, listOrphanFolders, type OrphanFolder, type OrphanService } from './orphanFolders';

// ============================================================================
// Shapes
// ============================================================================

export interface FolderJobView {
  id: number;
  batchId: string;
  folderId: string;
  service: OrphanService;
  serviceLabel: 'Sonarr' | 'Radarr';
  name: string;
  path: string;
  sizeBytes: number | null;
  action: FolderJobAction;
  params: FolderJobParams;
  requestedBy: string;
  status: FolderJobStatus;
  message: string | null;
  error: string | null;
  result: Record<string, unknown> | null;
  attempts: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

export interface FolderJobParams {
  /** import: the chosen tmdb/tvdb id; absent means match automatically. */
  candidateId?: number;
  qualityProfileId?: number;
  monitored?: boolean;
}

export interface FolderBatchRequest {
  action: FolderJobAction;
  /** Folder ids, with optional per-folder parameters (an import's candidate). */
  folders: Array<{ id: string; params?: FolderJobParams }>;
  /** Parameters applied to every folder that has none of its own. */
  params?: FolderJobParams;
  actorName: string;
}

export interface FolderBatchResult {
  batchId: string;
  queued: FolderJobView[];
  /** Folders that already had a live job; left as they were. */
  alreadyQueued: number;
  skipped: Array<{ id: string; error: string }>;
}

export interface FolderBatchSummary {
  batchId: string;
  action: FolderJobAction;
  requestedBy: string;
  total: number;
  pending: number;
  running: number;
  done: number;
  failed: number;
  cancelled: number;
  /** For deletes: bytes freed so far. */
  freedBytes: number;
  createdAt: string;
  finishedAt: string | null;
}

// ============================================================================
// Views and events
// ============================================================================

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

export function toFolderJobView(job: FolderJob): FolderJobView {
  return {
    id: job.id,
    batchId: job.batch_id,
    folderId: job.folder_id,
    service: job.service,
    serviceLabel: job.service === 'sonarr' ? 'Sonarr' : 'Radarr',
    name: job.folder_name,
    path: job.folder_path,
    sizeBytes: job.size_bytes,
    action: job.action,
    params: parseJson<FolderJobParams>(job.params, {}),
    requestedBy: job.requested_by,
    status: job.status,
    message: job.message,
    error: job.error,
    result: parseJson<Record<string, unknown> | null>(job.result, null),
    attempts: job.attempts,
    createdAt: job.created_at,
    startedAt: job.started_at,
    finishedAt: job.finished_at,
    updatedAt: job.updated_at,
  };
}

const events = new EventEmitter();
events.setMaxListeners(100);

export function onFolderJobChange(listener: (job: FolderJobView) => void): () => void {
  events.on('job', listener);
  return () => events.off('job', listener);
}

export function onFolderJobsCleared(listener: () => void): () => void {
  events.on('cleared', listener);
  return () => events.off('cleared', listener);
}

function emit(job: FolderJob | null): void {
  if (!job) return;
  try {
    events.emit('job', toFolderJobView(job));
  } catch (error) {
    logger.debug(`Folder job listener failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function patch(id: number, changes: FolderJobPatch): FolderJob | null {
  const job = folderJobsRepo.update(id, changes);
  emit(job);
  return job;
}

// ============================================================================
// Enqueueing
// ============================================================================

const ACTION_LABEL: Record<FolderJobAction, string> = {
  delete: 'delete',
  import: 'import',
  fix_permissions: 'fix permissions on',
};

/**
 * Queue one batch. Every folder is checked against the current listing: an
 * id that is no longer unmanaged, or a delete without a folder mapping, is
 * reported in `skipped` rather than failing later.
 */
export async function enqueueFolderBatch(request: FolderBatchRequest): Promise<FolderBatchResult> {
  const listing = await listOrphanFolders({ includeIgnored: true });
  const byId = new Map(listing.folders.map((f) => [f.id, f]));
  const batchId = randomUUID();
  const queued: FolderJobView[] = [];
  const skipped: Array<{ id: string; error: string }> = [];
  let alreadyQueued = 0;
  const seen = new Set<string>();

  for (const entry of request.folders) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    const folder = byId.get(entry.id);
    if (!folder) {
      skipped.push({ id: entry.id, error: 'Folder not found (it may have been imported or removed; refresh the list)' });
      continue;
    }
    const problem = precheck(request.action, folder);
    if (problem) {
      skipped.push({ id: entry.id, error: problem });
      continue;
    }
    const params = { ...(request.params ?? {}), ...(entry.params ?? {}) };
    const created = folderJobsRepo.create({
      batch_id: batchId,
      folder_id: folder.id,
      service: folder.service,
      folder_name: folder.name,
      folder_path: folder.path,
      size_bytes: folder.sizeBytes,
      action: request.action,
      params: Object.keys(params).length > 0 ? JSON.stringify(params) : null,
      requested_by: request.actorName,
    });
    if (!created) {
      alreadyQueued += 1;
      continue;
    }
    emit(created);
    queued.push(toFolderJobView(created));
  }

  if (queued.length > 0) {
    logger.info(`Queued ${queued.length} folder job(s) to ${ACTION_LABEL[request.action]} unmanaged folders as batch ${batchId} (requested by ${request.actorName})`);
    schedulePump();
  }
  return { batchId, queued, alreadyQueued, skipped };
}

function precheck(action: FolderJobAction, folder: OrphanFolder): string | null {
  if ((action === 'delete' || action === 'fix_permissions') && !folder.localPath) {
    return `No folder mapping covers ${folder.path}; add one in Settings so PrunerrXT can reach the files`;
  }
  if (action === 'delete' && !folder.canDelete) {
    return `${folder.localPath} does not exist on PrunerrXT's side; check the mapping`;
  }
  return null;
}

// ============================================================================
// Reading and controls
// ============================================================================

export function listFolderJobs(recentLimit = 100): { active: FolderJobView[]; recent: FolderJobView[]; batches: FolderBatchSummary[] } {
  const active = folderJobsRepo.listActive().map(toFolderJobView);
  const recent = folderJobsRepo.listFinished(recentLimit).map(toFolderJobView);
  return { active, recent, batches: summariseBatches([...active, ...recent]) };
}

export function summariseBatches(jobs: FolderJobView[]): FolderBatchSummary[] {
  const byBatch = new Map<string, FolderBatchSummary>();
  for (const job of jobs) {
    let summary = byBatch.get(job.batchId);
    if (!summary) {
      summary = { batchId: job.batchId, action: job.action, requestedBy: job.requestedBy, total: 0, pending: 0, running: 0, done: 0, failed: 0, cancelled: 0, freedBytes: 0, createdAt: job.createdAt, finishedAt: null };
      byBatch.set(job.batchId, summary);
    }
    summary.total += 1;
    summary[job.status] += 1;
    if (job.createdAt < summary.createdAt) summary.createdAt = job.createdAt;
    if (job.status === 'done' && job.action === 'delete') summary.freedBytes += Number(job.result?.['sizeBytes'] ?? 0);
  }
  for (const summary of byBatch.values()) {
    if (summary.pending === 0 && summary.running === 0) {
      summary.finishedAt = jobs
        .filter((j) => j.batchId === summary.batchId)
        .reduce<string | null>((latest, j) => (j.finishedAt && (!latest || j.finishedAt > latest) ? j.finishedAt : latest), null);
    }
  }
  return [...byBatch.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getFolderJob(id: number): FolderJobView | null {
  const job = folderJobsRepo.getById(id);
  return job ? toFolderJobView(job) : null;
}

export function cancelFolderJob(id: number): { ok: true; job: FolderJobView } | { ok: false; status: 404 | 409; error: string } {
  const job = folderJobsRepo.getById(id);
  if (!job) return { ok: false, status: 404, error: 'Job not found' };
  if (job.status !== 'pending') {
    return { ok: false, status: 409, error: job.status === 'running' ? 'This job is already running and cannot be cancelled mid-way' : 'This job has already finished' };
  }
  const updated = patch(id, { status: 'cancelled', message: 'Cancelled before it started', finished_at: new Date().toISOString() })!;
  return { ok: true, job: toFolderJobView(updated) };
}

/** Stop the rest of a batch; the job running right now finishes on its own. */
export function cancelFolderBatch(batchId: string): { cancelled: number } {
  const cancelled = folderJobsRepo.cancelPendingInBatch(batchId);
  if (cancelled > 0) {
    logger.info(`Cancelled ${cancelled} pending folder job(s) in batch ${batchId}`);
    for (const job of folderJobsRepo.listByBatch(batchId)) if (job.status === 'cancelled') emit(job);
  }
  return { cancelled };
}

export function retryFolderJob(id: number): { ok: true; job: FolderJobView } | { ok: false; status: 404 | 409; error: string } {
  const job = folderJobsRepo.getById(id);
  if (!job) return { ok: false, status: 404, error: 'Job not found' };
  if (job.status !== 'failed' && job.status !== 'cancelled') return { ok: false, status: 409, error: 'Only a failed or cancelled job can be retried' };
  if (folderJobsRepo.findActiveByFolderId(job.folder_id)) return { ok: false, status: 409, error: 'This folder already has a job in progress' };
  const updated = patch(id, { status: 'pending', message: 'Retrying', error: null, result: null, finished_at: null })!;
  schedulePump();
  return { ok: true, job: toFolderJobView(updated) };
}

export function clearFinishedFolderJobs(): number {
  const removed = folderJobsRepo.deleteFinished();
  events.emit('cleared');
  return removed;
}

/** Folder ids with a live job, so the list can show them as busy. */
export function activeFolderJobIds(): Set<string> {
  try {
    return new Set(folderJobsRepo.listActive().map((j) => j.folder_id));
  } catch {
    return new Set();
  }
}

export async function waitForFolderJobsIdle(timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (folderJobsRepo.listActive().length === 0 && runningFolderJobCount() === 0) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// ============================================================================
// The worker
// ============================================================================

const LANES: OrphanService[] = ['radarr', 'sonarr'];
const runningPerLane = new Map<OrphanService, number>();
let stopped = true;
let pumpScheduled = false;

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
  for (const lane of LANES) {
    while ((runningPerLane.get(lane) ?? 0) < 1) {
      const job = folderJobsRepo.claimNextPending(lane);
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

async function runJob(job: FolderJob): Promise<void> {
  const params = parseJson<FolderJobParams>(job.params, {});
  const actor = job.requested_by;
  try {
    let message: string;
    let result: Record<string, unknown>;
    if (job.action === 'delete') {
      patch(job.id, { message: 'Deleting' });
      const outcome = await deleteFolder(job.folder_id, { actorName: actor });
      result = { sizeBytes: outcome.sizeBytes, fileCount: outcome.fileCount };
      message = `Deleted, ${formatBytes(outcome.sizeBytes)} freed`;
    } else if (job.action === 'import') {
      patch(job.id, { message: params.candidateId ? 'Importing' : 'Matching and importing' });
      const outcome = await importFolder(job.folder_id, { candidateId: params.candidateId, qualityProfileId: params.qualityProfileId, monitored: params.monitored, actorName: actor });
      result = { addedId: outcome.addedId, title: outcome.title, year: outcome.year };
      message = `Imported as "${outcome.title}"${outcome.year ? ` (${outcome.year})` : ''}`;
    } else {
      patch(job.id, { message: 'Fixing ownership and modes' });
      const outcome = await fixFolderPermissions(job.folder_id, { actorName: actor });
      result = { changed: outcome.result.changed, unchanged: outcome.result.unchanged, failed: outcome.result.failed.length };
      if (outcome.result.failed.length > 0) {
        throw new Error(`${outcome.result.failed.length} entries could not be changed: ${outcome.result.failed[0]!.error}`);
      }
      message = `${outcome.result.changed} entries fixed, ${outcome.result.unchanged} already right`;
    }
    patch(job.id, { status: 'done', message, result: JSON.stringify(result), finished_at: new Date().toISOString() });
    logger.info(`Folder job #${job.id} done (${job.action} "${job.folder_name}"): ${message}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    patch(job.id, { status: 'failed', message, error: message, finished_at: new Date().toISOString() });
    logger.error(`Folder job #${job.id} failed (${job.action} "${job.folder_name}"): ${message}`);
  }
  finishBatchIfDone(job.batch_id);
}

const loggedBatches = new Set<string>();

function finishBatchIfDone(batchId: string): void {
  if (loggedBatches.has(batchId)) return;
  const jobs = folderJobsRepo.listByBatch(batchId);
  if (jobs.some((j) => (ACTIVE_FOLDER_JOB_STATUSES as readonly string[]).includes(j.status))) return;
  loggedBatches.add(batchId);
  const [summary] = summariseBatches(jobs.map(toFolderJobView));
  if (summary) {
    logger.info(
      `Folder batch ${batchId} (${summary.action}) finished: ${summary.done} done, ${summary.failed} failed, ${summary.cancelled} cancelled${summary.action === 'delete' ? `, ${formatBytes(summary.freedBytes)} freed` : ''}`
    );
  }
}

const FINISHED_RETENTION_DAYS = 7;

export function startFolderJobWorker(): void {
  stopped = false;
  const resumed = folderJobsRepo.requeueInterrupted();
  if (resumed.length > 0) {
    logger.warn(`Resuming ${resumed.length} folder job(s) interrupted by the last shutdown`);
    resumed.forEach(emit);
  }
  const purged = folderJobsRepo.deleteFinished(FINISHED_RETENTION_DAYS);
  if (purged > 0) logger.debug(`Purged ${purged} finished folder job(s) older than ${FINISHED_RETENTION_DAYS} days`);
  schedulePump();
}

export function stopFolderJobWorker(): void {
  stopped = true;
}

export function runningFolderJobCount(): number {
  let total = 0;
  for (const count of runningPerLane.values()) total += count;
  return total;
}
