/**
 * Live connectivity of every configured service plus the scheduler's state —
 * the dashboard's health card, and the MCP connector's `get_system_health`.
 */
import { getScheduler } from '../scheduler';
import * as scanHistoryRepo from '../db/repositories/scanHistoryRepo';
import {
  getPlexService,
  getRadarrService,
  getSonarrService,
  getTautulliService,
  getTracearrService,
  getOverseerrService,
} from './init';
import { getConfiguredServerType, getMediaServerLabel, type MediaServerType } from './mediaServer';
import { getLastSyncCompletedAt, getLastSyncFinishedAt, getLastSyncSuccess } from './syncCoordinator';

export interface ServiceHealthStatus {
  service: string;
  configured: boolean;
  connected: boolean;
  responseTimeMs?: number;
  error?: string;
  lastChecked: string;
}

export interface SchedulerStatus {
  isRunning: boolean;
  lastScan: string | null;
  nextRun: string | null;
  scanSchedule: string;
  /** last successful media-server sync */
  lastSync: string | null;
  /** last sync attempt finish (success OR failure) */
  lastSyncAt: string | null;
  /** whether that finish was a success */
  lastSyncSuccess: boolean | null;
  nextSync: string | null;
  syncSchedule: string;
}

export interface SystemHealthResponse {
  services: ServiceHealthStatus[];
  scheduler: SchedulerStatus;
  overall: 'healthy' | 'degraded' | 'unhealthy';
  /**
   * Which backend the 'plex' service entry actually refers to. The entry keeps
   * its historical key so existing clients keep resolving it; this field lets
   * the UI label it correctly for Jellyfin/Emby installs.
   */
  mediaServerType: MediaServerType;
  mediaServerLabel: string;
}

async function checkService(
  name: string,
  service: { testConnection: () => Promise<boolean> } | null
): Promise<ServiceHealthStatus> {
  const lastChecked = new Date().toISOString();

  if (!service) {
    return { service: name, configured: false, connected: false, lastChecked };
  }

  const startTime = Date.now();
  try {
    // Race the connection test against a 5-second timeout
    const connected = await Promise.race([
      service.testConnection(),
      new Promise<boolean>((_, reject) => setTimeout(() => reject(new Error('Connection timeout')), 5000)),
    ]);

    return {
      service: name,
      configured: true,
      connected,
      responseTimeMs: Date.now() - startTime,
      lastChecked,
    };
  } catch (error) {
    return {
      service: name,
      configured: true,
      connected: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      responseTimeMs: Date.now() - startTime,
      lastChecked,
    };
  }
}

export function determineOverallHealth(services: ServiceHealthStatus[]): 'healthy' | 'degraded' | 'unhealthy' {
  const configuredServices = services.filter((s) => s.configured);
  if (configuredServices.length === 0) return 'unhealthy';

  const connectedCount = configuredServices.filter((s) => s.connected).length;
  if (connectedCount === configuredServices.length) return 'healthy';
  if (connectedCount > 0) return 'degraded';
  return 'unhealthy';
}

export async function getSystemHealth(): Promise<SystemHealthResponse> {
  const serverType = getConfiguredServerType();

  const serviceNames = ['plex', 'radarr', 'sonarr', 'tautulli', 'tracearr', 'overseerr'];
  const serviceChecks = await Promise.allSettled([
    checkService('plex', getPlexService()),
    checkService('radarr', getRadarrService()),
    checkService('sonarr', getSonarrService()),
    checkService('tautulli', getTautulliService()),
    checkService('tracearr', getTracearrService()),
    checkService('overseerr', getOverseerrService()),
  ]);

  const services: ServiceHealthStatus[] = serviceChecks.map((result, index) => {
    if (result.status === 'fulfilled') {
      return result.value;
    }
    return {
      service: serviceNames[index] || 'unknown',
      configured: false,
      connected: false,
      error: result.reason instanceof Error ? result.reason.message : 'Check failed',
      lastChecked: new Date().toISOString(),
    };
  });

  const scheduler = getScheduler();
  const scanJobStatus = scheduler.getJobStatus('scanLibraries');
  const syncJobStatus = scheduler.getJobStatus('syncPlexLibrary');
  const schedulerConfig = scheduler.getConfig();

  const latestScan = scanHistoryRepo.getLatest();
  const lastSyncCompletedAt = getLastSyncCompletedAt();
  const lastSyncFinishedAt = getLastSyncFinishedAt();
  const lastSyncSuccess = getLastSyncSuccess();

  return {
    services,
    scheduler: {
      isRunning: scheduler.isSchedulerRunning(),
      lastScan: latestScan?.completed_at || latestScan?.started_at || null,
      nextRun: scanJobStatus?.nextRun?.toISOString() || null,
      scanSchedule: schedulerConfig.schedules.scanLibraries,
      lastSync: lastSyncCompletedAt?.toISOString() || null,
      lastSyncAt: lastSyncFinishedAt?.toISOString() || null,
      lastSyncSuccess,
      nextSync: syncJobStatus?.nextRun?.toISOString() || null,
      syncSchedule: schedulerConfig.schedules.syncPlexLibrary,
    },
    overall: determineOverallHealth(services),
    mediaServerType: serverType,
    mediaServerLabel: getMediaServerLabel(serverType),
  };
}
