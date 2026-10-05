import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import settingsRepo from '../../db/repositories/settings';
import { getConfiguredServerType, getMediaServerLabel } from '../../services/mediaServer';
import { getAppVersion } from '../../utils/version';
import { defaultDeletionAction, defaultGracePeriodDays } from '../../services/mediaActions';
import { PlexService, TautulliService, SonarrService, RadarrService, OverseerrService, UnraidService } from '../../services';
import { TracearrService } from '../../services/tracearr';
import { JellyfinService } from '../../services/jellyfin';
import { allowsImmediateDeletion } from '../config';
import { EXTERNAL_READ, READ_ONLY, defineTool, fail, ok } from '../helpers';
import { listAudit, verifyAuditChain } from '../../services/audit';
import { getAvailabilityStatus } from '../../services/availability';
import taskRunsRepo from '../../db/repositories/taskRuns';
import { listJobs } from '../../services/deletionJobs';
import { getScheduler } from '../../scheduler';
import {
  ServiceNotConfiguredError,
  getDeletionSetup,
  getServiceActivity,
  getServiceHealth,
  getServiceLogs,
} from '../../services/serviceDiagnostics';

const SERVICES = ['plex', 'jellyfin', 'emby', 'tautulli', 'tracearr', 'sonarr', 'radarr', 'overseerr', 'unraid'] as const;

/** Credentials never leave the server; this reports presence, not value. */
function serviceSummary(name: string, credentialKeys: string[]) {
  const url = settingsRepo.getValue(`${name}_url`);
  const hasCredential = credentialKeys.some((k) => Boolean(settingsRepo.getValue(`${name}_${k}`)));
  return { url: url || null, configured: Boolean(url && hasCredential) };
}

