import { Router } from 'express';
import healthRouter from './health';
import settingsRouter from './settings';
import mediaRouter from './media';
import rulesRouter from './rules';
import scanRouter from './scan';
import statsRouter from './stats';
import activityRouter from './activity';
import queueRouter from './queue';
import deletionJobsRouter from './deletionJobs';
import diagnosticsRouter from './diagnostics';
import foldersRouter from './folders';
import libraryRouter from './library';
import historyRouter from './history';
import unraidRouter from './unraid';
import usersRouter from './users';
import collectionsRouter from './collections';
import webhooksRouter from './webhooks';
import insightsRouter from './insights';
import tasksRouter from './tasks';
import auditRouter from './audit';
import authRouter from '../auth/routes';

const router = Router();

// Mount all route handlers
router.use('/auth', authRouter);
router.use('/health', healthRouter);
router.use('/settings', settingsRouter);
router.use('/media', mediaRouter);
router.use('/rules', rulesRouter);
router.use('/scan', scanRouter);
router.use('/stats', statsRouter);
router.use('/activity', activityRouter);
router.use('/queue', queueRouter);
router.use('/deletion-jobs', deletionJobsRouter);
router.use('/diagnostics', diagnosticsRouter);
router.use('/folders', foldersRouter);
router.use('/library', libraryRouter);
router.use('/history', historyRouter);
router.use('/unraid', unraidRouter);
router.use('/users', usersRouter);
router.use('/collections', collectionsRouter);
router.use('/webhooks', webhooksRouter);
router.use('/insights', insightsRouter);
router.use('/tasks', tasksRouter);
router.use('/audit', auditRouter);

export default router;
