import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';

// The folder job worker against a real SQLite file, with the per-folder work
// (delete, import, fix) faked: these tests cover queueing, the per-folder
// lock, lanes, batch totals, cancel/retry and resume after a restart.

const { tmpDbPath } = vi.hoisted(() => {
  const osMod = require('os');
  const pathMod = require('path');
  return {
    tmpDbPath: pathMod.join(osMod.tmpdir(), `prunerr-folder-jobs-test-${process.pid}-${Date.now()}.db`),
  };
});

vi.mock('../../config', () => ({ default: { dbPath: tmpDbPath, nodeEnv: 'test' } }));
vi.mock('../../utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

type Folder = {
  id: string;
  service: 'sonarr' | 'radarr';
  serviceLabel: 'Sonarr' | 'Radarr';
  name: string;
  path: string;
  localPath: string | null;
  sizeBytes: number | null;
  canDelete: boolean;
};

const folders = new Map<string, Folder>();
const deleteFolder = vi.fn();
const importFolder = vi.fn();
const fixFolderPermissions = vi.fn();

vi.mock('../orphanFolders', () => ({
  listOrphanFolders: async () => ({ folders: [...folders.values()] }),
  deleteFolder: (...args: unknown[]) => deleteFolder(...args),
  importFolder: (...args: unknown[]) => importFolder(...args),
  fixFolderPermissions: (...args: unknown[]) => fixFolderPermissions(...args),
}));

import { initializeDatabase, getDatabase, closeDatabase } from '../../db/index';
import folderJobsRepo from '../../db/repositories/folderJobs';
import {
  cancelFolderBatch,
  cancelFolderJob,
  enqueueFolderBatch,
  listFolderJobs,
  onFolderJobChange,
  retryFolderJob,
  startFolderJobWorker,
  stopFolderJobWorker,
  waitForFolderJobsIdle,
  type FolderJobView,
} from '../folderJobs';

function folder(id: string, service: 'sonarr' | 'radarr', extra: Partial<Folder> = {}): Folder {
  const f: Folder = {
    id,
    service,
    serviceLabel: service === 'sonarr' ? 'Sonarr' : 'Radarr',
    name: `Folder ${id}`,
    path: `/${service === 'sonarr' ? 'tv' : 'movies'}/Folder ${id}`,
    localPath: `/media/Folder ${id}`,
    sizeBytes: 1_000,
    canDelete: true,
    ...extra,
  };
  folders.set(id, f);
  return f;
}

beforeAll(() => {
  initializeDatabase();
});

afterAll(() => {
  stopFolderJobWorker();
  closeDatabase();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* ignore */ }
  }
});

beforeEach(() => {
  stopFolderJobWorker();
  getDatabase().prepare('DELETE FROM folder_jobs').run();
  folders.clear();
  deleteFolder.mockReset();
  importFolder.mockReset();
  fixFolderPermissions.mockReset();
  deleteFolder.mockImplementation(async (id: string) => ({ folder: folders.get(id), localPath: '/x', sizeBytes: 1_000, fileCount: 2 }));
  importFolder.mockImplementation(async (id: string) => ({ folder: folders.get(id), addedId: 7, title: `Title ${id}`, year: 2020 }));
  fixFolderPermissions.mockImplementation(async (id: string) => ({ folder: folders.get(id), result: { changed: 3, unchanged: 1, failed: [] } }));
});

describe('queueing', () => {
  it('creates one job per folder, skips unknown and unmapped ones, and refuses a second live job', async () => {
    folder('a', 'radarr');
    folder('b', 'sonarr');
    folder('c', 'radarr', { localPath: null, canDelete: false });

    const result = await enqueueFolderBatch({ action: 'delete', folders: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'nope' }, { id: 'a' }], actorName: 'Tester' });
    expect(result.queued.map((j) => j.folderId).sort()).toEqual(['a', 'b']);
    expect(result.skipped).toEqual([
      { id: 'c', error: expect.stringContaining('No folder mapping') },
      { id: 'nope', error: expect.stringContaining('not found') },
    ]);
    expect(result.alreadyQueued).toBe(0);

    const again = await enqueueFolderBatch({ action: 'fix_permissions', folders: [{ id: 'a' }], actorName: 'Tester' });
    expect(again.queued).toEqual([]);
    expect(again.alreadyQueued).toBe(1);

    const listing = listFolderJobs();
    expect(listing.active).toHaveLength(2);
    expect(listing.batches).toHaveLength(1);
    expect(listing.batches[0]).toMatchObject({ action: 'delete', total: 2, pending: 2, requestedBy: 'Tester' });
  });

  it('merges batch-wide and per-folder parameters', async () => {
    folder('a', 'radarr');
    folder('b', 'radarr');
    const result = await enqueueFolderBatch({
      action: 'import',
      folders: [{ id: 'a', params: { candidateId: 55 } }, { id: 'b' }],
      params: { qualityProfileId: 4, monitored: false },
      actorName: 'Tester',
    });
    const byId = new Map(result.queued.map((j) => [j.folderId, j]));
    expect(byId.get('a')!.params).toEqual({ qualityProfileId: 4, monitored: false, candidateId: 55 });
    expect(byId.get('b')!.params).toEqual({ qualityProfileId: 4, monitored: false });
  });
});

