import mediaItemsRepo from '../db/repositories/mediaItems';
import logger from '../utils/logger';
import settingsRepo from '../db/repositories/settings';
import { ScannerService } from './scanner';
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
      for (const item of items) {
        const input = scannerService!.convertToMediaItemInput(item);
        const existingItem = input.plex_id ? mediaItemsRepo.getByPlexId(input.plex_id) : null;
        if (existingItem) {
          // Strip status so a sync never clobbers queue/protection state.
          const { status: _status, ...plexFields } = input;

          // Revive a deleted item only when it has genuinely been re-added to
          // Plex. After Prunerr deletes something, Plex keeps a stale metadata
          // entry for a while; that entry keeps its original (pre-deletion)
          // added date, so it stays a tombstone and rules leave it alone. A
          // real re-add (re-request → re-download) lands with an added date
          // later than deleted_at, so it goes back to `monitored`.
          const isGenuineReadd =
            existingItem.status === 'deleted' &&
            !!existingItem.deleted_at &&
            !!input.added_at &&
            new Date(input.added_at).getTime() > new Date(existingItem.deleted_at).getTime();

          if (isGenuineReadd) {
            mediaItemsRepo.update(existingItem.id, {
              ...plexFields,
              status: 'monitored',
              marked_at: null,
              delete_after: null,
              deleted_at: null,
              matched_rule_id: null,
            });
            logger.info(`Revived re-added media item "${input.title}" — back in Plex after deletion`);
          } else {
            mediaItemsRepo.update(existingItem.id, plexFields);
          }
          updated++;
        } else {
          mediaItemsRepo.create(input);
          added++;
        }
      }
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
