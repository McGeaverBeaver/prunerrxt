import { Router, Request, Response } from 'express';
import mediaItemsRepo from '../db/repositories/mediaItems';
import logger from '../utils/logger';
import { openSseStream } from '../utils/sse';
import {
  deleteQueueItemNow,
  getAllQueueItems,
  inspectQueueItem,
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

// POST /api/queue/process - Process the deletion queue (delete items whose grace period has expired)
router.post('/process', async (req: Request, res: Response) => {
  try {
    const dryRun = req.query['dryRun'] === 'true';
    const force = req.query['force'] === 'true';

    const { message, ...data } = await processQueue({ dryRun, force });

    res.json({ success: true, data, message });
  } catch (error) {
    logger.error('Failed to process deletion queue:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to process deletion queue',
    });
  }
});

// POST /api/queue/:id/delete-now - Immediately delete a single item (bypass grace period)
router.post('/:id/delete-now', async (req: Request, res: Response) => {
  try {
    const result = await deleteQueueItemNow(req.params['id'] as string);

    if (!result.ok) {
      res.status(result.status).json({
        success: false,
        error: result.error,
        ...(result.overseerrError !== undefined ? { data: { overseerrError: result.overseerrError } } : {}),
      });
      return;
    }

    const { ok: _ok, ...data } = result;
    res.json({
      success: true,
      data,
      message: `"${result.title}" deleted successfully`,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to immediately delete item: ${errorMessage}`);
    res.status(500).json({
      success: false,
      error: errorMessage || 'Failed to delete item',
    });
  }
});

// POST /api/queue/:id/delete-now/stream - Delete with SSE progress streaming
//
// Validation happens before the stream opens so a bad id still gets a plain
// JSON status. After that every step, including the final success or failure,
// travels as an SSE event; the deletion itself runs to completion whether or
// not the browser is still listening.
router.post('/:id/delete-now/stream', async (req: Request, res: Response) => {
  const rawId = req.params['id'] as string;
  const inspected = inspectQueueItem(rawId);
  if (!inspected.ok) {
    res.status(inspected.status).json({ success: false, error: inspected.error });
    return;
  }

  const stream = openSseStream(req, res);

  try {
    const result = await deleteQueueItemNow(rawId, { onProgress: (progress) => stream.send(progress) });
    if (!result.ok) {
      logger.error(`Failed to delete "${inspected.title}" via stream: ${result.error}`);
    }
  } catch (error) {
    // deleteQueueItemNow reports its own failures as 'error' events; this is
    // for anything that escaped it, so the dialog never spins forever.
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to delete "${inspected.title}" via stream: ${errorMessage}`);
    stream.send({
      stage: 'error',
      message: `Failed to delete: ${errorMessage}`,
      result: { success: false, error: errorMessage },
    });
  } finally {
    stream.close();
  }
});

export default router;
