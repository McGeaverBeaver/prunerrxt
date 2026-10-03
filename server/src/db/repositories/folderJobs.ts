import { getDatabase } from '../index';

/**
 * Background jobs on unmanaged folders.
 *
 * Selecting many folders on the Folders page and choosing delete, import or
 * fix permissions creates one row per folder as a batch; the worker in
 * services/folderJobs.ts runs them. The row is what the UI follows, and it
 * survives restarts so a half-finished batch continues after a container
 * update instead of being lost.
 */
export type FolderJobStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
export type FolderJobAction = 'delete' | 'import' | 'fix_permissions';

export const ACTIVE_FOLDER_JOB_STATUSES: readonly FolderJobStatus[] = ['pending', 'running'];
export const FINISHED_FOLDER_JOB_STATUSES: readonly FolderJobStatus[] = ['done', 'failed', 'cancelled'];

export interface FolderJob {
  id: number;
  batch_id: string;
  folder_id: string;
  service: 'sonarr' | 'radarr';
  folder_name: string;
  folder_path: string;
  size_bytes: number | null;
  action: FolderJobAction;
  /** JSON: action parameters (import: candidateId, qualityProfileId, monitored). */
  params: string | null;
  requested_by: string;
  status: FolderJobStatus;
  message: string | null;
  error: string | null;
  /** JSON: what the action produced (freed bytes, added id, entries changed). */
  result: string | null;
  attempts: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

export interface NewFolderJob {
  batch_id: string;
  folder_id: string;
  service: 'sonarr' | 'radarr';
  folder_name: string;
  folder_path: string;
  size_bytes: number | null;
  action: FolderJobAction;
  params: string | null;
  requested_by: string;
}

export type FolderJobPatch = Partial<Pick<FolderJob, 'status' | 'message' | 'error' | 'result' | 'params' | 'started_at' | 'finished_at'>>;

const activeList = ACTIVE_FOLDER_JOB_STATUSES.map((s) => `'${s}'`).join(', ');
const finishedList = FINISHED_FOLDER_JOB_STATUSES.map((s) => `'${s}'`).join(', ');

/** Create a job unless one is already live for the folder (the unique index is the lock). */
export function create(input: NewFolderJob): FolderJob | null {
  const now = new Date().toISOString();
  const result = getDatabase()
    .prepare(
      `INSERT OR IGNORE INTO folder_jobs
         (batch_id, folder_id, service, folder_name, folder_path, size_bytes, action, params, requested_by, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
    )
    .run(input.batch_id, input.folder_id, input.service, input.folder_name, input.folder_path, input.size_bytes, input.action, input.params, input.requested_by, now, now);
  if (result.changes === 0) return null;
  return getById(Number(result.lastInsertRowid));
}

export function getById(id: number): FolderJob | null {
  const row = getDatabase().prepare('SELECT * FROM folder_jobs WHERE id = ?').get(id) as FolderJob | undefined;
  return row ?? null;
}

export function findActiveByFolderId(folderId: string): FolderJob | null {
  const row = getDatabase()
    .prepare(`SELECT * FROM folder_jobs WHERE folder_id = ? AND status IN (${activeList}) LIMIT 1`)
    .get(folderId) as FolderJob | undefined;
  return row ?? null;
}

export function listActive(): FolderJob[] {
  return getDatabase()
    .prepare(`SELECT * FROM folder_jobs WHERE status IN (${activeList}) ORDER BY created_at ASC, id ASC`)
    .all() as FolderJob[];
}

export function listFinished(limit: number): FolderJob[] {
  return getDatabase()
    .prepare(`SELECT * FROM folder_jobs WHERE status IN (${finishedList}) ORDER BY finished_at DESC, id DESC LIMIT ?`)
    .all(limit) as FolderJob[];
}

export function listByBatch(batchId: string): FolderJob[] {
  return getDatabase().prepare('SELECT * FROM folder_jobs WHERE batch_id = ? ORDER BY id ASC').all(batchId) as FolderJob[];
}

export function update(id: number, patch: FolderJobPatch): FolderJob | null {
  const keys = Object.keys(patch) as Array<keyof FolderJobPatch>;
  if (keys.length === 0) return getById(id);
  const sets = keys.map((key) => `${key} = ?`);
  const values = keys.map((key) => patch[key] ?? null);
  getDatabase()
    .prepare(`UPDATE folder_jobs SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`)
    .run(...values, new Date().toISOString(), id);
  return getById(id);
}

/** Atomically take the oldest pending job for a service and mark it running. */
export function claimNextPending(service: 'sonarr' | 'radarr'): FolderJob | null {
  const db = getDatabase();
  const now = new Date().toISOString();
  const claim = db.transaction(() => {
    const row = db
      .prepare(`SELECT id FROM folder_jobs WHERE status = 'pending' AND service = ? ORDER BY created_at ASC, id ASC LIMIT 1`)
      .get(service) as { id: number } | undefined;
    if (!row) return null;
    db.prepare(
      `UPDATE folder_jobs
         SET status = 'running', started_at = ?, finished_at = NULL, error = NULL, attempts = attempts + 1, updated_at = ?
       WHERE id = ? AND status = 'pending'`
    ).run(now, now, row.id);
    return getById(row.id);
  });
  return claim();
}

/** Cancel every job in a batch that has not started. Returns how many. */
export function cancelPendingInBatch(batchId: string): number {
  const now = new Date().toISOString();
  return getDatabase()
    .prepare(
      `UPDATE folder_jobs SET status = 'cancelled', message = 'Cancelled before it started', finished_at = ?, updated_at = ?
       WHERE batch_id = ? AND status = 'pending'`
    )
    .run(now, now, batchId).changes;
}

/** Jobs that were running when the process stopped go back in line. */
export function requeueInterrupted(): FolderJob[] {
  const db = getDatabase();
  const now = new Date().toISOString();
  const rows = db.prepare(`SELECT * FROM folder_jobs WHERE status = 'running'`).all() as FolderJob[];
  if (rows.length === 0) return [];
  db.prepare(`UPDATE folder_jobs SET status = 'pending', message = 'Resumed after Prunerr restarted', updated_at = ? WHERE status = 'running'`).run(now);
  return rows.map((row) => getById(row.id)!).filter(Boolean);
}

export function deleteFinished(olderThanDays?: number): number {
  const db = getDatabase();
  if (olderThanDays === undefined) {
    return db.prepare(`DELETE FROM folder_jobs WHERE status IN (${finishedList})`).run().changes;
  }
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
  return db.prepare(`DELETE FROM folder_jobs WHERE status IN (${finishedList}) AND finished_at < ?`).run(cutoff).changes;
}

export default {
  create,
  getById,
  findActiveByFolderId,
  listActive,
  listFinished,
  listByBatch,
  update,
  claimNextPending,
  cancelPendingInBatch,
  requeueInterrupted,
  deleteFinished,
};
