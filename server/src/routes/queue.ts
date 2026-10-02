import { Router, Request, Response } from 'express';
import mediaItemsRepo from '../db/repositories/mediaItems';
import historyRepo from '../db/repositories/historyRepo';
import { logActivity } from '../db/repositories/activity';
import logger from '../utils/logger';
import { openSseStream } from '../utils/sse';
import episodeDeletionsRepo from '../db/repositories/episodeDeletions';
import { episodeLabel, executeQueuedDeletions } from '../services/episodeDeletions';
import { getSonarrService, getRadarrService, getOverseerrService } from '../services/init';
import { DeletionAction } from '../rules/types';
import rulesRepo from '../db/repositories/rules';
import {
  deleteQueueItemNow,
  getAllQueueItems,
  listQueue,
  normalizeDeletionAction,
  parseQueueId,
  processQueue,
  removeFromQueue,
  sendDeletionCompleteNotification,
  summarizeQueue,
} from '../services/deletionQueue';

// Progress event type
interface DeletionProgress {
  stage: 'starting' | 'unmonitoring' | 'deleting_files' | 'resetting_overseerr' | 'complete' | 'error';
  message: string;
  fileProgress?: {
    current: number;
    total: number;
    fileName: string;
    status: 'deleting' | 'deleted' | 'failed';
  };
  result?: {
    success: boolean;
    fileSizeFreed?: number;
    overseerrReset?: boolean;
    error?: string;
  };
}

const router = Router();

/**
 * Run one queued episode over SSE, using the same progress envelope the Queue
 * page already renders for whole-item deletions.
 */
