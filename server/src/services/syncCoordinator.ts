import mediaItemsRepo from '../db/repositories/mediaItems';
import logger from '../utils/logger';
import settingsRepo from '../db/repositories/settings';
import { ScannerService } from './scanner';
import { decideRevive, gatherEvidence } from './tombstones';
import type { ScanResult, SyncProgressCallback } from './types';

// Shared singleton so the manual button (routes/library.ts) and the scheduled
// task (scheduler/tasks.ts:syncPlexLibrary) cannot run two Plex pulls at once,
// and so the UI can show "Last synced" timestamps regardless of which path
// completed the run.

let scannerService: ScannerService | null = null;
let syncInProgress = false;

// The last sync's outcome lives in the settings table as well as here: a
// container restart used to make the dashboard and stack health say the
// library had never been synced. Read back lazily on first use.
const LAST_SYNC_SETTING = 'sync_last_result';
interface PersistedSync { completedAt: string | null; finishedAt: string | null; success: boolean | null }
let restored = false;
let lastSyncCompletedAt: Date | null = null;
let lastSyncFinishedAt: Date | null = null;
let lastSyncSuccess: boolean | null = null;

function restoreLastSync(): void {
  if (restored) return;
  restored = true;
  try {
    const saved = settingsRepo.getJson<PersistedSync | null>(LAST_SYNC_SETTING, null);
    if (saved && typeof saved === 'object') {
      lastSyncCompletedAt = saved.completedAt ? new Date(saved.completedAt) : null;
      lastSyncFinishedAt = saved.finishedAt ? new Date(saved.finishedAt) : null;
      lastSyncSuccess = typeof saved.success === 'boolean' ? saved.success : null;
      return;
    }
    // Nothing saved yet (a sync has not run since this was added): the
    // scheduler keeps its own history of the nightly sync job, so a successful
    // run there is the next best answer to "when did the library last sync".
    const job = settingsRepo.getJson<{ lastRun?: string | null; lastResult?: { success?: boolean; completedAt?: string } | null } | null>('scheduler_job_syncPlexLibrary', null);
    if (job && typeof job === 'object' && job.lastRun) {
      const finished = new Date(job.lastResult?.completedAt ?? job.lastRun);
      lastSyncFinishedAt = finished;
      lastSyncSuccess = job.lastResult?.success === true;
      lastSyncCompletedAt = lastSyncSuccess ? finished : null;
    }
  } catch (error) {
    logger.debug(`Could not restore the last sync result: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function persistLastSync(): void {
  try {
    settingsRepo.setJson<PersistedSync>(LAST_SYNC_SETTING, {
      completedAt: lastSyncCompletedAt?.toISOString() ?? null,
      finishedAt: lastSyncFinishedAt?.toISOString() ?? null,
      success: lastSyncSuccess,
    });
  } catch (error) {
    logger.debug(`Could not persist the last sync result: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const syncProgressLog: unknown[] = [];
type SyncListener = (data: unknown) => void;
const syncListeners = new Set<SyncListener>();

function getScanner(): ScannerService {
  if (!scannerService) {
    scannerService = new ScannerService();
    scannerService.setDatabaseCallback(async (items) => {
      let added = 0;
      let updated = 0;
      let revived = 0;
      for (const item of items) {
        const input = scannerService!.convertToMediaItemInput(item);
        const existingItem = input.plex_id ? mediaItemsRepo.getByPlexId(input.plex_id) : null;
        if (existingItem) {
          // Strip status so a sync never clobbers queue/protection state.
          const { status: _status, ...plexFields } = input;

          // A tombstone comes back only on evidence that the title is still
          // there (Sonarr/Radarr has its file, the file is on a mounted path,
          // a genuine re-add, or Plex still lists it untrashed long after the
          // deletion); see tombstones.ts. Plex listing a title the night after
          // PrunerrXT deleted it is not evidence: Plex has not rescanned yet.
          if (existingItem.status === 'deleted') {
            const evidence = gatherEvidence(item.plexItem, item.arrData, input.file_path ?? null);
            const decision = decideRevive(existingItem.deleted_at, evidence);
            if (decision.revive) {
              mediaItemsRepo.update(existingItem.id, {
                ...plexFields,
                status: 'monitored',
                marked_at: null,
                delete_after: null,
                deleted_at: null,
                matched_rule_id: null,
              });
              revived++;
              logger.info(`Revived "${input.title}": ${decision.reason}`);
            } else {
              mediaItemsRepo.update(existingItem.id, plexFields);
            }
          } else {
            mediaItemsRepo.update(existingItem.id, plexFields);
          }
          updated++;
        } else {
          mediaItemsRepo.create(input);
          added++;
        }
      }
      if (revived > 0) logger.info(`Revived ${revived} deleted item(s) that are still in the library`);
      return { added, updated };
    });
    scannerService.setPruneCallback(async (libraryKey, seenPlexIds) => {
      return mediaItemsRepo.deleteStaleByLibraryKey(libraryKey, seenPlexIds);
    });
  }
  return scannerService;
}

export function isSyncInProgress(): boolean {
  return syncInProgress;
}

export function getLastSyncCompletedAt(): Date | null {
  restoreLastSync();
  return lastSyncCompletedAt;
}

export function getLastSyncFinishedAt(): Date | null {
  restoreLastSync();
  return lastSyncFinishedAt;
}

export function getLastSyncSuccess(): boolean | null {
  restoreLastSync();
  return lastSyncSuccess;
}

export function getSyncProgressLog(): unknown[] {
  return [...syncProgressLog];
}

export function subscribeToSync(listener: SyncListener): () => void {
  syncListeners.add(listener);
  return () => syncListeners.delete(listener);
}

function broadcastProgress(data: unknown): void {
  syncProgressLog.push(data);
  for (const listener of syncListeners) {
    try { listener(data); } catch { /* client disconnected */ }
  }
}

export interface RunSyncResult {
  status: 'completed' | 'busy' | 'failed';
  result?: ScanResult;
  error?: string;
}

/**
 * Run a full Plex → DB sync. Returns 'busy' immediately if another sync is
 * already running (either manual or scheduled) so callers don't double-fire.
 * onProgress is invoked alongside the shared broadcast channel.
 */
export async function runLibrarySync(onProgress?: SyncProgressCallback): Promise<RunSyncResult> {
  if (syncInProgress) {
    return { status: 'busy' };
  }

  syncInProgress = true;
  syncProgressLog.length = 0;

  try {
    const scanner = getScanner();
    scanner.reinitialize();

    const result = await scanner.scanAll((progress) => {
      broadcastProgress(progress);
      onProgress?.(progress);
    });

    const now = new Date();
    restoreLastSync();
    lastSyncCompletedAt = now;
    lastSyncFinishedAt = now;
    lastSyncSuccess = true;
    persistLastSync();
    return { status: 'completed', result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Library sync failed:', error);
    broadcastProgress({
      stage: 'error',
      message: `Sync failed: ${message}`,
      result: { success: false, itemsScanned: 0, itemsAdded: 0, itemsUpdated: 0, errors: 1 },
    });
    restoreLastSync();
    lastSyncFinishedAt = new Date();
    lastSyncSuccess = false;
    persistLastSync();
    return { status: 'failed', error: message };
  } finally {
    syncInProgress = false;
    // Tell streaming clients the run is over so they can close.
    for (const listener of syncListeners) {
      try { listener({ stage: 'complete', message: 'Sync stream ended' }); } catch { /* ignore */ }
    }
    syncListeners.clear();
  }
}