describe('the worker', () => {
  it('runs jobs per service lane and records outcomes', async () => {
    folder('r1', 'radarr');
    folder('r2', 'radarr');
    folder('s1', 'sonarr');
    const order: string[] = [];
    let running = 0;
    let maxRunning = 0;
    deleteFolder.mockImplementation(async (id: string) => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      order.push(id);
      await new Promise((r) => setTimeout(r, 20));
      running -= 1;
      if (id === 'r2') throw new Error('EACCES: permission denied');
      return { folder: folders.get(id), localPath: '/x', sizeBytes: 2_000, fileCount: 1 };
    });

    const seen: FolderJobView[] = [];
    const off = onFolderJobChange((job) => seen.push(job));
    await enqueueFolderBatch({ action: 'delete', folders: [{ id: 'r1' }, { id: 'r2' }, { id: 's1' }], actorName: 'Tester' });
    startFolderJobWorker();
    expect(await waitForFolderJobsIdle(5_000)).toBe(true);
    off();

    // Radarr jobs ran one after the other; the Sonarr job ran alongside.
    expect(maxRunning).toBe(2);
    expect(order.indexOf('r1')).toBeLessThan(order.indexOf('r2'));

    const { recent, batches } = listFolderJobs();
    const byId = new Map(recent.map((j) => [j.folderId, j]));
    expect(byId.get('r1')).toMatchObject({ status: 'done', message: 'Deleted, 1.95 KB freed', result: { sizeBytes: 2_000, fileCount: 1 } });
    expect(byId.get('r2')).toMatchObject({ status: 'failed', error: 'EACCES: permission denied' });
    expect(byId.get('s1')).toMatchObject({ status: 'done' });
    expect(batches[0]).toMatchObject({ total: 3, done: 2, failed: 1, pending: 0, running: 0, freedBytes: 4_000 });
    expect(batches[0]!.finishedAt).not.toBeNull();
    expect(seen.some((j) => j.status === 'running')).toBe(true);
  });

  it('imports with the chosen candidate and fixes permissions, failing when entries could not be changed', async () => {
    folder('a', 'radarr');
    folder('b', 'sonarr');
    folder('c', 'sonarr');
    fixFolderPermissions.mockImplementation(async (id: string) => ({
      folder: folders.get(id),
      result: id === 'c' ? { changed: 1, unchanged: 0, failed: [{ path: '/media/Folder c/x', error: 'EPERM' }] } : { changed: 3, unchanged: 1, failed: [] },
    }));
    await enqueueFolderBatch({ action: 'import', folders: [{ id: 'a', params: { candidateId: 55 } }], params: { qualityProfileId: 4 }, actorName: 'Tester' });
    await enqueueFolderBatch({ action: 'fix_permissions', folders: [{ id: 'b' }, { id: 'c' }], actorName: 'Tester' });
    startFolderJobWorker();
    expect(await waitForFolderJobsIdle(5_000)).toBe(true);

    expect(importFolder).toHaveBeenCalledWith('a', { candidateId: 55, qualityProfileId: 4, monitored: undefined, actorName: 'Tester' });
    const byId = new Map(listFolderJobs().recent.map((j) => [j.folderId, j]));
    expect(byId.get('a')).toMatchObject({ status: 'done', message: 'Imported as "Title a" (2020)', result: { addedId: 7 } });
    expect(byId.get('b')).toMatchObject({ status: 'done', message: '3 entries fixed, 1 already right' });
    expect(byId.get('c')).toMatchObject({ status: 'failed', error: expect.stringContaining('1 entries could not be changed: EPERM') });
  });

  it('cancels what has not started, retries failures, and resumes interrupted jobs', async () => {
    folder('a', 'radarr');
    folder('b', 'radarr');
    folder('c', 'radarr');
    const { batchId, queued } = await enqueueFolderBatch({ action: 'delete', folders: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], actorName: 'Tester' });

    const cancelled = cancelFolderJob(queued[2]!.id);
    expect(cancelled.ok).toBe(true);
    expect(cancelFolderBatch(batchId)).toEqual({ cancelled: 2 });
    expect(listFolderJobs().active).toEqual([]);

    // A retry puts one back; it fails, is retried again, and then succeeds.
    deleteFolder.mockRejectedValueOnce(new Error('busy'));
    expect(retryFolderJob(queued[0]!.id).ok).toBe(true);
    startFolderJobWorker();
    expect(await waitForFolderJobsIdle(5_000)).toBe(true);
    expect(folderJobsRepo.getById(queued[0]!.id)).toMatchObject({ status: 'failed', attempts: 1 });
    expect(retryFolderJob(queued[0]!.id).ok).toBe(true);
    expect(await waitForFolderJobsIdle(5_000)).toBe(true);
    expect(folderJobsRepo.getById(queued[0]!.id)).toMatchObject({ status: 'done', attempts: 2 });
    expect(retryFolderJob(queued[0]!.id)).toMatchObject({ ok: false, status: 409 });

    // Simulate a crash mid-job: a running row is picked up again on start.
    stopFolderJobWorker();
    folderJobsRepo.update(queued[1]!.id, { status: 'running', finished_at: null });
    startFolderJobWorker();
    expect(await waitForFolderJobsIdle(5_000)).toBe(true);
    expect(folderJobsRepo.getById(queued[1]!.id)).toMatchObject({ status: 'done' });
  });
});
