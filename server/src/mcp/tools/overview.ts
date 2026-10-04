import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import mediaItemsRepo from '../../db/repositories/mediaItems';
import storageSnapshotsRepo from '../../db/repositories/storageSnapshots';
import rulesRepo from '../../db/repositories/rules';
import { getDashboardStats } from '../../services/dashboardStats';
import { getSystemHealth } from '../../services/systemHealth';
import { getAllQueueItems, summarizeQueue } from '../../services/deletionQueue';
import { formatBytes } from '../../utils/format';
import { getAppVersion } from '../../utils/version';
import { EXTERNAL_READ, READ_ONLY, clampLimit, daysSince, defineTool, ok, summarizeMediaItem } from '../helpers';

export function registerOverviewTools(server: McpServer): void {
  defineTool(
    server,
    {
      name: 'get_overview',
      title: 'Library overview',
      description:
        'Start here. The dashboard in one call: library size and counts, unwatched counts, what is in the deletion queue and how much space it would free, disk-pressure state, active rules and the last scan.',
      group: 'overview',
      annotations: READ_ONLY,
    },
    async () => {
      const stats = await getDashboardStats();
      const queue = summarizeQueue(getAllQueueItems());
      const latestScan = rulesRepo.scanHistory.getLatest();
      const data = {
        version: getAppVersion(),
        library: {
          movies: stats.movieCount,
          shows: stats.tvShowCount,
          episodes: stats.tvEpisodeCount,
          totalSize: formatBytes(stats.totalStorage),
          totalSizeBytes: stats.totalStorage,
          unwatchedMovies: stats.unwatchedMovies,
          unwatchedShows: stats.unwatchedShows,
        },
        queue: {
          items: queue.totalItems,
          readyForDeletion: queue.readyForDeletion,
          reclaimable: formatBytes(queue.totalSize),
          reclaimableBytes: queue.totalSize,
          willResetOverseerr: queue.willResetOverseerr,
        },
        reclaimedThisWeek: formatBytes(stats.reclaimedThisWeek),
        reclaimedThisWeekBytes: stats.reclaimedThisWeek,
        rules: { active: stats.activeRules },
        collections: { total: stats.collectionCount, protected: stats.protectedCollections },
        lastScan: latestScan
          ? {
              status: latestScan.status,
              startedAt: latestScan.started_at,
              completedAt: latestScan.completed_at,
              itemsScanned: latestScan.items_scanned,
              itemsFlagged: latestScan.items_flagged,
            }
          : null,
        diskPressure: stats.diskPressureEnabled
          ? {
              enabled: true,
              observeOnly: stats.diskObserveOnly,
              severity: stats.diskPressureSeverity,
              volumes: stats.disks.map((d) => ({
                path: d.path,
                source: d.source ?? 'statfs',
                reportedBy: d.reportedBy ?? [],
                free: formatBytes(d.freeBytes),
                total: formatBytes(d.totalBytes),
                freeBytes: d.freeBytes,
                totalBytes: d.totalBytes,
                severity: d.severity,
              })),
              free: stats.diskFreeBytes !== null ? formatBytes(stats.diskFreeBytes) : null,
              total: stats.diskTotalBytes !== null ? formatBytes(stats.diskTotalBytes) : null,
              target: stats.diskTargetBytes !== null ? formatBytes(stats.diskTargetBytes) : null,
              disks: stats.disks.map((d) => ({
                path: d.path,
                free: formatBytes(d.freeBytes),
                total: formatBytes(d.totalBytes),
                severity: d.severity,
              })),
            }
          : { enabled: false },
      };
      return ok(
        data,
        `${stats.movieCount} movies and ${stats.tvShowCount} shows (${formatBytes(stats.totalStorage)}). Queue: ${queue.totalItems} item(s), ${formatBytes(queue.totalSize)} reclaimable, ${queue.readyForDeletion} ready now.`
      );
    }
  );

  defineTool(
    server,
    {
      name: 'get_system_health',
      title: 'System health',
      description:
        'Live connectivity check of every configured service (media server, Sonarr, Radarr, Tautulli, Tracearr, Overseerr) with response times, plus scheduler state: last/next scan and library sync.',
      group: 'overview',
      annotations: EXTERNAL_READ,
    },
    async () => {
      const health = await getSystemHealth();
      const configured = health.services.filter((s) => s.configured);
      const down = configured.filter((s) => !s.connected).map((s) => s.service);
      return ok(
        health,
        `Overall ${health.overall}. ${configured.length} service(s) configured${down.length ? `, unreachable: ${down.join(', ')}` : ', all reachable'}.`
      );
    }
  );

  defineTool(
    server,
    {
      name: 'get_storage_history',
      title: 'Storage history',
      description: 'Daily snapshots of library size, item counts and space reclaimed, oldest first. Use to describe trends.',
      group: 'overview',
      inputSchema: {
        days: z.number().int().min(1).max(365).optional().describe('How many days back to include (default 30).'),
      },
      annotations: READ_ONLY,
    },
    async ({ days }) => {
      const snapshots = storageSnapshotsRepo.getHistory(days ?? 30).map((s) => ({
        capturedAt: s.captured_at,
        totalSize: formatBytes(s.total_size),
        totalSizeBytes: s.total_size,
        movieSizeBytes: s.movie_size,
        showSizeBytes: s.show_size,
        itemCount: s.item_count,
        movieCount: s.movie_count,
        showCount: s.show_count,
        spaceReclaimedBytes: s.space_reclaimed,
      }));
      const first = snapshots[0];
      const last = snapshots[snapshots.length - 1];
      const summary =
        first && last
          ? `${snapshots.length} snapshot(s). Library went from ${first.totalSize} to ${last.totalSize}.`
          : 'No storage snapshots yet.';
      return ok({ days: days ?? 30, snapshots }, summary);
    }
  );

  defineTool(
    server,
    {
      name: 'get_recommendations',
      title: 'Deletion recommendations',
      description:
        'Items that have not been watched for a long time and are not protected or already queued — the best candidates to free space. Largest and longest-unwatched first.',
      group: 'overview',
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe('How many to return (default 15).'),
        unwatchedDays: z.number().int().min(1).optional().describe('Treat as stale when not watched for this many days (default 90).'),
      },
      annotations: READ_ONLY,
    },
    async ({ limit, unwatchedDays }) => {
      const days = unwatchedDays ?? 90;
      const now = new Date();
      const candidates = mediaItemsRepo
        .getUnwatched(days)
        .filter((item) => !item.is_protected && item.status !== 'pending_deletion')
        .sort((a, b) => {
          const aDate = a.last_watched_at ? new Date(a.last_watched_at).getTime() : 0;
          const bDate = b.last_watched_at ? new Date(b.last_watched_at).getTime() : 0;
          if (aDate !== bDate) return aDate - bDate;
          return (b.file_size || 0) - (a.file_size || 0);
        });
      const page = candidates.slice(0, clampLimit(limit, 15, 100));
      const totalBytes = candidates.reduce((sum, i) => sum + (i.file_size || 0), 0);
      const items = page.map((item) => ({
        ...summarizeMediaItem(item, now),
        reason:
          !item.last_watched_at || daysSince(item.last_watched_at, now) === null
            ? 'Never watched'
            : `Not watched in ${daysSince(item.last_watched_at, now)} days`,
      }));
      return ok(
        { criteria: { unwatchedDays: days }, total: candidates.length, totalReclaimable: formatBytes(totalBytes), totalReclaimableBytes: totalBytes, items },
        `${candidates.length} candidate(s) not watched in ${days}+ days, ${formatBytes(totalBytes)} reclaimable in total. Showing ${items.length}.`
      );
    }
  );
}
