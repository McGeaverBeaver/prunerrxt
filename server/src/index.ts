import dotenv from 'dotenv';
import path from 'path';

// Load environment variables from .env file (check parent directory for monorepo setup)
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config();

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import config, { validateConfig } from './config';
import { initializeDatabase, closeDatabase } from './db';
import routes from './routes';
import logger, { morganStream } from './utils/logger';
import { apiAuthMiddleware, ensureApiKey } from './middleware/apiAuth';
import { initializeServices } from './services/init';
import { getScheduler } from './scheduler';
import { createMcpRouter, closeAllMcpSessions } from './mcp';
import { startDeletionJobWorker, stopDeletionJobWorker, runningDeletionJobCount } from './services/deletionJobs';
import { startFolderJobWorker, stopFolderJobWorker, runningFolderJobCount } from './services/folderJobs';
import oauthRouter from './auth/oauthRoutes';
import { purgeExpiredOAuth } from './auth/oauthServer';
import { getAuthConfig } from './auth/config';
import { purgeExpiredSessions } from './auth/sessions';

// Create Express application
const app = express();

// Validate configuration on startup
const configValidation = validateConfig();
if (!configValidation.valid) {
  logger.warn('Configuration warnings:');
  configValidation.errors.forEach((err) => logger.warn(`  - ${err}`));
}

// Security middleware
// Disable HSTS and CSP as app runs on HTTP in home server environments
app.use(
  helmet({
    contentSecurityPolicy: false,
    hsts: false,
  })
);

// CORS configuration
app.use(
  cors({
    origin: config.nodeEnv === 'production'
      ? process.env['CORS_ORIGIN'] || true
      : true,
    credentials: true,
    // Browser-based MCP clients read these from the /mcp response.
    exposedHeaders: ['Mcp-Session-Id', 'Mcp-Protocol-Version', 'WWW-Authenticate'],
  })
);

// Request logging
app.use(
  morgan(config.nodeEnv === 'production' ? 'combined' : 'dev', {
    stream: morganStream,
    skip: (req: Request) => req.path === '/api/health/ping',
  })
);

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve static files in production
// In Docker: /app/public (copied from client build)
// In local prod: ../../client/dist (relative to server/dist)
if (config.nodeEnv === 'production') {
  const dockerPath = path.join(__dirname, '../public');
  const localPath = path.join(__dirname, '../../client/dist');
  const clientPath = require('fs').existsSync(dockerPath) ? dockerPath : localPath;
  app.use(express.static(clientPath));
  logger.info(`Serving static files from: ${clientPath}`);
}

// OAuth 2.1 endpoints for MCP clients (/.well-known/*, /oauth/*). Fixed
// paths, so they live at the root rather than under /api.
app.use(oauthRouter);

// MCP connector (Streamable HTTP). Authenticates with the API key itself and
// is off entirely unless login is enabled — see mcp/config.ts.
app.use('/mcp', createMcpRouter());

// API key / session authentication middleware
app.use('/api', apiAuthMiddleware);

// API routes
app.use('/api', routes);

// Root health check redirect (convenience)
app.get('/health', (_req: Request, res: Response) => {
  res.redirect('/api/health');
});

// 404 handler for API routes
app.use('/api', (_req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
  });
});

// Serve client app for any other routes in production (SPA routing)
if (config.nodeEnv === 'production') {
  const dockerIndex = path.join(__dirname, '../public/index.html');
  const localIndex = path.join(__dirname, '../../client/dist/index.html');
  const indexPath = require('fs').existsSync(dockerIndex) ? dockerIndex : localIndex;

  // Catch-all for SPA routing - must be after API routes
  app.use((_req: Request, res: Response) => {
    res.sendFile(indexPath);
  });
}

// Global error handler
interface ErrorWithStatus extends Error {
  status?: number;
  statusCode?: number;
}

app.use((err: ErrorWithStatus, _req: Request, res: Response, _next: NextFunction) => {
  const statusCode = err.status || err.statusCode || 500;
  const message = config.nodeEnv === 'production'
    ? 'Internal server error'
    : err.message;

  logger.error('Unhandled error:', {
    message: err.message,
    stack: err.stack,
    statusCode,
  });

  res.status(statusCode).json({
    success: false,
    error: message,
    ...(config.nodeEnv !== 'production' && { stack: err.stack }),
  });
});

// Start server
// A promise nobody awaited that rejects is logged, not fatal: the scheduler
// and the sync coordinator run long jobs in the background, and one of them
// failing must not take the web UI down with it.
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection:', reason instanceof Error ? { message: reason.message, stack: reason.stack } : { reason });
});

// An exception that escapes everything is still fatal (the process state is
// unknown), but it reaches the log file first instead of only the console.
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception, exiting:', { message: error.message, stack: error.stack });
  setTimeout(() => process.exit(1), 250).unref();
});

async function startServer(): Promise<void> {
  try {
    // Initialize database
    logger.info('Initializing database...');
    initializeDatabase();

    // Ensure API key exists in settings
    ensureApiKey();

    // Login configuration comes from the environment; say so, and say what is wrong with it.
    const authConfig = getAuthConfig();
    if (authConfig.enabled) {
      const methods = [authConfig.oidc ? `single sign-on via ${authConfig.oidc.providerName}` : null, authConfig.local ? 'local account' : null]
        .filter(Boolean)
        .join(' and ');
      logger.info(`Login enabled: ${methods || 'NO METHODS CONFIGURED'}`);
      purgeExpiredSessions();
      purgeExpiredOAuth();
      setInterval(() => {
        purgeExpiredSessions();
        purgeExpiredOAuth();
      }, 60 * 60 * 1000).unref();
    } else {
      logger.info('Login disabled (AUTH_ENABLED is not true); the MCP connector is off');
    }
    authConfig.warnings.forEach((warning) => logger.warn(`Auth: ${warning}`));

    // Initialize services (DeletionService, Sonarr, Radarr, Overseerr)
    await initializeServices();

    // Start the scheduler
    const scheduler = getScheduler();
    scheduler.start();
    logger.info('Scheduler started');

    // Background deletions: resume anything interrupted, then run what's queued.
    startDeletionJobWorker();
    logger.info('Deletion job worker started');
    startFolderJobWorker();

    // Start listening
    const server = app.listen(config.port, () => {
      logger.info(`Server started successfully`);
      logger.info(`  Environment: ${config.nodeEnv}`);
      logger.info(`  Port: ${config.port}`);
      logger.info(`  API: http://localhost:${config.port}/api`);
      logger.info(`  Health: http://localhost:${config.port}/api/health`);
    });

    // Graceful shutdown handlers
    const shutdown = async (signal: string): Promise<void> => {
      logger.info(`Received ${signal}, shutting down gracefully...`);

      // Stop the scheduler
      scheduler.stop();
      logger.info('Scheduler stopped');

      stopDeletionJobWorker();
      const inFlight = runningDeletionJobCount();
      if (inFlight > 0) logger.warn(`${inFlight} deletion job(s) still running; they resume after restart`);
      stopFolderJobWorker();
      const folderJobsInFlight = runningFolderJobCount();
      if (folderJobsInFlight > 0) logger.warn(`${folderJobsInFlight} folder job(s) still running; they resume after restart`);

      await closeAllMcpSessions();

      server.close(() => {
        logger.info('HTTP server closed');
        closeDatabase();
        logger.info('Database connection closed');
        process.exit(0);
      });

      // Force shutdown after 10 seconds
      setTimeout(() => {
        logger.error('Forced shutdown after timeout');
        process.exit(1);
      }, 10000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Start the server
startServer();

export default app;
