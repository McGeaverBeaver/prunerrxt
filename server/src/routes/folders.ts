import { Router, Request, Response } from 'express';
import { z } from 'zod';
import logger from '../utils/logger';
import { requestActorName } from '../utils/actor';
import {
  deleteFolder,
  getFolderMappings,
  getQualityProfiles,
  importFolder,
  listOrphanFolders,
  lookupCandidates,
  setFolderIgnored,
  setFolderMappings,
} from '../services/orphanFolders';
import { ServiceNotConfiguredError, isDiagnosticsService } from '../services/serviceDiagnostics';

const router = Router();

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
