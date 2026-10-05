import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import settingsRepo from '../db/repositories/settings';
import { SettingInputSchema } from '../types';
import logger from '../utils/logger';
import { getApiKey, clearApiKeyCache, ensureApiKey, isApiKeyEnabled, setApiKeyEnabled } from '../middleware/apiAuth';
import { clearApiKeyUsage, getApiKeyUsageSummary } from '../services/apiKeyUsage';
import { getMcpInfo } from '../mcp/info';
import { setAllowImmediateDeletion, setMcpEnabled } from '../mcp/config';
import { getAuthConfig } from '../auth/config';
import { ROLE_DESCRIPTIONS } from '../auth/roles';
import { countSessions } from '../auth/sessions';
import { describeOidcProvider } from '../auth/oidc';
import crypto from 'crypto';
import { PlexService, TautulliService, SonarrService, RadarrService, OverseerrService, UnraidService } from '../services';
import { TracearrService } from '../services/tracearr';
import { JellyfinService } from '../services/jellyfin';
import { getConfiguredServerType, isMediaServerType } from '../services/mediaServer';
import { refreshServices, initializeServices, applyDiskPressureSchedule } from '../services/init';
import { getScheduler } from '../scheduler';
import { auditRequest, redact } from '../services/audit';
import { getNotificationService } from '../notifications';
import { getFixedT } from '../i18n';
import { createBackup, restoreFromFile, validateBackupFile } from '../services/backup';
import fs from 'fs';
import os from 'os';
import path from 'path';

const router = Router();

// Schema for validating imported settings
const ImportSettingsSchema = z.object({
  version: z.number(),
  exportedAt: z.string(),
  appName: z.string().optional(),
  settings: z.record(z.string(), z.string()),
});

// Known setting key prefixes for validation
const KNOWN_SETTING_PREFIXES = [
  'media_server_type',
  'plex_',
  'jellyfin_',
  'tautulli_',
  'tracearr_',
  'sonarr_',
  'radarr_',
  'overseerr_',
  'unraid_',
  'notifications_',
  'schedule_',
  'plexSync_',
  'display_',
  'exclusion_',
  'excluded_library_',
  'watch_history_',
  'webhooks_',
  'diskPressure_',
  'archive_',
  'api_key',
];

/** Never exported or imported: they identify this install, not its configuration. */
const SECRET_SETTING_KEYS = new Set(['api_key', 'auth_session_secret']);

function isKnownSettingKey(key: string): boolean {
  return KNOWN_SETTING_PREFIXES.some(prefix => key.startsWith(prefix));
}

// Validation middleware
function validateBody<T>(schema: z.ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: result.error.issues,
      });
      return;
    }
    req.body = result.data;
    next();
  };
}

