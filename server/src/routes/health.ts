import { Router, Request, Response } from 'express';
import { getDatabase } from '../db';
import config, { isServiceConfigured } from '../config';
import logger from '../utils/logger';
import { getAppVersion } from '../utils/version';
import { getSystemHealth } from '../services/systemHealth';

// APP_VERSION at Docker build time, package.json otherwise.
const appVersion = getAppVersion();

const router = Router();

interface HealthStatus {
  status: 'healthy' | 'unhealthy' | 'degraded';
  timestamp: string;
  version: string;
  uptime: number;
  database: {
    status: 'connected' | 'disconnected';
    path: string;
  };
  services: {
    plex: { configured: boolean };
    tautulli: { configured: boolean };
    tracearr: { configured: boolean };
    sonarr: { configured: boolean };
    radarr: { configured: boolean };
    overseerr: { configured: boolean };
    discord: { configured: boolean };
  };
}

router.get('/', (_req: Request, res: Response) => {
  let dbStatus: 'connected' | 'disconnected' = 'disconnected';

  try {
    const db = getDatabase();
    // Test database connection
    db.prepare('SELECT 1').get();
    dbStatus = 'connected';
  } catch (error) {
    logger.error('Database health check failed:', error);
    dbStatus = 'disconnected';
  }

  const health: HealthStatus = {
    status: dbStatus === 'connected' ? 'healthy' : 'unhealthy',
    timestamp: new Date().toISOString(),
    version: appVersion,
    uptime: process.uptime(),
    database: {
      status: dbStatus,
      path: config.dbPath,
    },
    services: {
      plex: { configured: isServiceConfigured('plex') },
      tautulli: { configured: isServiceConfigured('tautulli') },
      tracearr: { configured: isServiceConfigured('tracearr') },
      sonarr: { configured: isServiceConfigured('sonarr') },
      radarr: { configured: isServiceConfigured('radarr') },
      overseerr: { configured: isServiceConfigured('overseerr') },
      discord: { configured: isServiceConfigured('discord') },
    },
  };

  // Determine overall status
  const anyServiceConfigured = Object.values(health.services).some((s) => s.configured);
  if (dbStatus === 'connected' && anyServiceConfigured) {
    health.status = 'healthy';
  } else if (dbStatus === 'connected') {
    health.status = 'degraded';
  } else {
    health.status = 'unhealthy';
  }

  const statusCode = health.status === 'unhealthy' ? 503 : 200;
  res.status(statusCode).json(health);
});

// Simple ping endpoint for basic connectivity checks
router.get('/ping', (_req: Request, res: Response) => {
  res.json({ pong: true, timestamp: Date.now() });
});

// Version endpoint
router.get('/version', (_req: Request, res: Response) => {
  res.json({ version: appVersion });
});

// Detailed readiness check
router.get('/ready', (_req: Request, res: Response) => {
  try {
    const db = getDatabase();
    db.prepare('SELECT 1').get();
    res.json({ ready: true });
  } catch (error) {
    logger.error('Readiness check failed:', error);
    res.status(503).json({ ready: false, error: 'Database not ready' });
  }
});

// Liveness check
router.get('/live', (_req: Request, res: Response) => {
  res.json({ live: true, timestamp: Date.now() });
});

// ============================================================================
// Aggregated Health Status for Dashboard
// ============================================================================

// Aggregated health status for dashboard
router.get('/status', async (_req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await getSystemHealth() });
  } catch (error) {
    logger.error('Health status check failed:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to check system health',
    });
  }
});

export default router;
