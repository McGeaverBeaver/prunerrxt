import { Router, Request, Response } from 'express';
import mediaItemsRepo from '../db/repositories/mediaItems';
import logger from '../utils/logger';
import { requestActorName } from '../utils/actor';
import { enqueueDeleteNow, enqueueReadyItems } from '../services/deletionJobs';
import { AvailabilityPausedError, checkItem, getAvailabilityStatus } from '../services/availability';
import { describeReasons, holdState, parseAvailability } from '../services/availabilityVerdict';
import { allowDeletionAnyway, archiveItems } from '../services/mediaActions';
import {
  getAllQueueItems,
  listQueue,
  processQueue,
  removeFromQueue,
  summarizeQueue,
} from '../services/deletionQueue';

const router = Router();

// GET /api/queue/upcoming - Get upcoming deletion queue items
router.get('/upcoming', (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query['limit'] as string, 10) || 50;
    const all = getAllQueueItems();
    const queueItems = all.slice(0, limit);
    const summary = summarizeQueue(queueItems);

    res.json({
      success: true,
      data: queueItems,
      total: queueItems.length,
      summary: {
        // Historical quirk kept for the dashboard: totalItems counts the whole
        // queue while the other fields describe the returned slice.
        totalItems: mediaItemsRepo.getPendingDeletion().length,
        totalSize: summary.totalSize,
        readyForDeletion: summary.readyForDeletion,
        willResetOverseerr: summary.willResetOverseerr,
      },
    });
  } catch (error) {
    logger.error('Failed to get upcoming queue:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve upcoming queue',
    });
  }
});

// GET /api/queue - Get full deletion queue
router.get('/', (req: Request, res: Response) => {
  try {
    // `limit` is optional. When omitted (or non-positive) the entire queue is
    // returned — the Queue page renders every item and paginates client-side,
    // so a default cap here would silently hide items.
    const limitParam = parseInt(req.query['limit'] as string, 10);
    const offset = parseInt(req.query['offset'] as string, 10) || 0;
    const listing = listQueue({ limit: Number.isNaN(limitParam) ? 0 : limitParam, offset });

    res.json({
      success: true,
      data: listing.items,
      total: listing.total,
      limit: listing.limit,
      offset: listing.offset,
      summary: listing.summary,
    });
  } catch (error) {
    logger.error('Failed to get queue:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve queue',
    });
  }
});

// DELETE /api/queue/:id - Remove an item from the deletion queue (cancel deletion)
router.delete('/:id', (req: Request, res: Response) => {
  try {
    const result = removeFromQueue(req.params['id'] as string, requestActorName(req));
    if (!result.ok) {
      res.status(result.status).json({ success: false, error: result.error });
      return;
    }

    res.json({
      success: true,
      data: result.item ?? { id: result.id },
      message: `"${result.title}" removed from deletion queue`,
    });
  } catch (error) {
    logger.error('Failed to remove item from queue:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to remove item from queue',
    });
  }
});

// POST /api/queue/process - Process the deletion queue
//
// A dry run answers at once with what would go. A real run queues one
// background job per due item and answers 202: the deletions run in the
// worker and the UI follows them through /api/deletion-jobs.
router.post('/process', async (req: Request, res: Response) => {
  try {
    const dryRun = req.query['dryRun'] === 'true';
    const force = req.query['force'] === 'true';

    if (dryRun) {
      const { message, ...data } = await processQueue({ dryRun: true, force });
      res.json({ success: true, data, message });
      return;
    }

    const batch = enqueueReadyItems({ force, actorName: requestActorName(req) });
    const message =
      batch.queued.length > 0
        ? `Deleting ${batch.queued.length} item(s) in the background`
        : batch.alreadyQueued > 0
          ? 'Those items are already being deleted'
          : 'No items ready for deletion';
    res.status(202).json({ success: true, data: { ...batch, background: true }, message });
  } catch (error) {
    logger.error('Failed to process deletion queue:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to process deletion queue',
    });
  }
});

