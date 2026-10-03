import { Router, Request, Response } from 'express';
import { z } from 'zod';
import logger from '../utils/logger';
import { requestActorName } from '../utils/actor';
import { openSseStream } from '../utils/sse';
import {
  deleteFolder,
  fixFolderPermissions,
  getFolderMappings,
  inspectFolderPermissions,
  getQualityProfiles,
  importFolder,
  listOrphanFolders,
  lookupCandidates,
  setFolderIgnored,
  setFoldersIgnored,
  setFolderMappings,
  suggestImports,
} from '../services/orphanFolders';
import {
  cancelFolderBatch,
  cancelFolderJob,
  clearFinishedFolderJobs,
  enqueueFolderBatch,
  getFolderJob,
  listFolderJobs,
  onFolderJobChange,
  onFolderJobsCleared,
  retryFolderJob,
} from '../services/folderJobs';
import { ServiceNotConfiguredError, isDiagnosticsService } from '../services/serviceDiagnostics';
import { getPermissionCapabilities, getPermissionSettings, setPermissionSettings } from '../services/permissions';

const router = Router();

/** How many folders one bulk request may name. */
const MAX_BULK_IDS = 1000;
/** How many lookups one import preview request runs; the client chunks beyond this. */
const MAX_PREVIEW_IDS = 60;

function fail(res: Response, what: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ServiceNotConfiguredError) {
    res.status(404).json({ success: false, error: message });
    return;
  }
  if (/not found|does not exist|Refusing|No folder mapping|already in|outside/.test(message)) {
    res.status(409).json({ success: false, error: message });
    return;
  }
  logger.error(`Failed to ${what}: ${message}`);
  res.status(500).json({ success: false, error: message });
}

// GET /api/folders?refresh=true&includeIgnored=true
router.get('/', async (req: Request, res: Response) => {
  try {
    const listing = await listOrphanFolders({
      refresh: req.query['refresh'] === 'true',
      includeIgnored: req.query['includeIgnored'] === 'true',
    });
    res.json({ success: true, data: listing });
  } catch (error) {
    fail(res, 'list orphan folders', error);
  }
});

// GET /api/folders/mappings
router.get('/mappings', (_req: Request, res: Response) => {
  res.json({ success: true, data: getFolderMappings() });
});

const MappingsSchema = z.object({
  mappings: z
    .array(z.object({ remotePath: z.string().min(1).max(500), localPath: z.string().min(1).max(500) }))
    .max(50),
});

// PUT /api/folders/mappings (admin: it is a settings change)
router.put('/mappings', (req: Request, res: Response) => {
  const parsed = MappingsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'Each mapping needs a service path and a local path' });
    return;
  }
  try {
    const saved = setFolderMappings(parsed.data.mappings);
    logger.info(`Folder mappings updated: ${saved.map((m) => `${m.remotePath} -> ${m.localPath}`).join(', ') || '(none)'}`);
    res.json({ success: true, data: saved });
  } catch (error) {
    res.status(400).json({ success: false, error: error instanceof Error ? error.message : String(error) });
  }
});

// GET /api/folders/permissions - who Prunerr is, what it can change, and the target owner/modes
router.get('/permissions', (_req: Request, res: Response) => {
  res.json({ success: true, data: { capabilities: getPermissionCapabilities(), settings: getPermissionSettings() } });
});

const PermissionSettingsSchema = z.object({
  uid: z.number().int().min(0).optional(),
  gid: z.number().int().min(0).optional(),
  dirMode: z.string().regex(/^0?[0-7]{3,4}$/).optional(),
  fileMode: z.string().regex(/^0?[0-7]{3,4}$/).optional(),
  autoFix: z.boolean().optional(),
});

// PUT /api/folders/permission-settings (admin: it is a settings change)
router.put('/permission-settings', (req: Request, res: Response) => {
  const parsed = PermissionSettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'uid/gid must be integers and modes octal strings such as 0775' });
    return;
  }
  try {
    const saved = setPermissionSettings(parsed.data);
    logger.info(`Media permission settings updated: ${saved.uid}:${saved.gid}, dirs ${saved.dirMode}, files ${saved.fileMode}, auto-fix ${saved.autoFix ? 'on' : 'off'}`);
    res.json({ success: true, data: { capabilities: getPermissionCapabilities(), settings: saved } });
  } catch (error) {
    res.status(400).json({ success: false, error: error instanceof Error ? error.message : String(error) });
  }
});

