import { Router, Request, Response } from 'express';
import mediaItemsRepo from '../db/repositories/mediaItems';
import logger from '../utils/logger';
import { requestActorName } from '../utils/actor';
import { enqueueDeleteNow, enqueueReadyItems } from '../services/deletionJobs';
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
    const result = removeFromQueue(req.params['id'] as string);
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

export default router;
