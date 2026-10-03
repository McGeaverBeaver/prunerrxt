/**
 * Read-only diagnostics shared by the Sonarr and Radarr clients: their logs,
 * health checks, running commands, root folders and media-management config.
 *
 * Prunerr only ever sees the HTTP answer to a delete. When Radarr spends
 * minutes copying a file into a recycle bin on another filesystem, or throws
 * a RecycleBinException and leaves the file in place, that story is in
 * Radarr's own log — so the deletion pipeline reads it, and so can the user
 * and the MCP connector, without opening another app.
 */
import type { AxiosInstance } from 'axios';
import logger from '../utils/logger';

export type ArrLogLevel = 'info' | 'warn' | 'error';

export interface ArrLogRecord {
  id: number;
  time: string;
  level: string;
  logger: string;
  message: string;
  exception?: string;
  exceptionType?: string;
}

export interface ArrHealthItem {
  source: string;
  type: string;
  message: string;
  wikiUrl?: string;
}

export interface ArrCommand {
  id: number;
  name: string;
  commandName?: string;
  status: string;
  queued?: string;
  started?: string;
  ended?: string;
  duration?: string;
  message?: string;
  trigger?: string;
}

export interface ArrRootFolder {
  id: number;
  path: string;
  accessible: boolean;
  freeSpace?: number;
  unmappedFolders?: unknown[];
}

export interface ArrMediaManagementConfig {
  recycleBin: string;
  recycleBinCleanupDays: number;
  deleteEmptyFolders?: boolean;
  copyUsingHardlinks?: boolean;
  [key: string]: unknown;
}

export interface ArrSystemStatus {
  version: string;
  appName?: string;
  osName?: string;
  isDocker?: boolean;
  startTime?: string;
  [key: string]: unknown;
}

export interface FetchLogsOptions {
  /** Lowest level to include; the app's own filter, re-checked here. */
  level?: ArrLogLevel;
  /** Most recent first; capped at 200. */
  limit?: number;
  /** Case-insensitive substring over message, logger and exception. */
  search?: string;
  /** Only records at or after this time. */
  since?: Date;
}

const LEVEL_RANK: Record<string, number> = { trace: 0, debug: 1, info: 2, warn: 3, error: 4, fatal: 5 };

function levelRank(level: string): number {
  return LEVEL_RANK[level.toLowerCase()] ?? 2;
}

export async function fetchLogs(client: AxiosInstance, options: FetchLogsOptions = {}): Promise<ArrLogRecord[]> {
  const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
  const level = options.level ?? 'info';
  // Ask for more than we need: the app-side level filter is advisory and the
  // search/since filters run here.
  const pageSize = Math.min(500, Math.max(limit * 2, 100));
  const response = await client.get('/log', {
    params: {
      page: 1,
      pageSize,
      sortKey: 'time',
      sortDirection: 'descending',
      ...(level !== 'info' ? { level } : {}),
    },
  });
  const records: ArrLogRecord[] = Array.isArray(response.data?.records) ? response.data.records : [];
  const needle = options.search?.trim().toLowerCase();
  const sinceMs = options.since?.getTime();
  return records
    .filter((r) => levelRank(r.level) >= levelRank(level))
    .filter((r) => sinceMs === undefined || new Date(r.time).getTime() >= sinceMs)
    .filter((r) => {
      if (!needle) return true;
      return [r.message, r.logger, r.exception, r.exceptionType].some((f) => f && f.toLowerCase().includes(needle));
    })
    .slice(0, limit);
}

export async function fetchHealth(client: AxiosInstance): Promise<ArrHealthItem[]> {
  const response = await client.get('/health');
  return Array.isArray(response.data) ? response.data : [];
}

export async function fetchSystemStatus(client: AxiosInstance): Promise<ArrSystemStatus> {
  const response = await client.get('/system/status');
  return response.data ?? {};
}

export async function fetchCommands(client: AxiosInstance): Promise<ArrCommand[]> {
  const response = await client.get('/command');
  return Array.isArray(response.data) ? response.data : [];
}

export async function fetchRootFolders(client: AxiosInstance): Promise<ArrRootFolder[]> {
  const response = await client.get('/rootfolder');
  return Array.isArray(response.data) ? response.data : [];
}

export async function fetchMediaManagementConfig(client: AxiosInstance): Promise<ArrMediaManagementConfig> {
  const response = await client.get('/config/mediamanagement');
  return response.data ?? { recycleBin: '', recycleBinCleanupDays: 0 };
}

/** Loggers inside Sonarr/Radarr that speak for a file delete. */
const DELETE_LOGGERS = ['MediaFileDeletionService', 'RecycleBinProvider', 'DiskTransferService', 'DiskProvider', 'EpisodeFileDeletionService'];

/**
 * The newest error the app logged about a delete since `since`, as one line,
 * or null. Used while a delete is being verified: a RecycleBinException in
 * the log means waiting any longer is pointless. Never throws; a log that
 * cannot be read simply means "no evidence".
 */
export async function recentDeleteFailure(
  client: AxiosInstance,
  since: Date,
  needle?: string
): Promise<string | null> {
  try {
    const records = await fetchLogs(client, { level: 'error', limit: 50, since });
    const match = records.find((r) => {
      const fromDeleteLogger = DELETE_LOGGERS.some((name) => r.logger?.endsWith(name));
      const mentionsFile = needle ? [r.message, r.exception].some((f) => f && f.toLowerCase().includes(needle.toLowerCase())) : false;
      return fromDeleteLogger || mentionsFile;
    });
    if (!match) return null;
    return formatLogLine(match);
  } catch (error) {
    logger.debug(`Could not read the service log while verifying a delete: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** `2026-10-03T12:02:11Z [Error] RecycleBinProvider: Unable to move …` */
export function formatLogLine(record: ArrLogRecord): string {
  const detail = record.exception ? ` — ${firstLine(record.exception)}` : '';
  return `${record.time} [${capitalise(record.level)}] ${shortLogger(record.logger)}: ${record.message}${detail}`;
}

function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim().length > 0) ?? text;
  return line.trim().slice(0, 300);
}

function shortLogger(name: string | undefined): string {
  if (!name) return 'App';
  return name.split('.').pop() ?? name;
}

function capitalise(text: string): string {
  return text ? text[0]!.toUpperCase() + text.slice(1).toLowerCase() : text;
}
