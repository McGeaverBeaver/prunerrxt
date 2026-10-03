/**
 * Troubleshooting Sonarr and Radarr from inside Prunerr.
 *
 * The REST routes and the MCP tools both come here, so a user in the browser
 * and an assistant on the connector see the same logs, the same health
 * checks and the same reading of the deletion setup.
 */
import { getRadarrService, getSonarrService } from './init';
import {
  fetchCommands,
  fetchHealth,
  fetchLogs,
  fetchMediaManagementConfig,
  fetchRootFolders,
  fetchSystemStatus,
  formatLogLine,
  type ArrCommand,
  type ArrHealthItem,
  type ArrLogLevel,
  type ArrLogRecord,
  type ArrRootFolder,
  type FetchLogsOptions,
} from './arrDiagnostics';

export type DiagnosticsService = 'sonarr' | 'radarr';
export const DIAGNOSTICS_SERVICES: readonly DiagnosticsService[] = ['sonarr', 'radarr'];

export function isDiagnosticsService(value: string): value is DiagnosticsService {
  return (DIAGNOSTICS_SERVICES as readonly string[]).includes(value);
}

export function serviceLabel(service: DiagnosticsService): 'Sonarr' | 'Radarr' {
  return service === 'sonarr' ? 'Sonarr' : 'Radarr';
}

export class ServiceNotConfiguredError extends Error {
  constructor(service: DiagnosticsService) {
    super(`${serviceLabel(service)} is not configured`);
    this.name = 'ServiceNotConfiguredError';
  }
}

function clientFor(service: DiagnosticsService) {
  const instance = service === 'sonarr' ? getSonarrService() : getRadarrService();
  if (!instance) throw new ServiceNotConfiguredError(service);
  return instance.httpClient;
}

export interface ServiceLogsResult {
  service: DiagnosticsService;
  level: ArrLogLevel;
  records: ArrLogRecord[];
  lines: string[];
}

export async function getServiceLogs(service: DiagnosticsService, options: FetchLogsOptions = {}): Promise<ServiceLogsResult> {
  const records = await fetchLogs(clientFor(service), options);
  return { service, level: options.level ?? 'info', records, lines: records.map(formatLogLine) };
}

export interface ServiceHealthResult {
  service: DiagnosticsService;
  version: string | null;
  startTime: string | null;
  health: ArrHealthItem[];
}

export async function getServiceHealth(service: DiagnosticsService): Promise<ServiceHealthResult> {
  const client = clientFor(service);
  const [status, health] = await Promise.all([fetchSystemStatus(client), fetchHealth(client)]);
  return {
    service,
    version: typeof status.version === 'string' ? status.version : null,
    startTime: typeof status.startTime === 'string' ? status.startTime : null,
    health,
  };
}

export interface ServiceActivityResult {
  service: DiagnosticsService;
  running: ArrCommand[];
  queued: ArrCommand[];
  recent: ArrCommand[];
}

/** What the app is busy with right now: its command queue. */
export async function getServiceActivity(service: DiagnosticsService): Promise<ServiceActivityResult> {
  const commands = await fetchCommands(clientFor(service));
  const status = (c: ArrCommand) => (c.status || '').toLowerCase();
  return {
    service,
    running: commands.filter((c) => status(c) === 'started' || status(c) === 'running'),
    queued: commands.filter((c) => status(c) === 'queued'),
    recent: commands.filter((c) => !['started', 'running', 'queued'].includes(status(c))).slice(0, 20),
  };
}

export interface DeletionSetupResult {
  service: DiagnosticsService;
  recycleBin: string | null;
  recycleBinCleanupDays: number | null;
  rootFolders: Array<ArrRootFolder & { sameMountAsRecycleBin: boolean | null }>;
  warnings: string[];
}

function topLevel(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[0] ?? '';
}

/**
 * How this app deletes files, and whether that is going to hurt. A recycle
 * bin on a different mount than a root folder means every delete is a full
 * copy across filesystems: minutes per file on network storage, and the
 * failure mode that leaves half-copied files behind.
 */
export async function getDeletionSetup(service: DiagnosticsService): Promise<DeletionSetupResult> {
  const client = clientFor(service);
  const [config, rootFolders] = await Promise.all([fetchMediaManagementConfig(client), fetchRootFolders(client)]);
  const recycleBin = config.recycleBin?.trim() ? config.recycleBin.trim() : null;
  const warnings: string[] = [];

  const folders = rootFolders.map((folder) => {
    const sameMount = recycleBin ? topLevel(folder.path) === topLevel(recycleBin) : null;
    if (!folder.accessible) warnings.push(`Root folder ${folder.path} is not accessible to ${serviceLabel(service)}.`);
    if (recycleBin && sameMount === false) {
      warnings.push(
        `Root folder ${folder.path} and the recycling bin ${recycleBin} are on different top-level paths. If those are different filesystems inside the ${serviceLabel(service)} container, every delete from this folder copies the whole file into the bin before removing it — minutes per file on network storage — and a copy that fails leaves the original in place.`
      );
    }
    return { ...folder, sameMountAsRecycleBin: sameMount };
  });

  if (recycleBin && (config.recycleBinCleanupDays ?? 0) === 0) {
    warnings.push(`The recycling bin ${recycleBin} is never cleaned up automatically (cleanup days is 0); deleted files keep using space until emptied by hand.`);
  }

  return {
    service,
    recycleBin,
    recycleBinCleanupDays: recycleBin ? config.recycleBinCleanupDays ?? null : null,
    rootFolders: folders,
    warnings,
  };
}
