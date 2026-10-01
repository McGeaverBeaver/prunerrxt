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
}
