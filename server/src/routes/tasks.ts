/**
 * The Tasks page: what is running right now, every scheduled job with its
 * last and next run, and the recent run history.
 */
import { Router, Request, Response } from 'express';
import logger from '../utils/logger';
import { getScheduler } from '../scheduler';
import taskRunsRepo from '../db/repositories/taskRuns';
import { getAvailabilityStatus } from '../services/availability';
import { listJobs } from '../services/deletionJobs';
import { listFolderJobs } from '../services/folderJobs';
import { getSyncProgressLog, isSyncInProgress } from '../services/syncCoordinator';
import { auditRequest } from '../services/audit';
import { requestActorName } from '../utils/actor';

const router = Router();

/** Tasks a person may start from the page: the ones that read or compute, never the ones that delete. */
const RUNNABLE = new Set(['syncPlexLibrary', 'scanLibraries', 'checkAvailability', 'captureStorageSnapshot', 'captureUnraidCapacitySnapshot', 'syncPlexUsers', 'captureInsightSnapshot', 'monitorDiskPressure', 'verifyAuditLog', 'sendDeletionReminders']);

/** What each job is for, for the page; the names are code identifiers. */
const DESCRIPTIONS: Record<string, string> = {
  syncPlexLibrary: 'Pull the catalogue and watch state from the media server and match it to Sonarr/Radarr',
  scanLibraries: 'Evaluate every rule against the library and queue what matches',
  processDeletionQueue: 'Delete queued items whose grace period has ended (after the Archive check)',
  sendDeletionReminders: 'Send the reminder for items about to be deleted',
  captureStorageSnapshot: 'Record library size for the storage trend',
  captureUnraidCapacitySnapshot: 'Record Unraid array capacity for the forecast',
  syncPlexUsers: 'Refresh the list of media server users',
  monitorDiskPressure: 'Watch free space and queue items when a threshold is crossed',
  captureInsightSnapshot: 'Record the daily Insights numbers',
  checkAvailability: 'Archive: ask Radarr/Sonarr whether queued items could be downloaded again',
  verifyAuditLog: 'Recompute the audit log hash chain and alert on a break',
  availabilityPass: 'Archive: a background pass started by queueing or at start-up',
};

router.get('/', (_req: Request, res: Response) => {
  try {
    const scheduler = getScheduler();
    const jobs = scheduler.getStatus().map((j) => ({
      name: j.name,
      description: DESCRIPTIONS[j.name] ?? null,
      enabled: j.enabled,
      schedule: j.schedule,
      isRunning: j.isRunning,
      runnable: RUNNABLE.has(j.name),
      lastRun: j.lastRun?.toISOString() ?? null,
      lastResult: j.lastResult
        ? { success: j.lastResult.success, message: j.lastResult.message ?? null, error: j.lastResult.error ?? null, durationMs: j.lastResult.durationMs }
        : null,
      nextRun: j.nextRun?.toISOString() ?? null,
    }));
    const archive = getAvailabilityStatus();
    const deletion = listJobs(10);
    const folders = listFolderJobs(10);
    const syncLog = getSyncProgressLog();
    res.json({
      success: true,
      data: {
        schedulerRunning: scheduler.isSchedulerRunning(),
        timezone: scheduler.getConfig().timezone,
        running: {
          availabilityPass: archive.pass,
          archivePaused: archive.paused,
          unchecked: archive.unchecked,
          sync: isSyncInProgress() ? { inProgress: true, latest: syncLog[syncLog.length - 1] ?? null } : null,
          deletionJobs: deletion.active,
          folderJobs: folders.active,
        },
        jobs,
        recent: taskRunsRepo.list(60),
        descriptions: DESCRIPTIONS,
      },
    });
  } catch (error) {
    logger.error('Failed to read task status:', error);
    res.status(500).json({ success: false, error: 'Failed to read task status' });
  }
});

// POST /api/tasks/:name/run - Start a task now. Deletions are deliberately not runnable from here.
router.post('/:name/run', async (req: Request, res: Response) => {
  const name = String(req.params['name'] ?? '');
  if (!RUNNABLE.has(name)) {
    res.status(400).json({ success: false, error: `"${name}" cannot be started from here` });
    return;
  }
  try {
    auditRequest(req, res, { action: 'task.run', targetType: 'task', targetId: name, details: { by: requestActorName(req, 'Manual run') } });
    const result = await getScheduler().runNow(name, 'manual');
    res.json({ success: result.success, data: result, message: result.message ?? result.error ?? null });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(message.includes('currently running') ? 409 : 500).json({ success: false, error: message });
  }
});

export default router;