// GET /api/settings - Get all settings in structured format
router.get('/', (_req: Request, res: Response) => {
  try {
    const rawSettings = settingsRepo.getAll();

    // Convert flat key-value pairs to structured object
    const services: Record<string, Record<string, string>> = {};
    const notifications: Record<string, string | boolean> = {};
    const schedule: Record<string, string | boolean | number> = {};
    const plexSync: Record<string, string | boolean | number> = {};
    const display: Record<string, string> = {};
    const watchHistory: Record<string, string> = {};
    const diskPressure: Record<string, string | boolean | number | string[]> = {};
    const archive: Record<string, string | boolean | number> = {};
    // Which media server backend the install talks to. Resolved by the same
    // helper the rest of the app uses, so a stored choice wins but an install
    // configured only by MEDIA_SERVER_TYPE still reports its real backend.
    // Reporting Plex there would make the next save write media_server_type=plex
    // and silently switch the backend out from under the user.
    const mediaServerType = getConfiguredServerType();
    let exclusionPatterns: unknown[] = [];
    let excludedLibraryKeys: string[] = [];
    let webhooks: unknown[] = [];

    for (const setting of rawSettings) {
      const { key, value } = setting;

      if (key === 'media_server_type') {
        // Resolved above; skipped here so it does not fall through into the
        // generic service/prefix parsing below.
        continue;
      }

      // Parse exclusion patterns
      if (key === 'exclusion_patterns') {
        try {
          exclusionPatterns = JSON.parse(value);
        } catch { /* empty */ }
        continue;
      }

      // Parse excluded library keys
      if (key === 'excluded_library_keys') {
        try {
          excludedLibraryKeys = JSON.parse(value);
        } catch { /* empty */ }
        continue;
      }

      // Parse outbound webhook targets (stored as a single JSON array)
      if (key === 'webhooks_targets') {
        try {
          webhooks = JSON.parse(value);
        } catch { /* empty */ }
        continue;
      }

      // Parse disk-pressure settings
      if (key.startsWith('diskPressure_')) {
        const field = key.replace('diskPressure_', '');
        if (field === 'paths') {
          try {
            diskPressure[field] = JSON.parse(value);
          } catch {
            diskPressure[field] = [];
          }
        } else if (value === 'true' || value === 'false') {
          diskPressure[field] = value === 'true';
        } else if (value !== '' && !isNaN(Number(value))) {
          diskPressure[field] = Number(value);
        } else {
          diskPressure[field] = value;
        }
        continue;
      }

      // Parse Archive settings (re-acquisition checks before deletion)
      if (key.startsWith('archive_')) {
        const field = key.replace('archive_', '');
        if (value === 'true' || value === 'false') {
          archive[field] = value === 'true';
        } else if (value !== '' && !isNaN(Number(value))) {
          archive[field] = Number(value);
        } else {
          archive[field] = value;
        }
        continue;
      }

      // Parse service settings (e.g., plex_url, tautulli_apiKey)
      const serviceMatch = key.match(/^(plex|jellyfin|tautulli|tracearr|sonarr|radarr|overseerr|unraid)_(.+)$/);
      if (serviceMatch && serviceMatch[1] && serviceMatch[2]) {
        const serviceName = serviceMatch[1];
        const field = serviceMatch[2];
        if (!services[serviceName]) {
          services[serviceName] = {};
        }
        services[serviceName][field] = value;
        continue;
      }

      // Parse notification settings
      if (key.startsWith('notifications_')) {
        const field = key.replace('notifications_', '');
        notifications[field] = value === 'true' ? true : value === 'false' ? false : value;
        continue;
      }

      // Parse schedule settings
      if (key.startsWith('schedule_')) {
        const field = key.replace('schedule_', '');
        if (value === 'true' || value === 'false') {
          schedule[field] = value === 'true';
        } else if (value !== '' && !isNaN(Number(value)) && field !== 'time') {
          schedule[field] = Number(value);
        } else {
          schedule[field] = value;
        }
        continue;
      }

      // Parse Plex sync settings
      if (key.startsWith('plexSync_')) {
        const field = key.replace('plexSync_', '');
        if (value === 'true' || value === 'false') {
          plexSync[field] = value === 'true';
        } else if (value !== '' && !isNaN(Number(value)) && field !== 'time') {
          plexSync[field] = Number(value);
        } else {
          plexSync[field] = value;
        }
        continue;
      }

      // Parse display settings
      if (key.startsWith('display_')) {
        const field = key.replace('display_', '');
        display[field] = value;
        continue;
      }

      // Parse watch history settings (watch_history_provider, watch_history_lookback_days)
      if (key.startsWith('watch_history_')) {
        const field = key.replace('watch_history_', '');
        watchHistory[field] = value;
        continue;
      }
    }

    res.json({
      success: true,
      data: {
        mediaServerType,
        services,
        notifications,
        schedule,
        plexSync,
        display,
        watchHistory,
        diskPressure,
        archive,
        exclusionPatterns,
        excludedLibraryKeys,
        webhooks,
      },
    });
  } catch (error) {
    logger.error('Failed to get settings:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve settings',
    });
  }
});

// GET /api/settings/export - Export all settings as JSON file
router.get('/export', (_req: Request, res: Response) => {
  try {
    const rawSettings = settingsRepo.getAll();

    const exportData = {
      version: 1,
      exportedAt: new Date().toISOString(),
      appName: 'PrunerrXT',
      settings: rawSettings
        // The API key and the session secret identify this install, not its
        // configuration, and job run history is runtime state: none of them belong
        // in a portable export.
        .filter((s) => !SECRET_SETTING_KEYS.has(s.key) && !s.key.startsWith('scheduler_job_'))
        .reduce((acc, s) => ({
          ...acc,
          [s.key]: s.value
        }), {} as Record<string, string>),
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename=prunerr-settings.json');
    res.json(exportData);
  } catch (error) {
    logger.error('Failed to export settings:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to export settings',
    });
  }
});

/**
 * GET /api/settings/backup - Download the whole database.
 *
 * The settings export above covers only the settings table. This is the one
 * that actually protects the library, rules, queue and history.
 */