// POST /api/queue/:id/delete-now - Delete a single item now, in the background.
// Answers 202 with the job; progress arrives through /api/deletion-jobs.
router.post('/:id/delete-now', (req: Request, res: Response) => {
  try {
    const result = enqueueDeleteNow(req.params['id'] as string, { actorName: requestActorName(req) });
    if (!result.ok) {
      res.status(result.status).json({ success: false, error: result.error });
      return;
    }
    res.status(202).json({
      success: true,
      data: { job: result.job, alreadyQueued: result.alreadyQueued, background: true },
      message: result.alreadyQueued
        ? `"${result.job.title}" is already being deleted`
        : `Deleting "${result.job.title}" in the background`,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to queue immediate deletion: ${errorMessage}`);
    res.status(500).json({ success: false, error: errorMessage || 'Failed to delete item' });
  }
});

// GET /api/queue/archive-status - Is the checker paused (indexers down, rate
// limited, app unreachable), and how many queued items still lack a verdict?
router.get('/archive-status', (_req: Request, res: Response) => {
  try {
    res.json({ success: true, data: getAvailabilityStatus() });
  } catch (error) {
    logger.error('Failed to read the Archive status:', error);
    res.status(500).json({ success: false, error: 'Failed to read the Archive status' });
  }
});

// POST /api/queue/:id/availability - Ask Radarr/Sonarr again whether the item
// could be downloaded again (Archive). Runs the search now; can take a minute.
router.post('/:id/availability', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params['id'] as string, 10);
    const item = Number.isNaN(id) ? null : mediaItemsRepo.getById(id);
    if (!item) {
      res.status(404).json({ success: false, error: 'Item not found' });
      return;
    }
    const result = await checkItem(item, { force: true, actorName: requestActorName(req) });
    res.json({
      success: true,
      data: { report: result.report, archived: result.archived, hold: holdState(result.item) },
      message: `"${item.title}": ${result.report.verdict.replace('_', ' ')} (${describeReasons(result.report)})`,
    });
  } catch (error) {
    if (error instanceof AvailabilityPausedError) {
      res.status(503).json({ success: false, error: `Archive checks are paused. ${error.message}` });
      return;
    }
    logger.error('Availability check failed:', error);
    res.status(500).json({ success: false, error: 'Availability check failed' });
  }
});

// POST /api/queue/:id/archive - Keep the item forever: protect it and take it
// out of the queue (Archive).
router.post('/:id/archive', (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params['id'] as string, 10);
    const item = Number.isNaN(id) ? null : mediaItemsRepo.getById(id);
    if (!item) {
      res.status(404).json({ success: false, error: 'Item not found' });
      return;
    }
    const report = parseAvailability(item.availability);
    const reason = typeof req.body?.reason === 'string' && req.body.reason.trim() ? req.body.reason.trim().slice(0, 200) : report ? `Archived: ${describeReasons(report)}` : 'Archived';
    const result = archiveItems([id], reason, requestActorName(req));
    if (result.archived.length === 0) {
      const why = result.skipped[0]?.reason ?? result.failed[0]?.error ?? 'Could not archive';
      res.status(409).json({ success: false, error: why });
      return;
    }
    res.json({ success: true, data: mediaItemsRepo.getById(id), message: `"${item.title}" archived` });
  } catch (error) {
    logger.error('Failed to archive item:', error);
    res.status(500).json({ success: false, error: 'Failed to archive item' });
  }
});

// POST /api/queue/:id/delete-anyway - Lift the Archive hold on an at-risk item.
router.post('/:id/delete-anyway', (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params['id'] as string, 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid ID parameter' });
      return;
    }
    const result = allowDeletionAnyway(id, requestActorName(req));
    if (!result.ok) {
      res.status(result.status).json({ success: false, error: result.error });
      return;
    }
    res.json({ success: true, data: result.item, message: `"${result.item.title}" will be deleted when its grace period ends` });
  } catch (error) {
    logger.error('Failed to lift the Archive hold:', error);
    res.status(500).json({ success: false, error: 'Failed to update item' });
  }
});

export default router;
