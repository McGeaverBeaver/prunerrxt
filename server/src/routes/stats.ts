import { Router, Request, Response } from 'express';
import mediaItemsRepo from '../db/repositories/mediaItems';
import storageSnapshotsRepo from '../db/repositories/storageSnapshots';
import { getDashboardStats } from '../services/dashboardStats';
import logger from '../utils/logger';

const router = Router();

// GET /api/stats - Get dashboard statistics
router.get('/', async (_req: Request, res: Response) => {
  try {
    res.json({
      success: true,
      data: await getDashboardStats(),
    });
  } catch (error) {
    logger.error('Failed to get dashboard stats:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve dashboard statistics',
    });
  }
});

// GET /api/stats/storage-history - Get storage snapshots over time
router.get('/storage-history', (req: Request, res: Response) => {
  try {
    const days = parseInt(req.query['days'] as string, 10) || 30;
    const snapshots = storageSnapshotsRepo.getHistory(days);

    res.json({
      success: true,
      data: snapshots.map((s) => ({
        totalSize: s.total_size,
        movieSize: s.movie_size,
        showSize: s.show_size,
        itemCount: s.item_count,
        movieCount: s.movie_count,
        showCount: s.show_count,
        spaceReclaimed: s.space_reclaimed,
        capturedAt: s.captured_at,
      })),
    });
  } catch (error) {
    logger.error('Failed to get storage history:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve storage history',
    });
  }
});

// GET /api/stats/recommendations - Get recommended items for deletion
router.get('/recommendations', (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query['limit'] as string, 10) || 10;
    const unwatchedDays = parseInt(req.query['unwatchedDays'] as string, 10) || 90;

    // Get items that haven't been watched in a long time
    const unwatchedItems = mediaItemsRepo.getUnwatched(unwatchedDays);

    // Filter out protected and already pending deletion items
    const candidates = unwatchedItems
      .filter((item) => !item.is_protected && item.status !== 'pending_deletion')
      .sort((a, b) => {
        // Sort by last watched date (oldest first), then by file size (largest first)
        const aDate = a.last_watched_at ? new Date(a.last_watched_at).getTime() : 0;
        const bDate = b.last_watched_at ? new Date(b.last_watched_at).getTime() : 0;
        if (aDate !== bDate) return aDate - bDate;
        return (b.file_size || 0) - (a.file_size || 0);
      })
      .slice(0, limit);

    // Calculate total reclaimable space
    const totalReclaimableSpace = candidates.reduce((sum, item) => sum + (item.file_size || 0), 0);

    // Transform items for client
    const recommendations = candidates.map((item) => {
      const lastWatchedDate = item.last_watched_at ? new Date(item.last_watched_at) : null;
      const daysSinceWatched = lastWatchedDate
        ? Math.floor((Date.now() - lastWatchedDate.getTime()) / (1000 * 60 * 60 * 24))
        : null;
      const addedDate = item.added_at || item.created_at;
      const daysSinceAdded = addedDate ? Math.floor((Date.now() - new Date(addedDate).getTime()) / (1000 * 60 * 60 * 24)) : null;

      return {
        id: String(item.id),
        title: item.title,
        type: item.type === 'show' ? 'tv' : item.type,
        size: item.file_size || 0,
        posterUrl: item.poster_url,
        lastWatched: item.last_watched_at,
        daysSinceWatched,
        neverWatched: !item.last_watched_at && item.play_count === 0,
        addedAt: item.added_at || item.created_at,
        daysSinceAdded,
        playCount: item.play_count,
        reason: !item.last_watched_at || daysSinceWatched === null
          ? daysSinceAdded === null
            ? 'Never watched'
            : `Never watched in the ${daysSinceAdded} days since it was added`
          : `Not watched in ${daysSinceWatched} days`,
      };
    });

    res.json({
      success: true,
      data: {
        items: recommendations,
        total: unwatchedItems.filter((item) => !item.is_protected && item.status !== 'pending_deletion').length,
        totalReclaimableSpace,
        criteria: {
          unwatchedDays,
        },
      },
    });
  } catch (error) {
    logger.error('Failed to get deletion recommendations:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve recommendations',
    });
  }
});

export default router;
