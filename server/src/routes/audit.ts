/**
 * The audit log, read-only by design: list, verify the chain, export. There
 * is no route that changes or removes an entry.
 */
import { Router, Request, Response } from 'express';
import logger from '../utils/logger';
import { auditRequest, countAudit, iterateAudit, listAudit, readAnchor, verifyAuditChain } from '../services/audit';

const router = Router();

router.get('/', (req: Request, res: Response) => {
  try {
    const limit = parseInt(String(req.query['limit'] ?? ''), 10);
    const offset = parseInt(String(req.query['offset'] ?? ''), 10);
    const result = listAudit({
      limit: Number.isFinite(limit) ? limit : 50,
      offset: Number.isFinite(offset) ? offset : 0,
      action: req.query['action'] ? String(req.query['action']) : undefined,
      actor: req.query['actor'] ? String(req.query['actor']) : undefined,
      search: req.query['search'] ? String(req.query['search']) : undefined,
      since: req.query['since'] ? String(req.query['since']) : undefined,
    });
    res.json({ success: true, data: result.entries, total: result.total });
  } catch (error) {
    logger.error('Failed to read the audit log:', error);
    res.status(500).json({ success: false, error: 'Failed to read the audit log' });
  }
});

router.get('/verify', (req: Request, res: Response) => {
  try {
    const result = verifyAuditChain();
    auditRequest(req, res, { action: 'audit.verified', targetType: 'audit', details: { ok: result.ok, entries: result.entries, firstBreak: result.firstBreak } });
    res.json({ success: true, data: result });
  } catch (error) {
    logger.error('Audit verification failed:', error);
    res.status(500).json({ success: false, error: 'Audit verification failed' });
  }
});

router.get('/summary', (_req: Request, res: Response) => {
  try {
    res.json({ success: true, data: { entries: countAudit(), anchor: readAnchor() } });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to read the audit summary' });
  }
});

// GET /api/audit/export - Every entry as JSON Lines, oldest first (admin only; see roles.ts)
router.get('/export', (req: Request, res: Response) => {
  try {
    auditRequest(req, res, { action: 'audit.exported', targetType: 'audit' });
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Content-Disposition', `attachment; filename="prunerr-audit-${new Date().toISOString().slice(0, 10)}.jsonl"`);
    for (const entry of iterateAudit()) res.write(`${JSON.stringify(entry)}\n`);
    res.end();
  } catch (error) {
    logger.error('Audit export failed:', error);
    if (!res.headersSent) res.status(500).json({ success: false, error: 'Audit export failed' });
    else res.end();
  }
});

export default router;
