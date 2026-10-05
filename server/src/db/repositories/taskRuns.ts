/**
 * One row per background task run, for the Tasks page: what ran, who or what
 * started it, how long it took and how it ended. The scheduler writes a row
 * for every scheduled and manual run; Archive writes one per background
 * availability pass.
 */
import { getDatabase } from '../index';

export type TaskTrigger = 'schedule' | 'manual' | 'startup' | 'queue' | 'mcp';

export interface TaskRun {
  id: number;
  name: string;
  trigger: TaskTrigger;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  success: boolean | null;
  message: string | null;
  error: string | null;
  data: Record<string, unknown> | null;
}

interface TaskRunRow {
  id: number;
  name: string;
  trigger: string;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  success: number | null;
  message: string | null;
  error: string | null;
  data: string | null;
}

function rowToRun(row: TaskRunRow): TaskRun {
  let data: Record<string, unknown> | null = null;
  if (row.data) {
    try {
      data = JSON.parse(row.data);
    } catch {
      data = null;
    }
  }
  return {
    id: row.id,
    name: row.name,
    trigger: row.trigger as TaskTrigger,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    durationMs: row.duration_ms,
    success: row.success === null ? null : row.success === 1,
    message: row.message,
    error: row.error,
    data,
  };
}

/** Open a run; returns its id for `finish`. */
export function startTaskRun(name: string, trigger: TaskTrigger, startedAt: Date = new Date()): number {
  const result = getDatabase().prepare('INSERT INTO task_runs (name, trigger, started_at) VALUES (?, ?, ?)').run(name, trigger, startedAt.toISOString());
  return Number(result.lastInsertRowid);
}

export function finishTaskRun(id: number, outcome: { success: boolean; message?: string | null; error?: string | null; data?: Record<string, unknown> | null; completedAt?: Date }): void {
  const completed = outcome.completedAt ?? new Date();
  const started = getDatabase().prepare<[number], { started_at: string }>('SELECT started_at FROM task_runs WHERE id = ?').get(id);
  const durationMs = started ? Math.max(0, completed.getTime() - new Date(started.started_at).getTime()) : null;
  getDatabase()
    .prepare('UPDATE task_runs SET completed_at = ?, duration_ms = ?, success = ?, message = ?, error = ?, data = ? WHERE id = ?')
    .run(completed.toISOString(), durationMs, outcome.success ? 1 : 0, outcome.message ?? null, outcome.error ?? null, outcome.data ? JSON.stringify(outcome.data) : null, id);
}

/** Newest first. */
export function listTaskRuns(limit: number = 50, name?: string): TaskRun[] {
  const db = getDatabase();
  const rows = name
    ? db.prepare<[string, number], TaskRunRow>('SELECT * FROM task_runs WHERE name = ? ORDER BY id DESC LIMIT ?').all(name, limit)
    : db.prepare<[number], TaskRunRow>('SELECT * FROM task_runs ORDER BY id DESC LIMIT ?').all(limit);
  return rows.map(rowToRun);
}

/** Runs that were never finished (the process died mid-run), marked as such. */
export function closeStaleTaskRuns(beforeStart: Date): number {
  return getDatabase()
    .prepare("UPDATE task_runs SET completed_at = started_at, duration_ms = NULL, success = 0, error = 'Interrupted by a restart' WHERE completed_at IS NULL AND started_at < ?")
    .run(beforeStart.toISOString()).changes;
}

/** Keep the table bounded. */
export function pruneTaskRuns(keep: number = 2000): number {
  return getDatabase().prepare('DELETE FROM task_runs WHERE id NOT IN (SELECT id FROM task_runs ORDER BY id DESC LIMIT ?)').run(keep).changes;
}

export default { start: startTaskRun, finish: finishTaskRun, list: listTaskRuns, closeStale: closeStaleTaskRuns, prune: pruneTaskRuns };