// GET /api/folders/:id/permissions - what is wrong with this folder's ownership
router.get('/:id/permissions', async (req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await inspectFolderPermissions(req.params['id'] as string) });
  } catch (error) {
    fail(res, 'inspect folder permissions', error);
  }
});

// POST /api/folders/:id/permissions/fix
router.post('/:id/permissions/fix', async (req: Request, res: Response) => {
  try {
    const result = await fixFolderPermissions(req.params['id'] as string, { actorName: requestActorName(req, 'Manual action') });
    res.json({
      success: true,
      data: result,
      message:
        result.result.failed.length === 0
          ? `Fixed ${result.result.changed} entries under ${result.folder.name}`
          : `Fixed ${result.result.changed} entries under ${result.folder.name}; ${result.result.failed.length} could not be changed`,
    });
  } catch (error) {
    fail(res, 'fix folder permissions', error);
  }
});

// ============================================================================
// Bulk operations: jobs for the slow ones, one write for the ignore list
// ============================================================================

const IdList = z.array(z.string().min(1).max(2000)).min(1).max(MAX_BULK_IDS);
const JobParamsSchema = z.object({
  candidateId: z.number().int().positive().optional(),
  qualityProfileId: z.number().int().positive().optional(),
  monitored: z.boolean().optional(),
});
const BatchSchema = z.object({
  action: z.enum(['delete', 'import', 'fix_permissions']),
  folders: z.array(z.object({ id: z.string().min(1).max(2000), params: JobParamsSchema.optional() })).min(1).max(MAX_BULK_IDS),
  params: JobParamsSchema.optional(),
});

// POST /api/folders/jobs - queue a batch; answers at once with the jobs
router.post('/jobs', async (req: Request, res: Response) => {
  const parsed = BatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: `action (delete, import or fix_permissions) and 1-${MAX_BULK_IDS} folders are required` });
    return;
  }
  try {
    const result = await enqueueFolderBatch({ ...parsed.data, actorName: requestActorName(req, 'Manual action') });
    const verb = parsed.data.action === 'delete' ? 'delete' : parsed.data.action === 'import' ? 'import' : 'fix permissions on';
    res.status(202).json({
      success: true,
      data: result,
      message: `Queued ${result.queued.length} folder(s) to ${verb}${result.alreadyQueued > 0 ? `, ${result.alreadyQueued} already in progress` : ''}${result.skipped.length > 0 ? `, ${result.skipped.length} skipped` : ''}`,
    });
  } catch (error) {
    fail(res, 'queue folder jobs', error);
  }
});

// GET /api/folders/jobs - live jobs, recent history and per-batch totals
router.get('/jobs', (_req: Request, res: Response) => {
  res.json({ success: true, data: listFolderJobs() });
});

// GET /api/folders/jobs/stream - the same, pushed as it changes
router.get('/jobs/stream', (req: Request, res: Response) => {
  const stream = openSseStream(req, res);
  stream.send({ type: 'snapshot', ...listFolderJobs() });
  const unsubscribeChange = onFolderJobChange((job) => stream.send({ type: 'job', job }));
  const unsubscribeCleared = onFolderJobsCleared(() => stream.send({ type: 'snapshot', ...listFolderJobs() }));
  stream.onClose(() => {
    unsubscribeChange();
    unsubscribeCleared();
  });
});

// DELETE /api/folders/jobs/finished - clear the history
router.delete('/jobs/finished', (_req: Request, res: Response) => {
  res.json({ success: true, data: { removed: clearFinishedFolderJobs() } });
});

// POST /api/folders/jobs/batch/:batchId/cancel - stop what has not started
router.post('/jobs/batch/:batchId/cancel', (req: Request, res: Response) => {
  const result = cancelFolderBatch(req.params['batchId'] as string);
  res.json({ success: true, data: result, message: `Cancelled ${result.cancelled} pending job(s)` });
});

// GET /api/folders/jobs/:id
router.get('/jobs/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params['id'] as string, 10);
  const job = Number.isFinite(id) ? getFolderJob(id) : null;
  if (!job) {
    res.status(404).json({ success: false, error: 'Job not found' });
    return;
  }
  res.json({ success: true, data: job });
});

