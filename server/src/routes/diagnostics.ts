import { Router, Request, Response } from 'express';
import logger from '../utils/logger';
import {
  ServiceNotConfiguredError,
  getDeletionSetup,
  getServiceActivity,
  getServiceHealth,
  getServiceLogs,
  isDiagnosticsService,
  type DiagnosticsService,
} from '../services/serviceDiagnostics';
import type { ArrLogLevel } from '../services/arrDiagnostics';

const router = Router();

function serviceParam(req: Request, res: Response): DiagnosticsService | null {
  const raw = String(req.params['service'] ?? '').toLowerCase();
  if (!isDiagnosticsService(raw)) {
    res.status(400).json({ success: false, error: 'Service must be sonarr or radarr' });
    return null;
  }
  return raw;
}

function handle(res: Response, what: string, error: unknown): void {
  if (error instanceof ServiceNotConfiguredError) {
    res.status(404).json({ success: false, error: error.message });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  logger.error(`Failed to read ${what}: ${message}`);
  res.status(502).json({ success: false, error: `Could not read ${what}: ${message}` });
}

// GET /api/diagnostics/:service/logs?level=warn&limit=50&search=...&since=ISO
router.get('/:service/logs', async (req: Request, res: Response) => {
  const service = serviceParam(req, res);
  if (!service) return;
  try {
    const levelRaw = String(req.query['level'] ?? 'info').toLowerCase();
    const level: ArrLogLevel = levelRaw === 'error' ? 'error' : levelRaw === 'warn' ? 'warn' : 'info';
    const limitRaw = parseInt(String(req.query['limit'] ?? ''), 10);
    const sinceRaw = req.query['since'] ? new Date(String(req.query['since'])) : undefined;
    const result = await getServiceLogs(service, {
      level,
      limit: Number.isFinite(limitRaw) ? limitRaw : 50,
      search: req.query['search'] ? String(req.query['search']) : undefined,
      since: sinceRaw && !Number.isNaN(sinceRaw.getTime()) ? sinceRaw : undefined,
    });
    res.json({ success: true, data: result });
  } catch (error) {
    handle(res, `${service} logs`, error);
  }
});

// GET /api/diagnostics/:service/health
router.get('/:service/health', async (req: Request, res: Response) => {
  const service = serviceParam(req, res);
  if (!service) return;
  try {
    res.json({ success: true, data: await getServiceHealth(service) });
  } catch (error) {
    handle(res, `${service} health`, error);
  }
});

// GET /api/diagnostics/:service/activity
router.get('/:service/activity', async (req: Request, res: Response) => {
  const service = serviceParam(req, res);
  if (!service) return;
  try {
    res.json({ success: true, data: await getServiceActivity(service) });
  } catch (error) {
    handle(res, `${service} activity`, error);
  }
});

// GET /api/diagnostics/:service/deletion-setup
router.get('/:service/deletion-setup', async (req: Request, res: Response) => {
  const service = serviceParam(req, res);
  if (!service) return;
  try {
    res.json({ success: true, data: await getDeletionSetup(service) });
  } catch (error) {
    handle(res, `${service} deletion setup`, error);
  }
});

export default router;
