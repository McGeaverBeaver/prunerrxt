import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs';

// The background deletion worker against a real SQLite file (the
// deletion_jobs migration has to run), with the per-item deletion itself
// faked: these tests are about queueing, locking, lanes, state and resume,
// not about Sonarr/Radarr.

const { tmpDbPath } = vi.hoisted(() => {
  const osMod = require('os');
  const pathMod = require('path');
  return {
    tmpDbPath: pathMod.join(osMod.tmpdir(), `prunerr-jobs-test-${process.pid}-${Date.now()}.db`),
  };
});

vi.mock('../../config', () => ({ default: { dbPath: tmpDbPath, nodeEnv: 'test' } }));
vi.mock('../../utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

type Inspection =
  | { ok: true; kind: 'media'; id: number; title: string; item: Record<string, unknown> }
  | { ok: false; status: 400 | 404; error: string };

// What the queue "contains": queue id -> media item.
const queue = new Map<string, Record<string, unknown>>();
const deleteNow = vi.fn();
const notify = vi.fn(async (..._args: unknown[]) => undefined);
const ready = vi.fn((): string[] => [...queue.keys()]);

vi.mock('../deletionQueue', () => ({
  inspectQueueItem: (rawId: string): Inspection => {
    const item = queue.get(rawId);
    if (!item) return { ok: false, status: 404, error: `Item not found: ${rawId}` };
    return { ok: true, kind: 'media', id: Number(item['id']), title: String(item['title']), item };
  },
  readyQueueIds: (...args: unknown[]) => ready(...(args as [])),
  deleteQueueItemNow: (...args: unknown[]) => deleteNow(...args),
  sendDeletionCompleteNotification: (...args: unknown[]) => notify(...(args as [])),
}));

import { initializeDatabase, getDatabase, closeDatabase } from '../../db/index';
import deletionJobsRepo from '../../db/repositories/deletionJobs';
import {
  cancelJob,
  enqueueDeleteNow,
  enqueueReadyItems,
  listJobs,
  onDeletionJobChange,
  retryJob,
  startDeletionJobWorker,
  stopDeletionJobWorker,
  waitForDeletionJobsIdle,
  activeJobMediaItemIds,
  type DeletionJobView,
} from '../deletionJobs';

// Archive's verdict: without one an item is held, and Delete Now refuses it.
const REPLACEABLE = JSON.stringify({ verdict: 'replaceable', reasons: [], checkedAt: new Date().toISOString(), service: 'radarr', releases: 3, best: null, current: null });

function movie(id: number, title: string, extra: Record<string, unknown> = {}) {
  return { id, title, type: 'movie', file_size: 1_000, radarr_id: id * 10, sonarr_id: null, deletion_action: 'unmonitor_and_delete', reset_overseerr: 0, availability: REPLACEABLE, ...extra };
}
function show(id: number, title: string) {
  return { id, title, type: 'show', file_size: 2_000, radarr_id: null, sonarr_id: id * 10, deletion_action: 'unmonitor_and_delete', reset_overseerr: 0, availability: REPLACEABLE };
}

/** A fake deleteQueueItemNow that reports progress, then succeeds after `delayMs`. */
function succeedsAfter(delayMs: number, extra: Record<string, unknown> = {}) {
  return async (rawId: string, options: { onProgress?: (p: unknown) => void }) => {
    const title = String(queue.get(rawId)?.['title'] ?? rawId);
    options.onProgress?.({ stage: 'starting', message: `Starting deletion of "${title}"...` });
    options.onProgress?.({ stage: 'unmonitoring', step: 'unmonitor', service: 'Radarr', message: 'Unmonitoring' });
    options.onProgress?.({ stage: 'deleting_files', step: 'delete_files', service: 'Radarr', message: 'Deleting' });
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    queue.delete(rawId);
    return {
      ok: true,
      id: rawId,
      title,
      deletionAction: 'unmonitor_and_delete',
      deletionActionLabel: 'Unmonitor and delete',
      fileSizeFreed: 1_000,
      fileSizeFreedFormatted: '0.00 GB',
      overseerrReset: false,
      stepDurationsMs: { unmonitor: 5, delete_files: delayMs },
      ...extra,
    };
  };
}

describe('deletion jobs', () => {
  beforeAll(() => {
    initializeDatabase();
  });

  afterAll(() => {
    stopDeletionJobWorker();
    closeDatabase();
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* ignore */ }
    }
  });

  beforeEach(() => {
    stopDeletionJobWorker();
    getDatabase().prepare('DELETE FROM deletion_jobs').run();
    queue.clear();
    deleteNow.mockReset();
    notify.mockClear();
    ready.mockClear();
  });

  it('answers at once with a pending job and refuses a second job for the same item', () => {
    queue.set('1', movie(1, 'Example Movie'));

    const first = enqueueDeleteNow('1', { actorName: 'tester' });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.alreadyQueued).toBe(false);
    expect(first.job).toMatchObject({ queueId: '1', title: 'Example Movie', status: 'pending', service: 'Radarr', requestedBy: 'tester', type: 'movie' });

    // Same item again: the lock hands back the live job, no duplicate row.
    const second = enqueueDeleteNow('1', { actorName: 'tester' });
    expect(second.ok && second.alreadyQueued).toBe(true);
    expect(listJobs().active).toHaveLength(1);
    expect(activeJobMediaItemIds()).toEqual(new Set([1]));

    expect(enqueueDeleteNow('999', { actorName: 'tester' })).toMatchObject({ ok: false, status: 404 });
  });

  it('refuses Delete Now while Archive holds the item, until a decision lifts the hold', () => {
    queue.set('7', movie(7, 'Unchecked', { availability: null }));
    const held = enqueueDeleteNow('7', { actorName: 'tester' });
    expect(held).toMatchObject({ ok: false, status: 409 });
    expect((held as { error: string }).error).toContain('held by Archive');

    queue.set('8', movie(8, 'At risk', { availability: JSON.stringify({ verdict: 'at_risk', reasons: ['no_releases'], checkedAt: new Date().toISOString(), service: 'radarr', releases: 0, best: null, current: null }) }));
    expect(enqueueDeleteNow('8', { actorName: 'tester' })).toMatchObject({ ok: false, status: 409 });

    queue.set('9', movie(9, 'Delete anyway', { availability: null, availability_decision: 'delete' }));
    expect(enqueueDeleteNow('9', { actorName: 'tester' })).toMatchObject({ ok: true });
  });

  it('runs jobs in the background, streaming step changes, and records the outcome', async () => {
    queue.set('1', movie(1, 'Example Movie'));
    deleteNow.mockImplementation(succeedsAfter(60));
    const seen: DeletionJobView[] = [];
    const unsubscribe = onDeletionJobChange((job) => seen.push(job));

    const result = enqueueDeleteNow('1', { actorName: 'tester' });
    expect(result.ok).toBe(true);
    startDeletionJobWorker();
    try {
      expect(await waitForDeletionJobsIdle(3_000)).toBe(true);
    } finally {
      unsubscribe();
    }

    const [job] = listJobs().recent;
    expect(job).toMatchObject({ status: 'done', fileSizeFreed: 1_000, attempts: 1, step: null, stage: 'complete' });
    expect(job!.stepDurationsMs).toEqual({ unmonitor: 5, delete_files: 60 });
    expect(job!.finishedAt).toBeTruthy();
    expect(deleteNow).toHaveBeenCalledWith('1', expect.objectContaining({ deletionType: 'manual', actorName: 'tester', notify: true }));

    const statuses = seen.map((j) => `${j.status}:${j.step ?? '-'}`);
    expect(statuses[0]).toBe('pending:-');
    expect(statuses).toContain('running:unmonitor');
    expect(statuses).toContain('running:delete_files');
    expect(statuses.at(-1)).toBe('done:-');
  });

  it('turns to verifying when the delete outlasts the timeout, and still ends done', async () => {
    queue.set('1', movie(1, 'Big File'));
    deleteNow.mockImplementation(async (rawId: string, options: { onProgress?: (p: unknown) => void }) => {
      options.onProgress?.({ stage: 'deleting_files', step: 'delete_files', service: 'Radarr', message: 'Deleting' });
      options.onProgress?.({ stage: 'verifying', step: 'delete_files', service: 'Radarr', message: 'Radarr is still deleting; waiting' });
      await new Promise((resolve) => setTimeout(resolve, 40));
      queue.delete(rawId);
      return { ok: true, id: rawId, title: 'Big File', deletionAction: 'unmonitor_and_delete', deletionActionLabel: '', fileSizeFreed: 1_000, fileSizeFreedFormatted: '0.00 GB', stepDurationsMs: {} };
    });
    const statuses: string[] = [];
    const unsubscribe = onDeletionJobChange((job) => statuses.push(job.status));

    enqueueDeleteNow('1', { actorName: 'tester' });
    startDeletionJobWorker();
    await waitForDeletionJobsIdle(3_000);
    unsubscribe();

    expect(statuses).toContain('verifying');
    expect(listJobs().recent[0]!.status).toBe('done');
  });

  it('records a failure with its step, service and status, and can be retried', async () => {
    queue.set('1', movie(1, 'Stubborn'));
    deleteNow.mockImplementationOnce(async () => ({
      ok: false,
      status: 500,
      error: 'Radarr answered HTTP 500',
      step: 'delete_files',
      service: 'Radarr',
      upstreamStatus: 500,
      stepDurationsMs: { unmonitor: 3 },
    }));

    enqueueDeleteNow('1', { actorName: 'tester' });
    startDeletionJobWorker();
    await waitForDeletionJobsIdle(3_000);

    const failed = listJobs().recent[0]!;
    expect(failed).toMatchObject({ status: 'failed', error: 'Radarr answered HTTP 500', failedStep: 'delete_files', failedService: 'Radarr', upstreamStatus: 500 });
    // The item is still in the queue, so it can be tried again.
    expect(queue.has('1')).toBe(true);

    deleteNow.mockImplementation(succeedsAfter(10));
    const retried = retryJob(failed.id);
    expect(retried.ok).toBe(true);
    await waitForDeletionJobsIdle(3_000);
    const after = listJobs().recent[0]!;
    expect(after.id).toBe(failed.id);
    expect(after).toMatchObject({ status: 'done', attempts: 2, error: null });
  });

  it('cancels a pending job but not one in flight', async () => {
    queue.set('1', movie(1, 'Slow'));
    queue.set('2', movie(2, 'Waiting'));
    deleteNow.mockImplementation(succeedsAfter(150));

    const slow = enqueueDeleteNow('1', { actorName: 'tester' });
    const waiting = enqueueDeleteNow('2', { actorName: 'tester' });
    if (!slow.ok || !waiting.ok) throw new Error('enqueue failed');
    startDeletionJobWorker();
    await new Promise((resolve) => setTimeout(resolve, 30));

    // Same lane (Radarr), concurrency 1: the first runs, the second waits.
    expect(deletionJobsRepo.getById(slow.job.id)!.status).toBe('running');
    expect(deletionJobsRepo.getById(waiting.job.id)!.status).toBe('pending');

    expect(cancelJob(slow.job.id)).toMatchObject({ ok: false, status: 409 });
    expect(cancelJob(waiting.job.id)).toMatchObject({ ok: true });
    expect(deletionJobsRepo.getById(waiting.job.id)!.status).toBe('cancelled');

    await waitForDeletionJobsIdle(3_000);
    expect(deletionJobsRepo.getById(slow.job.id)!.status).toBe('done');
    expect(deleteNow).toHaveBeenCalledTimes(1);
  });

  it('runs Sonarr and Radarr jobs side by side, one at a time per service', async () => {
    queue.set('1', movie(1, 'Movie A'));
    queue.set('2', movie(2, 'Movie B'));
    queue.set('3', show(3, 'Show C'));
    const started: string[] = [];
    deleteNow.mockImplementation(async (rawId: string) => {
      started.push(rawId);
      await new Promise((resolve) => setTimeout(resolve, 80));
      queue.delete(rawId);
      return { ok: true, id: rawId, title: rawId, deletionAction: '', deletionActionLabel: '', fileSizeFreed: 0, fileSizeFreedFormatted: '0.00 GB' };
    });

    const batch = enqueueReadyItems({ force: true, actorName: 'tester' });
    expect(batch.queued).toHaveLength(3);
    expect(batch.queued.map((j) => j.service)).toEqual(['Radarr', 'Radarr', 'Sonarr']);
    startDeletionJobWorker();
    await new Promise((resolve) => setTimeout(resolve, 30));

    // Movie A and Show C start together; Movie B waits for the Radarr lane.
    expect(started.sort()).toEqual(['1', '3']);
    await waitForDeletionJobsIdle(3_000);
    expect(started).toHaveLength(3);

    // One summary notification for the whole batch, not three.
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toHaveLength(3);
    expect(deleteNow.mock.calls.every((call) => (call[1] as { notify: boolean }).notify === false)).toBe(true);
  });

  it('resumes jobs that were running when the process stopped', async () => {
    queue.set('1', movie(1, 'Interrupted'));
    const created = enqueueDeleteNow('1', { actorName: 'tester' });
    if (!created.ok) throw new Error('enqueue failed');
    // Simulate a crash mid-step: the row says running, nobody is running it.
    deletionJobsRepo.update(created.job.id, { status: 'verifying', step: 'delete_files', attempts: 1 });

    deleteNow.mockImplementation(succeedsAfter(10));
    startDeletionJobWorker();
    await waitForDeletionJobsIdle(3_000);

    const job = deletionJobsRepo.getById(created.job.id)!;
    expect(job.status).toBe('done');
    expect(job.attempts).toBe(2);
    expect(deleteNow).toHaveBeenCalledTimes(1);
  });

  it('fails a job cleanly when the item left the queue before it ran', async () => {
    queue.set('1', movie(1, 'Gone'));
    const created = enqueueDeleteNow('1', { actorName: 'tester' });
    if (!created.ok) throw new Error('enqueue failed');
    deleteNow.mockImplementation(async () => ({ ok: false, status: 400, error: 'Item is not in the deletion queue' }));

    startDeletionJobWorker();
    await waitForDeletionJobsIdle(3_000);
    expect(deletionJobsRepo.getById(created.job.id)).toMatchObject({ status: 'failed', error: 'Item is not in the deletion queue' });
  });
});
