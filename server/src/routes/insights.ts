/**
 * /api/insights: the four blocks of the Insights page. Each block has its own
 * endpoint so the page can render whatever answers first, and a block that
 * fails (an app that is down) does not take the others with it.
 */
import { Router, Request, Response } from 'express';
import logger from '../utils/logger';
import { getStackHealth } from '../services/insights/stackHealth';
import { getLibraryQuality } from '../services/insights/libraryQuality';
import { getWatchPatterns } from '../services/insights/watchPatterns';
import { getPlaybackFriction } from '../services/insights/playbackFriction';
import { getInsightHistory } from '../services/insights/snapshots';

const router = Router();

function fail(res: Response, what: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  logger.error(`Failed to ${what}: ${message}`);
  res.status(500).json({ success: false, error: message });
}

// GET /api/insights/stack?refresh=true
router.get('/stack', async (req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await getStackHealth({ refresh: req.query['refresh'] === 'true' }) });
  } catch (error) {
    fail(res, 'build stack health', error);
  }
});

// GET /api/insights/library?refresh=true
router.get('/library', async (req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await getLibraryQuality({ refresh: req.query['refresh'] === 'true' }) });
  } catch (error) {
    fail(res, 'build library quality', error);
  }
});

// GET /api/insights/watching?refresh=true
router.get('/watching', async (req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await getWatchPatterns({ refresh: req.query['refresh'] === 'true' }) });
  } catch (error) {
    fail(res, 'build watch patterns', error);
  }
});

// GET /api/insights/playback?refresh=true
router.get('/playback', async (req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await getPlaybackFriction({ refresh: req.query['refresh'] === 'true' }) });
  } catch (error) {
    fail(res, 'build playback friction', error);
  }
});

// GET /api/insights/history?days=90 - the daily snapshots, oldest first
router.get('/history', (req: Request, res: Response) => {
  try {
    const raw = parseInt(String(req.query['days'] ?? '90'), 10);
    const days = Number.isFinite(raw) ? Math.min(365, Math.max(1, raw)) : 90;
    res.json({ success: true, data: { days, rows: getInsightHistory(days) } });
  } catch (error) {
    fail(res, 'read insight history', error);
  }
});

export default router;
