import { getDatabase } from '../index';

/**
 * Background deletion jobs.
 *
 * Delete Now and Delete All create one row per queue entry and hand it to the
 * worker in services/deletionJobs.ts. The row is the source of truth for the
 * UI (status, step, elapsed, outcome) and survives restarts, so a deletion
 * that was running when the container stopped is resumed, not lost.
 */
export type DeletionJobStatus =
  | 'pending'
  | 'running'
  | 'verifying'
  | 'done'
  | 'reconciled'
  | 'failed'
  | 'cancelled';

export const ACTIVE_JOB_STATUSES: readonly DeletionJobStatus[] = ['pending', 'running', 'verifying'];
export const FINISHED_JOB_STATUSES: readonly DeletionJobStatus[] = ['done', 'reconciled', 'failed', 'cancelled'];

export interface DeletionJob {
  id: number;
  /** Queue id: a media item id, or `ep-<id>` for a queued episode. */
  queue_id: string;
  kind: 'media' | 'episode';
  media_item_id: number;
  title: string;
  media_type: string;
  /** The lane the job runs in: the service it will talk to. */
  service: 'Sonarr' | 'Radarr' | null;
  file_size: number;
  deletion_action: string;
  reset_overseerr: number;
  rule_id: number | null;
  /** Groups the jobs of one Delete All, for a single summary notification. */
  batch_id: string | null;
  requested_by: string;
  deletion_type: 'manual' | 'automatic';
  status: DeletionJobStatus;
  stage: string | null;
  step: string | null;
  message: string | null;
  step_started_at: string | null;
  attempts: number;
  error: string | null;
  upstream_status: number | null;
  failed_step: string | null;
  failed_service: string | null;
  file_size_freed: number | null;
  overseerr_reset: number | null;
  /** JSON: { step: ms } */
  step_durations: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

export interface NewDeletionJob {
  queue_id: string;
  kind: 'media' | 'episode';
  media_item_id: number;
  title: string;
  media_type: string;
  service: 'Sonarr' | 'Radarr' | null;
  file_size: number;
  deletion_action: string;
  reset_overseerr: boolean;
  rule_id: number | null;
  batch_id: string | null;
  requested_by: string;
  deletion_type: 'manual' | 'automatic';
}

export type DeletionJobPatch = Partial<
  Pick<
    DeletionJob,
    | 'status'
    | 'stage'
    | 'step'
    | 'message'
    | 'step_started_at'
    | 'attempts'
    | 'error'
    | 'upstream_status'
    | 'failed_step'
    | 'failed_service'
    | 'file_size_freed'
    | 'overseerr_reset'
    | 'step_durations'
    | 'started_at'
    | 'finished_at'
  >
>;

const activeList = ACTIVE_JOB_STATUSES.map((s) => `'${s}'`).join(', ');
const finishedList = FINISHED_JOB_STATUSES.map((s) => `'${s}'`).join(', ');

/**
 * Create a job unless one is already live for the same queue entry. The
 * partial unique index is the lock, so two clicks (or a click during a
 * running batch) can never produce two deletions of one item.
 */
export function create(input: NewDeletionJob): DeletionJob | null {
  const db = getDatabase();
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO deletion_jobs
         (queue_id, kind, media_item_id, title, media_type, service, file_size, deletion_action,
          reset_overseerr, rule_id, batch_id, requested_by, deletion_type, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
    )
    .run(
      input.queue_id,
      input.kind,
      input.media_item_id,
      input.title,
      input.media_type,
      input.service,
      input.file_size,
      input.deletion_action,
      input.reset_overseerr ? 1 : 0,
      input.rule_id,
      input.batch_id,
      input.requested_by,
      input.deletion_type,
      now,
      now
    );
  if (result.changes === 0) return null;
  return getById(Number(result.lastInsertRowid));
}

export function getById(id: number): DeletionJob | null {
  const row = getDatabase().prepare('SELECT * FROM deletion_jobs WHERE id = ?').get(id) as DeletionJob | undefined;
  return row ?? null;
}

export function findActiveByQueueId(queueId: string): DeletionJob | null {
  const row = getDatabase()
    .prepare(`SELECT * FROM deletion_jobs WHERE queue_id = ? AND status IN (${activeList}) LIMIT 1`)
    .get(queueId) as DeletionJob | undefined;
  return row ?? null;
}

export function listActive(): DeletionJob[] {
  return getDatabase()
    .prepare(`SELECT * FROM deletion_jobs WHERE status IN (${activeList}) ORDER BY created_at ASC, id ASC`)
    .all() as DeletionJob[];
}

export function listFinished(limit: number): DeletionJob[] {
  return getDatabase()
    .prepare(`SELECT * FROM deletion_jobs WHERE status IN (${finishedList}) ORDER BY finished_at DESC, id DESC LIMIT ?`)
    .all(limit) as DeletionJob[];
}

export function listByBatch(batchId: string): DeletionJob[] {
  return getDatabase()
    .prepare('SELECT * FROM deletion_jobs WHERE batch_id = ? ORDER BY id ASC')
    .all(batchId) as DeletionJob[];
}

export function update(id: number, patch: DeletionJobPatch): DeletionJob | null {
  const keys = Object.keys(patch) as Array<keyof DeletionJobPatch>;
  if (keys.length === 0) return getById(id);
  const sets = keys.map((key) => `${key} = ?`);
  const values = keys.map((key) => patch[key] ?? null);
  getDatabase()
    .prepare(`UPDATE deletion_jobs SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`)
    .run(...values, new Date().toISOString(), id);
  return getById(id);
}

/**
 * Atomically take the oldest pending job for a lane and mark it running.
 * `service` null claims jobs with no lane (items not linked to either app).
 */
export function claimNextPending(service: 'Sonarr' | 'Radarr' | null): DeletionJob | null {
  const db = getDatabase();
  const now = new Date().toISOString();
  const claim = db.transaction(() => {
    const row = db
      .prepare(
        service === null
          ? `SELECT id FROM deletion_jobs WHERE status = 'pending' AND service IS NULL ORDER BY created_at ASC, id ASC LIMIT 1`
          : `SELECT id FROM deletion_jobs WHERE status = 'pending' AND service = ? ORDER BY created_at ASC, id ASC LIMIT 1`
      )
      .get(...(service === null ? [] : [service])) as { id: number } | undefined;
    if (!row) return null;
    db.prepare(
      `UPDATE deletion_jobs
         SET status = 'running', started_at = ?, finished_at = NULL, error = NULL, upstream_status = NULL,
             failed_step = NULL, failed_service = NULL, attempts = attempts + 1, updated_at = ?
       WHERE id = ? AND status = 'pending'`
    ).run(now, now, row.id);
    return getById(row.id);
  });
  return claim();
}

/** Media items with a live job, so a scheduled run leaves them alone. */
export function activeMediaItemIds(): Set<number> {
  const rows = getDatabase()
    .prepare(`SELECT DISTINCT media_item_id FROM deletion_jobs WHERE status IN (${activeList})`)
    .all() as Array<{ media_item_id: number }>;
  return new Set(rows.map((r) => r.media_item_id));
}

/**
 * Put jobs that were mid-flight when the process stopped back in line. The
 * deletion steps are idempotent (an already-unmonitored item is skipped, a
 * file Sonarr/Radarr no longer has counts as deleted), so re-running is safe.
 */
export function requeueInterrupted(): DeletionJob[] {
  const db = getDatabase();
  const now = new Date().toISOString();
  const rows = db
    .prepare(`SELECT * FROM deletion_jobs WHERE status IN ('running', 'verifying')`)
    .all() as DeletionJob[];
  if (rows.length === 0) return [];
  db.prepare(
    `UPDATE deletion_jobs
       SET status = 'pending', stage = NULL, step = NULL, step_started_at = NULL,
           message = 'Resumed after Prunerr restarted', updated_at = ?
     WHERE status IN ('running', 'verifying')`
  ).run(now);
  return rows.map((row) => getById(row.id)!).filter(Boolean);
}

/** Drop finished jobs: the "Clear" button, and housekeeping for old rows. */
export function deleteFinished(olderThanDays?: number): number {
  const db = getDatabase();
  if (olderThanDays === undefined) {
    return db.prepare(`DELETE FROM deletion_jobs WHERE status IN (${finishedList})`).run().changes;
  }
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
  return db
    .prepare(`DELETE FROM deletion_jobs WHERE status IN (${finishedList}) AND finished_at < ?`)
    .run(cutoff).changes;
}

export default {
  create,
  getById,
  findActiveByQueueId,
  listActive,
  listFinished,
  listByBatch,
  update,
  claimNextPending,
  activeMediaItemIds,
  requeueInterrupted,
  deleteFinished,
};