router.get('/backup', (_req: Request, res: Response) => {
  const tempPath = path.join(os.tmpdir(), `prunerr-backup-${Date.now()}.db`);

  try {
    createBackup(tempPath);

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename=prunerr-backup-${stamp}.db`);
    res.setHeader('Content-Length', String(fs.statSync(tempPath).size));

    const stream = fs.createReadStream(tempPath);
    stream.pipe(res);
    // Clean up whether the download completed or the client went away.
    const cleanup = () => fs.rm(tempPath, { force: true }, () => undefined);
    stream.on('close', cleanup);
    stream.on('error', (error) => {
      logger.error('Failed while streaming backup:', error);
      cleanup();
      if (!res.headersSent) res.status(500).end();
    });
  } catch (error) {
    logger.error('Failed to create backup:', error);
    fs.rm(tempPath, { force: true }, () => undefined);
    res.status(500).json({ success: false, error: 'Failed to create backup' });
  }
});

/**
 * POST /api/settings/restore - Replace the database with an uploaded backup.
 *
 * The body is streamed straight to disk rather than buffered: a real library
 * database is far too big to hold in memory.
 */
router.post('/restore', (req: Request, res: Response) => {
  const tempPath = path.join(os.tmpdir(), `prunerr-restore-${Date.now()}.db`);
  const sink = fs.createWriteStream(tempPath);
  const discard = () => fs.rm(tempPath, { force: true }, () => undefined);

  req.pipe(sink);

  sink.on('error', (error) => {
    logger.error('Failed to receive uploaded backup:', error);
    discard();
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: 'Failed to receive the uploaded file' });
    }
  });

  sink.on('finish', () => {
    const validation = validateBackupFile(tempPath);
    if (!validation.valid) {
      discard();
      res.status(400).json({ success: false, error: validation.error });
      return;
    }

    try {
      const { previousDatabasePath } = restoreFromFile(tempPath);
      discard();
      res.json({
        success: true,
        message: 'Database restored',
        data: { previousDatabasePath: path.basename(previousDatabasePath) },
      });
    } catch (error) {
      logger.error('Failed to restore backup:', error);
      discard();
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to restore backup',
      });
    }
  });
});

// POST /api/settings/import - Import settings from JSON
router.post('/import', async (req: Request, res: Response) => {
  try {
    const parsed = ImportSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid settings file format',
        details: parsed.error.issues,
      });
      return;
    }

    const { settings } = parsed.data;

    // Validate setting keys
    const unknownKeys = Object.keys(settings).filter(key => !isKnownSettingKey(key));
    if (unknownKeys.length > 0) {
      logger.warn(`Import contains unknown setting keys: ${unknownKeys.join(', ')}`);
    }

    // Check for expected settings structure (warn if missing common keys)
    const hasServiceSettings = Object.keys(settings).some(k =>
      k.startsWith('plex_') || k.startsWith('tautulli_') || k.startsWith('sonarr_') || k.startsWith('radarr_')
    );
    if (!hasServiceSettings) {
      logger.warn('Imported settings file contains no service configuration');
    }

    // Convert to array format for setMultiple - only import known keys, never
    // import api_key, and never adopt another install's telemetry ID (a shared
    // settings file would otherwise make several installs count as one).
    const settingsArray = Object.entries(settings)
      .filter(([key]) => isKnownSettingKey(key) && !SECRET_SETTING_KEYS.has(key))
      .map(([key, value]) => ({ key, value }));

    if (settingsArray.length === 0) {
      res.status(400).json({
        success: false,
        error: 'No valid settings found in import file',
        details: unknownKeys.length > 0
          ? `Unknown keys ignored: ${unknownKeys.slice(0, 5).join(', ')}${unknownKeys.length > 5 ? '...' : ''}`
          : 'File appears to be empty or incorrectly formatted',
      });
      return;
    }

    const imported = settingsRepo.setMultiple(settingsArray);

    logger.info(`Imported ${imported.length} settings`);

    // Refresh services with new settings
    refreshServices();
    await initializeServices();

    res.json({
      success: true,
      message: `Successfully imported ${imported.length} settings`,
      data: {
        count: imported.length,
        skipped: unknownKeys.length,
        skippedKeys: unknownKeys.length > 0 ? unknownKeys.slice(0, 5) : undefined,
      },
    });
  } catch (error) {
    logger.error('Failed to import settings:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to import settings',
    });
  }
});

// ============================================================================
/** The API key card's payload: the key, whether it is accepted, and how it has been used. */
function apiKeyInfo() {
  return {
    apiKey: getApiKey(),
    enabled: isApiKeyEnabled(),
    fromEnv: Boolean(process.env['PRUNERR_API_KEY']),
    usage: getApiKeyUsageSummary(),
  };
}

// GET /api/settings/api-key - The current API key, whether it is enabled, and its usage
router.get('/api-key', (_req: Request, res: Response) => {
  try {
    res.json({ success: true, data: apiKeyInfo() });
  } catch (error) {
    logger.error('Failed to get API key:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve API key',
    });
  }
});

const ApiKeyUpdateSchema = z.object({ enabled: z.boolean() });

// PUT /api/settings/api-key - Switch key access on or off (the key itself is kept)
router.put('/api-key', validateBody(ApiKeyUpdateSchema), (req: Request, res: Response) => {
  try {
    const { enabled } = req.body as z.infer<typeof ApiKeyUpdateSchema>;
    setApiKeyEnabled(enabled);
    auditRequest(req, res, { action: enabled ? 'apiKey.enabled' : 'apiKey.disabled', targetType: 'apiKey' });
    logger.info(`API key access ${enabled ? 'enabled' : 'disabled'} in settings`);
    res.json({ success: true, data: apiKeyInfo() });
  } catch (error) {
    logger.error('Failed to update API key settings:', error);
    res.status(500).json({ success: false, error: 'Failed to update API key settings' });
  }
});

// DELETE /api/settings/api-key/usage - Forget the usage history
router.delete('/api-key/usage', (_req: Request, res: Response) => {
  try {
    clearApiKeyUsage();
    logger.info('API key usage history cleared');
    res.json({ success: true, data: apiKeyInfo() });
  } catch (error) {
    logger.error('Failed to clear API key usage:', error);
    res.status(500).json({ success: false, error: 'Failed to clear API key usage history' });
  }
});

// POST /api/settings/api-key/regenerate - Generate a new API key
router.post('/api-key/regenerate', (_req: Request, res: Response) => {
  try {
    const newKey = crypto.randomBytes(32).toString('hex');
    settingsRepo.set({ key: 'api_key', value: newKey });
    clearApiKeyCache();
    logger.info('API key regenerated');
    auditRequest(_req, res, { action: 'apiKey.regenerated', targetType: 'apiKey' });

    res.json({
      success: true,
      data: apiKeyInfo(),
      message: 'API key regenerated successfully',
    });
  } catch (error) {
    logger.error('Failed to regenerate API key:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to regenerate API key',
    });
  }
});

// GET /api/settings/mcp - The MCP connector: state, endpoint, tool catalogue
router.get('/mcp', (req: Request, res: Response) => {
  try {
    res.json({ success: true, data: getMcpInfo(req) });
  } catch (error) {
    logger.error('Failed to get MCP info:', error);
    res.status(500).json({ success: false, error: 'Failed to retrieve MCP connector state' });
  }
});

const McpUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  allowImmediateDeletion: z.boolean().optional(),
});

// PUT /api/settings/mcp - Toggle the connector and its safety switch
router.put('/mcp', validateBody(McpUpdateSchema), (req: Request, res: Response) => {
  try {
    const { enabled, allowImmediateDeletion } = req.body as z.infer<typeof McpUpdateSchema>;
    if (typeof enabled === 'boolean') {
      setMcpEnabled(enabled);
      logger.info(`MCP connector ${enabled ? 'enabled' : 'disabled'} in settings`);
    }
    if (typeof allowImmediateDeletion === 'boolean') {
      setAllowImmediateDeletion(allowImmediateDeletion);
      logger.info(`MCP immediate deletion ${allowImmediateDeletion ? 'allowed' : 'refused'}`);
    }
    res.json({ success: true, data: getMcpInfo(req) });
  } catch (error) {
    logger.error('Failed to update MCP settings:', error);
    res.status(500).json({ success: false, error: 'Failed to update MCP connector settings' });
  }
});

// GET /api/settings/auth - How login is configured (read-only; it comes from the environment)
router.get('/auth', async (_req: Request, res: Response) => {
  try {
    const config = getAuthConfig();
    res.json({
      success: true,
      data: {
        enabled: config.enabled,
        sessionTtlHours: config.sessionTtlHours,
        activeSessions: config.enabled ? countSessions() : 0,
        warnings: config.warnings,
        roles: ROLE_DESCRIPTIONS,
        local: config.local ? { enabled: true, username: config.local.username, role: config.local.role, usesHash: Boolean(config.local.passwordHash) } : { enabled: false },
        oidc: config.oidc
          ? {
              enabled: true,
              providerName: config.oidc.providerName,
              issuer: config.oidc.issuer,
              clientId: config.oidc.clientId,
              redirectUri: config.oidc.redirectUri,
              scopes: config.oidc.scopes,
              groupsClaim: config.oidc.groupsClaim,
              adminGroups: config.oidc.adminGroups,
              operatorGroups: config.oidc.operatorGroups,
              viewerGroups: config.oidc.viewerGroups,
              defaultRole: config.oidc.defaultRole,
              autoLogin: config.oidc.autoLogin,
              provider: await describeOidcProvider(),
            }
          : { enabled: false },
      },
    });
  } catch (error) {
    logger.error('Failed to get auth settings:', error);
    res.status(500).json({ success: false, error: 'Failed to retrieve login configuration' });
  }
});

// GET /api/settings/:key - Get a specific setting
router.get('/:key', (req: Request, res: Response) => {
  try {
    const { key } = req.params;
    const setting = settingsRepo.getByKey(key as string);

    if (!setting) {
      res.status(404).json({
        success: false,
        error: `Setting not found: ${key}`,
      });
      return;
    }

    res.json({
      success: true,
      data: setting,
    });
  } catch (error) {
    logger.error('Failed to get setting:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve setting',
    });
  }
});

// POST /api/settings - Create or update a setting
router.post('/', validateBody(SettingInputSchema), (req: Request, res: Response) => {
  try {
    const setting = settingsRepo.set(req.body);
    res.status(201).json({
      success: true,
      data: setting,
      message: 'Setting saved successfully',
    });
  } catch (error) {
    logger.error('Failed to save setting:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to save setting',
    });
  }
});

// PUT /api/settings - Save all settings at once
router.put('/', async (req: Request, res: Response) => {
  try {
    const settings = req.body;
    const savedSettings: Array<{ key: string; value: string }> = [];
    // For the audit log: what each saved key held before this request.
    const before = new Map(settingsRepo.getAll().map((s) => [s.key, s.value] as const));

    // Save the selected media server backend (plex | jellyfin | emby)
    if (settings.mediaServerType !== undefined && settings.mediaServerType !== null) {
      const value = String(settings.mediaServerType);
      if (isMediaServerType(value)) {
        settingsRepo.set({ key: 'media_server_type', value });
        savedSettings.push({ key: 'media_server_type', value });
      } else {
        logger.warn(`Ignoring unknown mediaServerType "${value}"`);
      }
    }

    // Save services configuration
    if (settings.services) {
      for (const [service, config] of Object.entries(settings.services)) {
        if (config && typeof config === 'object') {
          const configObj = config as Record<string, string | boolean>;
          for (const [field, value] of Object.entries(configObj)) {
            if (value !== undefined && value !== null && value !== '') {
              const key = `${service}_${field}`;
              settingsRepo.set({ key, value: String(value) });
              savedSettings.push({ key, value: String(value) });
            }
          }
        }
      }
    }

    // Save notifications configuration
    if (settings.notifications) {
      for (const [field, value] of Object.entries(settings.notifications)) {
        if (value !== undefined && value !== null) {
          const key = `notifications_${field}`;
          settingsRepo.set({ key, value: String(value) });
          savedSettings.push({ key, value: String(value) });
        }
      }
    }

    // Save schedule configuration
    if (settings.schedule) {
      for (const [field, value] of Object.entries(settings.schedule)) {
        if (value !== undefined && value !== null) {
          const key = `schedule_${field}`;
          settingsRepo.set({ key, value: String(value) });
          savedSettings.push({ key, value: String(value) });
        }
      }
    }

    // Save Plex sync configuration
    if (settings.plexSync) {
      for (const [field, value] of Object.entries(settings.plexSync)) {
        if (value !== undefined && value !== null) {
          const key = `plexSync_${field}`;
          settingsRepo.set({ key, value: String(value) });
          savedSettings.push({ key, value: String(value) });
        }
      }
    }

    // Save display configuration
    if (settings.display) {
      for (const [field, value] of Object.entries(settings.display)) {
        if (value !== undefined && value !== null) {
          const key = `display_${field}`;
          settingsRepo.set({ key, value: String(value) });
          savedSettings.push({ key, value: String(value) });
        }
      }
    }

    // Save outbound webhook targets (stored as a single JSON array)
    if (settings.webhooks !== undefined) {
      const value = JSON.stringify(Array.isArray(settings.webhooks) ? settings.webhooks : []);
      settingsRepo.set({ key: 'webhooks_targets', value });
      savedSettings.push({ key: 'webhooks_targets', value });
    }

    // Save disk-pressure configuration
    if (settings.diskPressure) {
      for (const [field, value] of Object.entries(settings.diskPressure)) {
        if (value !== undefined && value !== null) {
          const key = `diskPressure_${field}`;
          // `paths` is an array — store as JSON; everything else as a string
          const stored = field === 'paths' ? JSON.stringify(value) : String(value);
          settingsRepo.set({ key, value: stored });
          savedSettings.push({ key, value: stored });
        }
      }
    }

    // Save Archive configuration
    if (settings.archive) {
      for (const [field, value] of Object.entries(settings.archive)) {
        if (value !== undefined && value !== null) {
          const key = `archive_${field}`;
          settingsRepo.set({ key, value: String(value) });
          savedSettings.push({ key, value: String(value) });
        }
      }
    }

    // Update scheduler if schedule or Plex sync settings were changed
    const hasScheduleSettings = savedSettings.some(
      s => s.key.startsWith('schedule_') || s.key.startsWith('plexSync_')
    );
    if (hasScheduleSettings) {
      try {
        const scheduler = getScheduler();

        // Check if scheduling is enabled
        const isEnabled = settings.schedule?.enabled;

        if (isEnabled === false) {
          // Disable the scanLibraries task
          scheduler.disableTask('scanLibraries');
          logger.info('Scheduled scanning disabled');
        } else {
          // Build cron expression from saved schedule settings
          const interval = settings.schedule?.interval || 'daily';
          const time = settings.schedule?.time || '03:00';
          const dayOfWeek = settings.schedule?.dayOfWeek;

          // Parse time (format: "HH:mm")
          const [hour, minute] = time.split(':').map(Number);

          let cronExpression: string;
          switch (interval) {
            case 'hourly':
              cronExpression = `${minute} * * * *`;
              break;
            case 'weekly':
              // dayOfWeek: 0 = Sunday, 1 = Monday, etc.
              cronExpression = `${minute} ${hour} * * ${dayOfWeek ?? 0}`;
              break;
            case 'daily':
            default:
              cronExpression = `${minute} ${hour} * * *`;
              break;
          }

          // Enable the task and update its schedule
          scheduler.enableTask('scanLibraries');
          scheduler.updateSchedule('scanLibraries', cronExpression);
          logger.info(`Scheduler updated with new cron: ${cronExpression}`);
        }

        // Handle auto-process deletion queue setting
        const autoProcess = settings.schedule?.autoProcess;
        if (autoProcess === false) {
          scheduler.disableTask('processDeletionQueue');
          logger.info('Auto-process deletion queue disabled');
        } else if (autoProcess === true) {
          scheduler.enableTask('processDeletionQueue');
          logger.info('Auto-process deletion queue enabled');
        }

        // Handle Plex library sync schedule
        if (settings.plexSync !== undefined) {
          const plexSyncEnabled = settings.plexSync?.enabled;

          if (plexSyncEnabled === false) {
            scheduler.disableTask('syncPlexLibrary');
            logger.info('Scheduled Plex library sync disabled');
          } else {
            const psInterval = settings.plexSync?.interval || 'daily';
            const psTime = settings.plexSync?.time || '02:00';
            const psDayOfWeek = settings.plexSync?.dayOfWeek;
            const [psHour, psMinute] = psTime.split(':').map(Number);

            let psCron: string;
            switch (psInterval) {
              case 'hourly':
                psCron = `${psMinute} * * * *`;
                break;
              case 'weekly':
                psCron = `${psMinute} ${psHour} * * ${psDayOfWeek ?? 0}`;
                break;
              case 'daily':
              default:
                psCron = `${psMinute} ${psHour} * * *`;
                break;
            }

            scheduler.enableTask('syncPlexLibrary');
            scheduler.updateSchedule('syncPlexLibrary', psCron);
            logger.info(`Plex library sync schedule updated: ${psCron}`);
          }
        }
      } catch (error) {
        logger.error('Failed to update scheduler:', error);
        // Don't fail the request - settings are saved, scheduler will pick up on next cycle
      }
    }

    // Apply disk-pressure schedule changes (enable/disable + interval)
    if (savedSettings.some((s) => s.key.startsWith('diskPressure_'))) {
      try {
        applyDiskPressureSchedule();
      } catch (error) {
        logger.error('Failed to update disk-pressure schedule:', error);
        // Settings are saved; scheduler picks up on next restart regardless.
      }
    }

    logger.info(`Saved ${savedSettings.length} settings`);
    const changed = savedSettings.filter((s) => before.get(s.key) !== s.value);
    if (changed.length > 0) {
      auditRequest(req, res, {
        action: 'settings.changed',
        targetType: 'settings',
        details: { changes: changed.map((s) => ({ key: s.key, from: redact(before.get(s.key) ?? null, s.key), to: redact(s.value, s.key) })) },
      });
    }

    // Refresh service instances if service settings were updated
    const hasServiceSettings = savedSettings.some(s =>
      s.key.match(/^(plex|tautulli|tracearr|sonarr|radarr|overseerr)_(url|apiKey|token|api_key)$/)
    );
    if (hasServiceSettings) {
      refreshServices();
      // Reinitialize with new settings
      await initializeServices();
    }

    res.json({
      success: true,
      data: savedSettings,
      message: `${savedSettings.length} settings saved successfully`,
    });
  } catch (error) {
    logger.error('Failed to save settings:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to save settings',
    });
  }
});

// PUT /api/settings/:key - Update a specific setting
router.put('/:key', (req: Request, res: Response) => {
  try {
    const { key } = req.params;
    const { value } = req.body;

    if (typeof value !== 'string') {
      res.status(400).json({
        success: false,
        error: 'Value must be a string',
      });
      return;
    }

    const setting = settingsRepo.set({ key: key as string, value });
    res.json({
      success: true,
      data: setting,
      message: 'Setting updated successfully',
    });
  } catch (error) {
    logger.error('Failed to update setting:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update setting',
    });
  }
});

// DELETE /api/settings/:key - Delete a setting
router.delete('/:key', (req: Request, res: Response) => {
  try {
    const { key } = req.params;
    const deleted = settingsRepo.delete(key as string);

    if (!deleted) {
      res.status(404).json({
        success: false,
        error: `Setting not found: ${key}`,
      });
      return;
    }

    res.json({
      success: true,
      message: 'Setting deleted successfully',
    });
  } catch (error) {
    logger.error('Failed to delete setting:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete setting',
    });
  }
});

// POST /api/settings/bulk - Set multiple settings at once
const BulkSettingsSchema = z.array(SettingInputSchema);

router.post('/bulk', validateBody(BulkSettingsSchema), (req: Request, res: Response) => {
  try {
    const settings = settingsRepo.setMultiple(req.body);
    res.status(201).json({
      success: true,
      data: settings,
      message: `${settings.length} setting(s) saved successfully`,
    });
  } catch (error) {
    logger.error('Failed to save bulk settings:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to save settings',
    });
  }
});

// GET /api/settings/prefix/:prefix - Get settings by prefix
router.get('/prefix/:prefix', (req: Request, res: Response) => {
  try {
    const { prefix } = req.params;
    const settings = settingsRepo.getStartingWith(prefix as string);
    res.json({
      success: true,
      data: settings,
    });
  } catch (error) {
    logger.error('Failed to get settings by prefix:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve settings',
    });
  }
});

// POST /api/settings/test/discord - Test Discord webhook notification
// NOTE: This route must come BEFORE /test/:service to avoid being matched as a service
router.post('/test/discord', async (req: Request, res: Response) => {
  try {
    // Accept webhook URL from request body or fall back to stored setting
    const webhookUrl = req.body.webhookUrl || settingsRepo.getValue('notifications_discordWebhook');

    if (!webhookUrl) {
      res.status(400).json({
        success: false,
        error: 'No Discord webhook URL configured',
        details: 'Enter a webhook URL in the Notifications section and try again.',
      });
      return;
    }

    // Validate Discord webhook URL format
    if (!webhookUrl.startsWith('https://discord.com/api/webhooks/')) {
      res.status(400).json({
        success: false,
        error: 'Invalid Discord webhook URL format',
        details: 'URL must start with https://discord.com/api/webhooks/',
      });
      return;
    }

    // Send test notification with a rich embed (localized to the configured language)
    const notificationService = getNotificationService();
    const t = getFixedT(settingsRepo.getValue('notifications_language') || 'en');
    const result = await notificationService.sendDiscord(webhookUrl, {
      username: t('common.brand'),
      embeds: [{
        title: t('test.title'),
        description: t('test.desc'),
        color: 0x2ecc71,
        fields: [
          { name: t('test.scanAlertsName'), value: t('test.scanAlertsValue'), inline: true },
          { name: t('test.queueAlertsName'), value: t('test.queueAlertsValue'), inline: true },
          { name: t('test.deletionAlertsName'), value: t('test.deletionAlertsValue'), inline: true },
        ],
        footer: { text: t('common.brand') },
        timestamp: new Date().toISOString(),
      }],
    });

    if (result) {
      res.json({
        success: true,
        message: 'Test notification sent successfully! Check your Discord channel.',
      });
    } else {
      res.status(400).json({
        success: false,
        error: 'Failed to send notification',
        details: 'The webhook URL may be invalid or Discord may be unreachable.',
      });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to send test Discord notification:', error);
    res.status(500).json({
      success: false,
      error: `Failed to send notification: ${errorMessage}`,
    });
  }
});

// POST /api/settings/test/:service - Test connection to a service
router.post('/test/:service', async (req: Request, res: Response) => {
  const service = req.params['service'] as string;
  const validServices = ['plex', 'jellyfin', 'emby', 'tautulli', 'tracearr', 'sonarr', 'radarr', 'overseerr', 'unraid'];

  if (!validServices.includes(service)) {
    res.status(400).json({
      success: false,
      error: `Invalid service: ${service}. Valid services are: ${validServices.join(', ')}`,
    });
    return;
  }

  try {
    // Get service configuration from settings or request body
    const url = req.body.url || settingsRepo.getValue(`${service}_url`);
    const apiKey = req.body.apiKey || req.body.api_key || settingsRepo.getValue(`${service}_api_key`);
    const token = req.body.token || settingsRepo.getValue(`${service}_token`);

    if (!url) {
      res.status(400).json({
        success: false,
        error: `No URL configured for ${service}`,
      });
      return;
    }

    let testResult = false;
    let version: string | undefined;
    let serverName: string | undefined;

    switch (service) {
      case 'plex': {
        if (!token) {
          res.status(400).json({
            success: false,
            error: 'No token configured for Plex',
            details: 'Please enter your Plex token. You can find it at https://www.plex.tv/claim/ or in your Plex settings.',
          });
          return;
        }
        try {
          const plexService = new PlexService(url, token);
          testResult = await plexService.testConnection();
          if (!testResult) {
            res.status(400).json({
              success: false,
              error: `Cannot connect to Plex at ${url}`,
              details: 'Check that: 1) Plex is running, 2) The URL is correct (e.g., http://192.168.1.x:32400), 3) The token is correct',
            });
            return;
          }
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : 'Unknown error';
          res.status(400).json({
            success: false,
            error: `Plex connection error: ${errorMsg}`,
            details: `URL: ${url} - Make sure Plex is accessible from this server`,
          });
          return;
        }
        break;
      }
      case 'jellyfin':
      case 'emby': {
        const label = service === 'emby' ? 'Emby' : 'Jellyfin';
        const defaultPort = service === 'emby' ? '8096' : '8096';
        // The Settings UI posts the key as `apiKey`; fall back to the stored
        // value, which lives under the shared `jellyfin_*` namespace for both.
        const jellyfinKey = apiKey || settingsRepo.getValue('jellyfin_apiKey');

        if (!jellyfinKey) {
          res.status(400).json({
            success: false,
            error: `No API key configured for ${label}`,
            details: `Please enter your ${label} API key. You can create one in ${label} under Dashboard > Advanced > API Keys.`,
          });
          return;
        }
        try {
          const jellyfinService = new JellyfinService(url, jellyfinKey, service);
          testResult = await jellyfinService.testConnection();
          if (!testResult) {
            res.status(400).json({
              success: false,
              error: `Cannot connect to ${label} at ${url}`,
              details: `Check that: 1) ${label} is running, 2) The URL is correct (e.g., http://192.168.1.x:${defaultPort}), 3) The API key is correct`,
            });
            return;
          }
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : 'Unknown error';
          res.status(400).json({
            success: false,
            error: `${label} connection error: ${errorMsg}`,
            details: `URL: ${url} - Make sure ${label} is accessible from this server`,
          });
          return;
        }
        break;
      }
      case 'tautulli': {
        if (!apiKey) {
          res.status(400).json({
            success: false,
            error: 'No API key configured for Tautulli',
            details: 'Please enter your Tautulli API key. You can find it in Tautulli Settings > Web Interface > API Key',
          });
          return;
        }
        try {
          const tautulliService = new TautulliService(url, apiKey);
          testResult = await tautulliService.testConnection();
          if (!testResult) {
            res.status(400).json({
              success: false,
              error: `Cannot connect to Tautulli at ${url}`,
              details: 'Check that: 1) Tautulli is running, 2) The URL is correct (e.g., http://192.168.1.x:8181), 3) The API key is correct',
            });
            return;
          }
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : 'Unknown error';
          res.status(400).json({
            success: false,
            error: `Tautulli connection error: ${errorMsg}`,
            details: `URL: ${url} - Make sure Tautulli is accessible from this server`,
          });
          return;
        }
        break;
      }
      case 'tracearr': {
        if (!apiKey) {
          res.status(400).json({
            success: false,
            error: 'No API token configured for Tracearr',
            details: 'Please enter your Tracearr API token. You can find it in Tracearr Settings > API',
          });
          return;
        }
        try {
          const tracearrService = new TracearrService(url, apiKey);
          testResult = await tracearrService.testConnection();
          if (!testResult) {
            res.status(400).json({
              success: false,
              error: `Cannot connect to Tracearr at ${url}`,
              details: 'Check that: 1) Tracearr is running, 2) The URL is correct (e.g., http://192.168.1.x:3004), 3) The API token is correct',
            });
            return;
          }
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : 'Unknown error';
          res.status(400).json({
            success: false,
            error: `Tracearr connection error: ${errorMsg}`,
            details: `URL: ${url} - Make sure Tracearr is accessible from this server`,
          });
          return;
        }
        break;
      }
      case 'sonarr': {
        if (!apiKey) {
          res.status(400).json({
            success: false,
            error: 'No API key configured for Sonarr',
          });
          return;
        }
        const sonarrService = new SonarrService(url, apiKey);
        testResult = await sonarrService.testConnection();
        break;
      }
      case 'radarr': {
        if (!apiKey) {
          res.status(400).json({
            success: false,
            error: 'No API key configured for Radarr',
          });
          return;
        }
        const radarrService = new RadarrService(url, apiKey);
        testResult = await radarrService.testConnection();
        break;
      }
      case 'overseerr': {
        if (!apiKey) {
          res.status(400).json({
            success: false,
            error: 'No API key configured for Overseerr',
          });
          return;
        }
        const overseerrService = new OverseerrService(url, apiKey);
        testResult = await overseerrService.testConnection();
        break;
      }
      case 'unraid': {
        if (!apiKey) {
          res.status(400).json({
            success: false,
            error: 'No API key configured for Unraid',
            details: 'Please enter your Unraid API key. You can generate one in Unraid Settings > Management Access > API Keys',
          });
          return;
        }
        try {
          const unraidService = new UnraidService(url, apiKey);
          testResult = await unraidService.testConnection();
          if (!testResult) {
            res.status(400).json({
              success: false,
              error: `Cannot connect to Unraid at ${url}`,
              details: 'Check that: 1) Unraid is running, 2) The URL is correct (e.g., https://tower.local or http://192.168.1.x), 3) The API key is correct',
            });
            return;
          }
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : 'Unknown error';
          res.status(400).json({
            success: false,
            error: `Unraid connection error: ${errorMsg}`,
            details: `URL: ${url} - Make sure Unraid is accessible from this server and the GraphQL API is enabled`,
          });
          return;
        }
        break;
      }
    }

    if (testResult) {
      res.json({
        success: true,
        message: `Successfully connected to ${service}`,
        data: {
          service,
          connected: true,
          version,
          serverName,
        },
      });
    } else {
      res.status(400).json({
        success: false,
        error: `Failed to connect to ${service}`,
        data: {
          service,
          connected: false,
        },
      });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`Failed to test ${service} connection:`, error);
    res.status(500).json({
      success: false,
      error: `Failed to test ${service} connection: ${errorMessage}`,
      data: {
        service,
        connected: false,
      },
    });
  }
});

export default router;