export function registerSystemTools(server: McpServer): void {
  defineTool(
    server,
    {
      name: 'get_task_status',
      title: 'Background tasks: running now and recent runs',
      description:
        'What Prunerr is doing in the background: the Archive availability pass in progress (current title, done/total), paused apps, active deletion jobs, and the last runs of every scheduled task with duration and outcome. Use list_scheduled_tasks for schedules and next runs.',
      group: 'system',
      inputSchema: { limit: z.number().int().min(1).max(100).optional().describe('Recent runs to include (default 20).') },
      annotations: READ_ONLY,
      minRole: 'viewer',
    },
    async ({ limit }) => {
      const archive = getAvailabilityStatus();
      const jobs = listJobs(5);
      const recent = taskRunsRepo.list(limit ?? 20);
      const running = getScheduler().getStatus().filter((j) => j.isRunning).map((j) => j.name);
      return ok(
        { running: { scheduledTasks: running, availabilityPass: archive.pass, archivePaused: archive.paused, unchecked: archive.unchecked, deletionJobs: jobs.active }, recent },
        `${running.length + (archive.pass ? 1 : 0) + jobs.active.length} thing(s) running; ${recent.filter((r) => r.success === false).length} of the last ${recent.length} runs failed.`
      );
    }
  );

  defineTool(
    server,
    {
      name: 'list_audit_log',
      title: 'Audit log',
      description:
        'The tamper-evident audit log: who did what, when, from where (web, API key, MCP, scheduler). Covers logins, settings changes, rule changes, every queue/protect/archive/delete decision, folder deletes and MCP tool calls that change something. Entries are hash-chained; use verify_audit_log to prove none were altered. Newest first.',
      group: 'system',
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional().describe('Default 50.'),
        offset: z.number().int().min(0).optional(),
        action: z.string().max(80).optional().describe('Prefix filter, e.g. "item.", "auth.", "settings.", "mcp.".'),
        actor: z.string().max(80).optional().describe('Substring of the actor name or id.'),
        search: z.string().max(120).optional().describe('Substring of the target title, action or details.'),
        since: z.string().max(40).optional().describe('ISO timestamp; only entries at or after it.'),
      },
      annotations: READ_ONLY,
      minRole: 'viewer',
    },
    async (args) => {
      const result = listAudit(args);
      return ok({ total: result.total, entries: result.entries }, `${result.total} matching audit entr${result.total === 1 ? 'y' : 'ies'}; showing ${result.entries.length}.`);
    }
  );

  defineTool(
    server,
    {
      name: 'verify_audit_log',
      title: 'Verify the audit log chain',
      description: 'Recompute every hash in the audit log and check the anchor file. Reports the first broken entry if the log has been altered.',
      group: 'system',
      annotations: READ_ONLY,
      minRole: 'operator',
    },
    async () => {
      const result = verifyAuditChain();
      return ok(result, result.ok ? `Audit chain intact: ${result.entries} entries.` : `AUDIT CHAIN BROKEN: ${result.firstBreak ? `entry #${result.firstBreak.id} (${result.firstBreak.reason})` : 'anchor mismatch'}.`);
    }
  );

  defineTool(
    server,
    {
      name: 'get_settings_summary',
      title: 'Settings summary',
      description:
        'A redacted view of how this Prunerr is configured: which services are connected (URLs only, never keys), the media server type, scan and sync schedules, deletion defaults, disk-pressure settings, exclusions, notification channels, and MCP safety switches.',
      group: 'system',
      annotations: READ_ONLY,
    },
    async () => {
      const prefixed = (prefix: string) =>
        Object.fromEntries(
          settingsRepo
            .getStartingWith(prefix)
            .filter((s) => !/apikey|api_key|token|secret|webhook/i.test(s.key))
            .map((s) => [s.key.slice(prefix.length), s.value])
        );
      let exclusionPatterns: unknown[] = [];
      let excludedLibraryKeys: string[] = [];
      let webhooks: Array<Record<string, unknown>> = [];
      try { exclusionPatterns = JSON.parse(settingsRepo.getValue('exclusion_patterns') ?? '[]'); } catch { /* ignore */ }
      try { excludedLibraryKeys = JSON.parse(settingsRepo.getValue('excluded_library_keys') ?? '[]'); } catch { /* ignore */ }
      try { webhooks = JSON.parse(settingsRepo.getValue('webhooks_targets') ?? '[]'); } catch { /* ignore */ }

      const data = {
        version: getAppVersion(),
        mediaServer: { type: getConfiguredServerType(), label: getMediaServerLabel() },
        services: {
          plex: serviceSummary('plex', ['token']),
          jellyfin: serviceSummary('jellyfin', ['apiKey', 'api_key']),
          sonarr: serviceSummary('sonarr', ['apiKey']),
          radarr: serviceSummary('radarr', ['apiKey']),
          tautulli: serviceSummary('tautulli', ['apiKey']),
          tracearr: serviceSummary('tracearr', ['apiKey']),
          overseerr: serviceSummary('overseerr', ['apiKey']),
          unraid: serviceSummary('unraid', ['apiKey']),
        },
        watchHistory: prefixed('watch_history_'),
        schedule: prefixed('schedule_'),
        librarySync: prefixed('plexSync_'),
        diskPressure: prefixed('diskPressure_'),
        deletionDefaults: { gracePeriodDays: defaultGracePeriodDays(), deletionAction: defaultDeletionAction() },
        exclusions: { patterns: exclusionPatterns, excludedLibraryKeys },
        notifications: {
          discordEnabled: settingsRepo.getBoolean('notifications_discordEnabled', false),
          language: settingsRepo.getValue('notifications_language') ?? 'en',
          webhookTargets: webhooks.map((w) => ({ name: w['name'] ?? null, enabled: w['enabled'] ?? null, events: w['events'] ?? null })),
        },
        mcp: { immediateDeletionAllowed: allowsImmediateDeletion() },
      };
      const connected = Object.entries(data.services).filter(([, v]) => v.configured).map(([k]) => k);
      return ok(data, `Prunerr ${data.version} on ${data.mediaServer.label}. Configured services: ${connected.join(', ') || 'none'}.`);
    }
  );

  defineTool(
    server,
    {
      name: 'test_connection',
      title: 'Test a service connection',
      description: 'Check that Prunerr can reach one configured service with its stored credentials.',
      group: 'system',
      inputSchema: { service: z.enum(SERVICES) },
      annotations: EXTERNAL_READ,
    },
    async ({ service }) => {
      const url = settingsRepo.getValue(`${service}_url`);
      const apiKey = settingsRepo.getValue(`${service}_apiKey`) ?? settingsRepo.getValue(`${service}_api_key`);
      const token = settingsRepo.getValue(`${service}_token`);
      if (!url) return fail(`No URL configured for ${service}`);

      const started = Date.now();
      let connected = false;
      try {
        switch (service) {
          case 'plex':
            if (!token) return fail('No token configured for Plex');
            connected = await new PlexService(url, token).testConnection();
            break;
          case 'jellyfin':
          case 'emby': {
            const key = apiKey ?? settingsRepo.getValue('jellyfin_apiKey');
            if (!key) return fail(`No API key configured for ${service}`);
            connected = await new JellyfinService(url, key, service).testConnection();
            break;
          }
          case 'tautulli':
            if (!apiKey) return fail('No API key configured for Tautulli');
            connected = await new TautulliService(url, apiKey).testConnection();
            break;
          case 'tracearr':
            if (!apiKey) return fail('No API token configured for Tracearr');
            connected = await new TracearrService(url, apiKey).testConnection();
            break;
          case 'sonarr':
            if (!apiKey) return fail('No API key configured for Sonarr');
            connected = await new SonarrService(url, apiKey).testConnection();
            break;
          case 'radarr':
            if (!apiKey) return fail('No API key configured for Radarr');
            connected = await new RadarrService(url, apiKey).testConnection();
            break;
          case 'overseerr':
            if (!apiKey) return fail('No API key configured for Overseerr');
            connected = await new OverseerrService(url, apiKey).testConnection();
            break;
          case 'unraid':
            if (!apiKey) return fail('No API key configured for Unraid');
            connected = await new UnraidService(url, apiKey).testConnection();
            break;
        }
      } catch (error) {
        return ok(
          { service, url, connected: false, error: error instanceof Error ? error.message : String(error), responseTimeMs: Date.now() - started },
          `${service} at ${url}: connection error.`
        );
      }
      return ok({ service, url, connected, responseTimeMs: Date.now() - started }, `${service} at ${url}: ${connected ? 'connected' : 'not reachable'}.`);
    }
  );

  const diagService = z.enum(['sonarr', 'radarr']).describe('Which app to ask.');
  const diagError = (error: unknown) =>
    fail(error instanceof ServiceNotConfiguredError ? error.message : `Could not reach the service: ${error instanceof Error ? error.message : String(error)}`);

  defineTool(
    server,
    {
      name: 'get_service_logs',
      title: 'Read Sonarr/Radarr logs',
      description:
        "Recent entries from Sonarr's or Radarr's own log, newest first, for troubleshooting a deletion that is slow or failed. Filter by level (info, warn, error), text (a title or file name) and time. Deletion problems show up under MediaFileDeletionService, RecycleBinProvider and DiskTransferService.",
      group: 'system',
      inputSchema: {
        service: diagService,
        level: z.enum(['info', 'warn', 'error']).optional().describe('Lowest level to include (default warn).'),
        search: z.string().max(200).optional().describe('Case-insensitive text to match in message, logger or exception.'),
        sinceMinutes: z.number().int().min(1).max(10080).optional().describe('Only entries from the last N minutes.'),
        limit: z.number().int().min(1).max(200).optional().describe('Default 50.'),
      },
      annotations: EXTERNAL_READ,
    },
    async ({ service, level, search, sinceMinutes, limit }) => {
      try {
        const result = await getServiceLogs(service, {
          level: level ?? 'warn',
          search,
          limit: limit ?? 50,
          since: sinceMinutes ? new Date(Date.now() - sinceMinutes * 60_000) : undefined,
        });
        const errors = result.records.filter((r) => r.level.toLowerCase() === 'error').length;
        return ok(
          { service, level: result.level, count: result.records.length, lines: result.lines, records: result.records },
          `${result.records.length} ${result.level}+ log entries from ${service} (${errors} errors).${result.lines.length > 0 ? ` Newest: ${result.lines[0]}` : ''}`
        );
      } catch (error) {
        return diagError(error);
      }
    }
  );

  defineTool(
    server,
    {
      name: 'get_service_health',
      title: 'Sonarr/Radarr health checks',
      description: "The app's own health check results (root folders, indexers, download clients, updates) plus its version and start time.",
      group: 'system',
      inputSchema: { service: diagService },
      annotations: EXTERNAL_READ,
    },
    async ({ service }) => {
      try {
        const result = await getServiceHealth(service);
        return ok(
          result,
          result.health.length === 0
            ? `${service} ${result.version ?? ''} reports no health problems.`
            : `${service} ${result.version ?? ''} reports ${result.health.length} health item(s): ${result.health.map((h) => `[${h.type}] ${h.message}`).join('; ')}`
        );
      } catch (error) {
        return diagError(error);
      }
    }
  );

  defineTool(
    server,
    {
      name: 'get_service_activity',
      title: "What Sonarr/Radarr is doing",
      description: "The app's command queue: tasks running right now (a long-running file delete, a rescan, an RSS sync), tasks waiting, and the last few finished ones with their durations.",
      group: 'system',
      inputSchema: { service: diagService },
      annotations: EXTERNAL_READ,
    },
    async ({ service }) => {
      try {
        const result = await getServiceActivity(service);
        return ok(
          result,
          `${service}: ${result.running.length} running (${result.running.map((c) => c.name).join(', ') || 'none'}), ${result.queued.length} queued.`
        );
      } catch (error) {
        return diagError(error);
      }
    }
  );

  defineTool(
    server,
    {
      name: 'get_deletion_setup',
      title: 'How Sonarr/Radarr deletes files',
      description:
        "The app's recycling bin setting and root folders, with warnings when the setup makes deletes slow or fragile — typically a recycling bin on a different filesystem than a root folder, which turns every delete into a full copy of the file.",
      group: 'system',
      inputSchema: { service: diagService },
      annotations: EXTERNAL_READ,
    },
    async ({ service }) => {
      try {
        const result = await getDeletionSetup(service);
        return ok(
          result,
          `${service}: recycling bin ${result.recycleBin ?? 'off (files are deleted directly)'}; ${result.rootFolders.length} root folder(s). ${result.warnings.length > 0 ? `Warnings: ${result.warnings.join(' ')}` : 'No warnings.'}`
        );
      } catch (error) {
        return diagError(error);
      }
    }
  );

}