async function streamEpisodeDeletion(req: Request, rowId: number, res: Response): Promise<void> {
  const row = episodeDeletionsRepo.getById(rowId);
  if (!row || row.status !== 'pending') {
    res.status(404).json({ success: false, error: 'Episode is not in the deletion queue' });
    return;
  }

  const title = episodeLabel(row.series_title, row.season_number, row.episode_number, row.episode_title);

  const stream = openSseStream(req, res);
  const send = (progress: DeletionProgress) => stream.send(progress);

  try {
    send({ stage: 'starting', message: `Starting deletion of "${title}"...` });
    send({ stage: 'deleting_files', message: 'Deleting episode in Sonarr...' });

    const result = await executeQueuedDeletions([row]);
    const outcome = result.outcomes[0];

    if (outcome?.success) {
      await sendDeletionCompleteNotification([{ title, type: 'episode' }], result.freedBytes, 0);
      send({
        stage: 'complete',
        message: `"${title}" deleted successfully`,
        result: { success: true, fileSizeFreed: result.freedBytes },
      });
    } else {
      send({
        stage: 'error',
        message: outcome?.error || 'Failed to delete episode',
        result: { success: false, error: outcome?.error || 'Failed to delete episode' },
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to stream episode deletion for "${title}": ${message}`);
    send({ stage: 'error', message, result: { success: false, error: message } });
  } finally {
    stream.close();
  }
}

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
router.post('/:id/delete-now/stream', async (req: Request, res: Response) => {
  const parsedId = parseQueueId(req.params['id'] as string);
  if (!parsedId) {
    res.status(400).json({ success: false, error: 'Invalid queue item ID' });
    return;
  }

  if (parsedId.kind === 'episode') {
    await streamEpisodeDeletion(req, parsedId.id, res);
    return;
  }

  const id = parsedId.id;

  // Verify the item exists and is in pending_deletion status
  const item = mediaItemsRepo.getById(id);
  if (!item) {
    res.status(404).json({ success: false, error: `Item not found: ${id}` });
    return;
  }

  if (item.status !== 'pending_deletion') {
    res.status(400).json({ success: false, error: 'Item is not in the deletion queue' });
    return;
  }

  // Progress goes over SSE; the deletion itself runs to completion whether or
  // not the browser is still listening.
  const stream = openSseStream(req, res);
  const sendProgress = (progress: DeletionProgress) => stream.send(progress);

  try {
    const itemAny = item as any;
    const deletionAction = normalizeDeletionAction(itemAny.deletion_action);
    const resetOverseerr = Boolean(itemAny.reset_overseerr);
    const matchedRuleId = itemAny.matched_rule_id as number | undefined;

    sendProgress({ stage: 'starting', message: `Starting deletion of "${item.title}"...` });

    const sonarr = getSonarrService();
    const radarr = getRadarrService();
    const overseerr = getOverseerrService();

    let fileSizeFreed = 0;
    let overseerrResetSuccess = false;
    const deletesFiles = deletionAction !== DeletionAction.UNMONITOR_ONLY;

    // Track file deletion progress
    const onFileProgress = (progress: { current: number; total: number; fileName: string; status: 'deleting' | 'deleted' | 'failed' }) => {
      sendProgress({
        stage: 'deleting_files',
        message: `Deleting file ${progress.current}/${progress.total}`,
        fileProgress: progress,
      });
    };

    // Unmonitor if needed
    if (deletionAction === DeletionAction.UNMONITOR_ONLY ||
        deletionAction === DeletionAction.UNMONITOR_AND_DELETE) {
      sendProgress({ stage: 'unmonitoring', message: 'Unmonitoring in Sonarr/Radarr...' });

      if (item.sonarr_id && sonarr) {
        await sonarr.unmonitorSeries(item.sonarr_id);
      }
      if (item.radarr_id && radarr) {
        await radarr.unmonitorMovie(item.radarr_id);
      }
    }

    // Delete files if needed
    if (deletionAction === DeletionAction.DELETE_FILES_ONLY ||
        deletionAction === DeletionAction.UNMONITOR_AND_DELETE) {
      sendProgress({ stage: 'deleting_files', message: 'Deleting media files...' });

      if (item.sonarr_id && sonarr) {
        await sonarr.deleteAllEpisodeFiles(item.sonarr_id, onFileProgress);
      }
      if (item.radarr_id && radarr) {
        await radarr.deleteMovieFilesByMovieId(item.radarr_id, onFileProgress);
      }

      if (deletesFiles) {
        fileSizeFreed = item.file_size || 0;
      }
    }

    // Full removal - delete everything at once via Sonarr/Radarr
    if (deletionAction === DeletionAction.FULL_REMOVAL) {
      sendProgress({ stage: 'deleting_files', message: 'Removing from Sonarr/Radarr completely...' });

      if (item.sonarr_id && sonarr) {
        await sonarr.removeSeries(item.sonarr_id, true);
      }
      if (item.radarr_id && radarr) {
        await radarr.removeMovie(item.radarr_id, true);
      }

      fileSizeFreed = item.file_size || 0;
    }

    // Reset Overseerr if requested
    if (resetOverseerr && itemAny.tmdb_id && overseerr) {
      sendProgress({ stage: 'resetting_overseerr', message: 'Resetting in Overseerr...' });

      try {
        const mediaType = item.type === 'movie' ? 'movie' : 'tv';
        overseerrResetSuccess = await overseerr.resetMediaByTmdbId(itemAny.tmdb_id, mediaType);

        if (overseerrResetSuccess) {
          mediaItemsRepo.update(item.id, { overseerr_reset_at: new Date().toISOString() } as any);
        }
      } catch (overseerrErr) {
        logger.warn(`Failed to reset in Overseerr: ${overseerrErr}`);
      }
    }

    // Record in deletion history
    historyRepo.create({
      media_item_id: item.id,
      title: item.title,
      type: item.type,
      file_size: deletesFiles ? item.file_size : null,
      deletion_type: 'manual',
      deleted_by_rule_id: matchedRuleId || null,
    });

    // Update item status
    if (deletionAction !== DeletionAction.FULL_REMOVAL) {
      mediaItemsRepo.update(item.id, { status: 'deleted' });
    } else {
      mediaItemsRepo.delete(item.id);
    }

    // Log activity for the timeline. Respect rule attribution if this item was
    // queued by a rule — matches the behaviour of DeletionService.executeDelete
    // so the Activity Log "Rule" filter catches it.
    let ruleName: string | undefined;
    if (matchedRuleId !== undefined) {
      const rule = rulesRepo.rules.getById(matchedRuleId);
      ruleName = rule?.name;
    }

    const activityActorName =
      matchedRuleId !== undefined
        ? (ruleName ?? `Rule #${matchedRuleId}`)
        : 'Manual deletion';

    logActivity({
      eventType: 'deletion',
      action: 'deleted',
      actorType: matchedRuleId !== undefined ? 'rule' : 'user',
      actorId: matchedRuleId !== undefined ? String(matchedRuleId) : null,
      actorName: activityActorName,
      targetType: 'media_item',
      targetId: item.id,
      targetTitle: item.title,
      metadata: JSON.stringify({ fileSize: fileSizeFreed, deletionAction, overseerrReset: overseerrResetSuccess }),
    });

    const freedSpaceGB = (fileSizeFreed / (1024 * 1024 * 1024)).toFixed(2);
    logger.info(`Deleted "${item.title}" via stream (action: ${deletionAction}, freed: ${freedSpaceGB}GB, overseerr: ${overseerrResetSuccess})`);

    // Fire DELETION_COMPLETE Discord notification (non-blocking, errors already logged)
    await sendDeletionCompleteNotification(
      [{ title: item.title, type: item.type, ruleId: matchedRuleId ?? null }],
      fileSizeFreed,
      0
    );

    // Send completion
    sendProgress({
      stage: 'complete',
      message: `"${item.title}" deleted successfully`,
      result: {
        success: true,
        fileSizeFreed,
        overseerrReset: overseerrResetSuccess,
      },
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to delete item via stream: ${errorMessage}`);

    sendProgress({
      stage: 'error',
      message: `Failed to delete: ${errorMessage}`,
      result: {
        success: false,
        error: errorMessage,
      },
    });
  } finally {
    stream.close();
  }
});

export default router;
