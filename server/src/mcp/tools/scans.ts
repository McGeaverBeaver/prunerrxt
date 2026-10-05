import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import rulesRepo from '../../db/repositories/rules';
import scanHistoryRepo from '../../db/repositories/scanHistoryRepo';
import { scanLibraries } from '../../scheduler/tasks';
import { getScheduler } from '../../scheduler';
import {
  getLastSyncCompletedAt,
  getLastSyncFinishedAt,
  getLastSyncSuccess,
  getSyncProgressLog,
  isSyncInProgress,
  runLibrarySync,
} from '../../services/syncCoordinator';
import { getMediaServerLabel } from '../../services/mediaServer';
import logger from '../../utils/logger';
import { MUTATING, READ_ONLY, clampLimit, defineTool, fail, ok } from '../helpers';

// One manual scan at a time, shared with the REST route's own guard through
// the scan_history "running" row.
let scanInProgress = false;

export function registerScanTools(server: McpServer): void {
  defineTool(
    server,
    {
      name: 'trigger_scan',
      title: 'Run a rules scan',
      description:
        'Evaluate every enabled rule against the library now, exactly like the scheduled scan: matches are queued for deletion after their grace period (or flagged). Runs in the background; poll get_scan_status. Nothing is deleted by a scan.',
      group: 'scans',
      annotations: MUTATING,
    },
    async () => {
      if (scanInProgress || rulesRepo.scanHistory.getRunning()) {
        return fail('A scan is already in progress');
      }
      scanInProgress = true;
      void scanLibraries()
        .catch((error) => logger.error('MCP-triggered scan failed:', error))
        .finally(() => {
          scanInProgress = false;
        });
      return ok({ started: true, enabledRules: rulesRepo.rules.getEnabled().length }, 'Scan started. Call get_scan_status to follow it.');
    }
  );

  defineTool(
    server,
    {
      name: 'get_scan_status',
      title: 'Scan status',
      description: 'Whether a rules scan is running, and the latest scan result.',
      group: 'scans',
      annotations: READ_ONLY,
    },
    async () => {
      const running = rulesRepo.scanHistory.getRunning();
      const latest = rulesRepo.scanHistory.getLatest();
      const stats = scanHistoryRepo.getStats();
      return ok(
        { isRunning: scanInProgress || !!running, currentScan: running, latestScan: latest, stats },
        running || scanInProgress
          ? `A scan is running (started ${running?.started_at ?? 'just now'}).`
          : latest
            ? `No scan running. Last scan ${latest.status} at ${latest.completed_at ?? latest.started_at}: ${latest.items_scanned} scanned, ${latest.items_flagged} flagged/queued.`
            : 'No scans yet.'
      );
    }
  );

  defineTool(
    server,
    {
      name: 'list_scan_history',
      title: 'Scan history',
      description: 'Recent rules scans, newest first.',
      group: 'scans',
      inputSchema: { limit: z.number().int().min(1).max(200).optional() },
      annotations: READ_ONLY,
    },
    async ({ limit }) => {
      const scans = scanHistoryRepo.getAll(clampLimit(limit, 20, 200));
      return ok({ scans }, `${scans.length} scan(s).`);
    }
  );

  defineTool(
    server,
    {
      name: 'sync_library',
      title: 'Sync the library from the media server',
      description:
        'Pull the current catalogue and watch state from Plex/Jellyfin/Emby (and match it to Sonarr/Radarr) so PrunerrXT\'s data is fresh. Runs in the background; poll get_sync_status. Changes nothing on the media server.',
      group: 'scans',
      annotations: MUTATING,
    },
    async () => {
      if (isSyncInProgress()) return fail('A library sync is already in progress');
      void runLibrarySync().then((outcome) => {
        if (outcome.status === 'completed' && outcome.result) {
          logger.info('MCP-triggered library sync completed', {
            itemsScanned: outcome.result.itemsScanned,
            itemsAdded: outcome.result.itemsAdded,
            itemsUpdated: outcome.result.itemsUpdated,
          });
        }
      }).catch((error) => logger.error('MCP-triggered library sync failed:', error));
      return ok({ started: true, mediaServer: getMediaServerLabel() }, `Library sync from ${getMediaServerLabel()} started. Call get_sync_status to follow it.`);
    }
  );

  defineTool(
    server,
    {
      name: 'get_sync_status',
      title: 'Library sync status',
      description: 'Whether a library sync is running, its recent progress messages, and when the last one finished.',
      group: 'scans',
      annotations: READ_ONLY,
    },
    async () => {
      const inProgress = isSyncInProgress();
      const progress = getSyncProgressLog().slice(-15);
      return ok(
        {
          inProgress,
          lastSuccessfulSyncAt: getLastSyncCompletedAt()?.toISOString() ?? null,
          lastSyncFinishedAt: getLastSyncFinishedAt()?.toISOString() ?? null,
          lastSyncSuccess: getLastSyncSuccess(),
          recentProgress: progress,
        },
        inProgress ? 'A library sync is in progress.' : `No sync running. Last successful sync: ${getLastSyncCompletedAt()?.toISOString() ?? 'never'}.`
      );
    }
  );

  defineTool(
    server,
    {
      name: 'list_scheduled_tasks',
      title: 'Scheduled tasks',
      description: 'Every background job (library sync, rules scan, queue processing, reminders, snapshots, disk-pressure monitor) with its cron schedule, enabled flag, last result and next run time.',
      group: 'scans',
      annotations: READ_ONLY,
    },
    async () => {
      const scheduler = getScheduler();
      const jobs = scheduler.getStatus().map((j) => ({
        name: j.name,
        enabled: j.enabled,
        schedule: j.schedule,
        isRunning: j.isRunning,
        lastRun: j.lastRun?.toISOString() ?? null,
        lastResult: j.lastResult ? { success: j.lastResult.success, message: j.lastResult.message } : null,
        nextRun: j.nextRun?.toISOString() ?? null,
      }));
      return ok(
        { schedulerRunning: scheduler.isSchedulerRunning(), timezone: scheduler.getConfig().timezone, jobs },
        `${jobs.filter((j) => j.enabled).length} of ${jobs.length} task(s) enabled.`
      );
    }
  );
}