// POST /api/folders/jobs/:id/cancel
router.post('/jobs/:id/cancel', (req: Request, res: Response) => {
  const result = cancelFolderJob(parseInt(req.params['id'] as string, 10));
  if (!result.ok) {
    res.status(result.status).json({ success: false, error: result.error });
    return;
  }
  res.json({ success: true, data: result.job, message: `Cancelled "${result.job.name}"` });
});

// POST /api/folders/jobs/:id/retry
router.post('/jobs/:id/retry', (req: Request, res: Response) => {
  const result = retryFolderJob(parseInt(req.params['id'] as string, 10));
  if (!result.ok) {
    res.status(result.status).json({ success: false, error: result.error });
    return;
  }
  res.status(202).json({ success: true, data: result.job, message: `Retrying "${result.job.name}"` });
});

// POST /api/folders/import-preview { ids } - best match per folder, for review before a bulk import
router.post('/import-preview', async (req: Request, res: Response) => {
  const parsed = z.object({ ids: IdList.max(MAX_PREVIEW_IDS) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: `ids (1-${MAX_PREVIEW_IDS} folder ids) is required` });
    return;
  }
  try {
    res.json({ success: true, data: await suggestImports(parsed.data.ids) });
  } catch (error) {
    fail(res, 'match folders', error);
  }
});

// POST /api/folders/ignore { ids, ignored } - ignore or show many folders at once
router.post('/ignore', async (req: Request, res: Response) => {
  const parsed = z.object({ ids: IdList, ignored: z.boolean() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'ids (folder ids) and ignored (boolean) are required' });
    return;
  }
  try {
    const result = await setFoldersIgnored(parsed.data.ids, parsed.data.ignored, requestActorName(req, 'Manual action'));
    res.json({ success: true, data: result, message: `${result.folders.length} folder(s) ${parsed.data.ignored ? 'ignored' : 'shown again'}` });
  } catch (error) {
    fail(res, 'update folders', error);
  }
});

// GET /api/folders/profiles/:service
router.get('/profiles/:service', async (req: Request, res: Response) => {
  const service = String(req.params['service'] ?? '').toLowerCase();
  if (!isDiagnosticsService(service)) {
    res.status(400).json({ success: false, error: 'Service must be sonarr or radarr' });
    return;
  }
  try {
    res.json({ success: true, data: await getQualityProfiles(service) });
  } catch (error) {
    fail(res, `read ${service} quality profiles`, error);
  }
});

// GET /api/folders/:id/candidates?term=
router.get('/:id/candidates', async (req: Request, res: Response) => {
  try {
    const term = req.query['term'] ? String(req.query['term']) : undefined;
    res.json({ success: true, data: await lookupCandidates(req.params['id'] as string, term) });
  } catch (error) {
    fail(res, 'look up a folder', error);
  }
});

const ImportSchema = z.object({
  candidateId: z.number().int().positive(),
  qualityProfileId: z.number().int().positive().optional(),
  monitored: z.boolean().optional(),
});

// POST /api/folders/:id/import
router.post('/:id/import', async (req: Request, res: Response) => {
  const parsed = ImportSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'candidateId is required' });
    return;
  }
  try {
    const result = await importFolder(req.params['id'] as string, { ...parsed.data, actorName: requestActorName(req, 'Manual action') });
    res.json({
      success: true,
      data: result,
      message: `Imported "${result.title}" into ${result.folder.serviceLabel}; it is scanning the folder now`,
    });
  } catch (error) {
    fail(res, 'import a folder', error);
  }
});

// DELETE /api/folders/:id
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const result = await deleteFolder(req.params['id'] as string, { actorName: requestActorName(req, 'Manual action') });
    res.json({ success: true, data: result, message: `Deleted ${result.folder.name}` });
  } catch (error) {
    fail(res, 'delete a folder', error);
  }
});

const IgnoreSchema = z.object({ ignored: z.boolean() });

// POST /api/folders/:id/ignore
router.post('/:id/ignore', async (req: Request, res: Response) => {
  const parsed = IgnoreSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'ignored (boolean) is required' });
    return;
  }
  try {
    const folder = await setFolderIgnored(req.params['id'] as string, parsed.data.ignored, requestActorName(req, 'Manual action'));
    res.json({ success: true, data: folder });
  } catch (error) {
    fail(res, 'update a folder', error);
  }
});

export default router;
