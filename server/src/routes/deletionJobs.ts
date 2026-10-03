import { Router, Request, Response } from 'express';
import logger from '../utils/logger';
import { openSseStream } from '../utils/sse';
import {
  cancelJob,
  clearFinishedJobs,
  getJob,
  listJobs,
  onDeletionJobChange,
  onDeletionJobsCleared,
  retryJob,
} from '../services/deletionJobs';

const router = Router();

// GET /api/deletion-jobs - live jobs plus recent history
router.get('/', (req: Request, res: Response) => {
  const limitParam = parseInt(req.query['limit'] as string, 10);
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 200) : 50;
  res.json({ success: true, data: listJobs(limit) });
});

// GET /api/deletion-jobs/stream - the same, pushed as it changes.
//
// First event is a full snapshot, then one event per job change. The stream
// carries keep-alive comments, so it survives a reverse proxy's idle timeout
// while a job sits on a long Sonarr/Radarr call.
router.get('/stream', (req: Request, res: Response) => {
  const stream = openSseStream(req, res);
  stream.send({ type: 'snapshot', ...listJobs(50) });

  const unsubscribeChange = onDeletionJobChange((job) => stream.send({ type: 'job', job }));
  const unsubscribeCleared = onDeletionJobsCleared(() => stream.send({ type: 'snapshot', ...listJobs(50) }));
  stream.onClose(() => {
    unsubscribeChange();
    unsubscribeCleared();
  });
});

// GET /api/deletion-jobs/:id
router.get('/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params['id'] as string, 10);
  const job = Number.isFinite(id) ? getJob(id) : null;
  if (!job) {
    res.status(404).json({ success: false, error: 'Job not found' });
    return;
  }
  res.json({ success: true, data: job });
});

// POST /api/deletion-jobs/:id/cancel - only before it starts
router.post('/:id/cancel', (req: Request, res: Response) => {
  const id = parseInt(req.params['id'] as string, 10);
  const result = cancelJob(id);
  if (!result.ok) {
    res.status(result.status).json({ success: false, error: result.error });
    return;
  }
  res.json({ success: true, data: result.job, message: `Cancelled "${result.job.title}"` });
});

// POST /api/deletion-jobs/:id/retry - a failed or cancelled job goes back in line
router.post('/:id/retry', (req: Request, res: Response) => {
  const id = parseInt(req.params['id'] as string, 10);
  const result = retryJob(id);
  if (!result.ok) {
    res.status(result.status).json({ success: false, error: result.error });
    return;
  }
  res.status(202).json({ success: true, data: result.job, message: `Retrying "${result.job.title}"` });
});

// DELETE /api/deletion-jobs/finished - clear the history list
router.delete('/finished', (_req: Request, res: Response) => {
  try {
    const removed = clearFinishedJobs();
    res.json({ success: true, data: { removed } });
  } catch (error) {
    logger.error('Failed to clear finished deletion jobs:', error);
    res.status(500).json({ success: false, error: 'Failed to clear finished jobs' });
  }
});

export default router;
