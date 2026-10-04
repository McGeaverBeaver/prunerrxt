import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import mediaItemsRepo from '../../db/repositories/mediaItems';
import collectionsRepo from '../../db/repositories/collections';
import episodeDeletionsRepo from '../../db/repositories/episodeDeletions';
import { logActivity } from '../../db/repositories/activity';
import { getSonarrService } from '../../services/init';
import {
  DELETION_ACTIONS,
  allowDeletionAnyway,
  archiveItems,
  defaultDeletionAction,
  defaultGracePeriodDays,
  markItemsForDeletion,
  protectItems,
  unprotectItems,
} from '../../services/mediaActions';
import { checkItem } from '../../services/availability';
import { describeReasons } from '../../services/availabilityVerdict';
import {
  EPISODE_DELETION_ACTIONS,
  executeQueuedDeletions,
  queueEpisodeDeletions,
  resolveTargets,
} from '../../services/episodeDeletions';
import { allowsImmediateDeletion, IMMEDIATE_DELETION_REFUSED } from '../config';
import { DESTRUCTIVE, EXTERNAL_READ, MUTATING, defineTool, fail, ok } from '../helpers';
import { resolveSonarrSeriesId } from './library';

const ACTOR = 'MCP assistant';

export function registerActionTools(server: McpServer): void {
  defineTool(
    server,
    {
      name: 'queue_for_deletion',
      title: 'Queue items for deletion',
      description:
        'Put movies or shows into the deletion queue. Nothing is deleted now: each item waits out a grace period (default from Settings) during which it can be removed from the queue. Protected items and items in protected collections are skipped, never deleted. Already-queued items keep their queued date and take the new options. Confirm with the user before queueing more than a handful of items.',
      group: 'actions',
      inputSchema: {
        ids: z.array(z.number().int().positive()).min(1).max(200).describe('Prunerr media item ids.'),
        gracePeriodDays: z.number().int().min(0).max(365).optional().describe('Days before the item becomes eligible for deletion. Defaults to the configured grace period.'),
        deletionAction: z.enum(DELETION_ACTIONS).optional().describe('What happens in Sonarr/Radarr when the grace period ends. Defaults to the configured default.'),
        resetOverseerr: z.boolean().optional().describe('Also clear the request in Overseerr/Jellyseerr so it can be re-requested.'),
      },
      annotations: MUTATING,
    },
    async ({ ids, gracePeriodDays, deletionAction, resetOverseerr }) => {
      const result = markItemsForDeletion(ids, { gracePeriodDays, deletionAction, resetOverseerr, actorName: ACTOR });
      return ok(
        result,
        `${result.queued.length} item(s) queued (delete after ${result.deleteAfter}, action ${result.deletionAction}), ${result.skipped.length} skipped, ${result.failed.length} failed.`
      );
    }
  );

  defineTool(
    server,
    {
      name: 'protect_items',
      title: 'Protect items',
      description:
        'Mark movies or shows as protected so no rule or manual action can delete them. Protecting an item that is in the deletion queue takes it out of the queue.',
      group: 'actions',
      inputSchema: {
        ids: z.array(z.number().int().positive()).min(1).max(500),
        reason: z.string().max(200).optional().describe('Why, shown in the UI (default "Manually protected").'),
      },
      annotations: MUTATING,
    },
    async ({ ids, reason }) => {
      const result = protectItems(ids, reason || 'Protected via MCP assistant', ACTOR);
      return ok(result, `${result.protected.length} item(s) protected, ${result.skipped.length} already protected, ${result.failed.length} failed.`);
    }
  );

  defineTool(
    server,
    {
      name: 'unprotect_items',
      title: 'Remove protection',
      description:
        'Remove item-level protection so rules may consider the items again. Protection inherited from a protected collection is not affected; use set_collection_protection for that.',
      group: 'actions',
      inputSchema: {
        ids: z.array(z.number().int().positive()).min(1).max(500),
      },
      annotations: MUTATING,
    },
    async ({ ids }) => {
      const result = unprotectItems(ids, ACTOR);
      return ok(result, `${result.unprotected.length} item(s) unprotected, ${result.skipped.length} were not protected, ${result.failed.length} failed.`);
    }
  );

  defineTool(
    server,
    {
      name: 'check_availability',
      title: 'Check whether items could be downloaded again',
      description:
        'Archive: ask Radarr/Sonarr what the indexers can offer for each movie or show right now, and judge it against the file on disk. Returns replaceable (something as good is out there), at_risk (nothing, a downgrade, or too few seeders) or unknown (not linked, indexers down, search failed), with the numbers behind it. Runs the interactive search now, so allow a minute per item; keep to a handful of ids. The verdict is stored on the item.',
      group: 'actions',
      inputSchema: {
        ids: z.array(z.number().int().positive()).min(1).max(10).describe('Prunerr media item ids.'),
      },
      annotations: EXTERNAL_READ,
    },
    async ({ ids }) => {
      const results: Array<Record<string, unknown>> = [];
      for (const id of ids) {
        const item = mediaItemsRepo.getById(id);
        if (!item) {
          results.push({ id, error: 'not found' });
          continue;
        }
        const { report, archived } = await checkItem(item, { force: true, actorName: ACTOR });
        results.push({ id, title: item.title, verdict: report.verdict, reasons: report.reasons, detail: describeReasons(report), releases: report.releases, best: report.best, current: report.current, archived });
      }
      const atRisk = results.filter((r) => r['verdict'] === 'at_risk').length;
      return ok(results, `${results.length} checked: ${results.filter((r) => r['verdict'] === 'replaceable').length} replaceable, ${atRisk} at risk, ${results.filter((r) => r['verdict'] === 'unknown').length} unknown.`);
    }
  );

  defineTool(
    server,
    {
      name: 'archive_items',
      title: 'Archive items (keep for good)',
      description:
        'Archive movies or shows: protect them permanently because they could not be downloaded again (or are not worth the risk), and take them out of the deletion queue. An archived item is a protected item with an archive mark; no rule, scan or deletion touches it until unarchive_items. Use this to resolve an Archive hold on an at-risk queued item.',
      group: 'actions',
      inputSchema: {
        ids: z.array(z.number().int().positive()).min(1).max(500),
        reason: z.string().max(200).optional().describe('Why, shown in the UI. Defaults to the stored verdict.'),
      },
      annotations: MUTATING,
    },
    async ({ ids, reason }) => {
      const result = archiveItems(ids, reason || 'Archived via MCP assistant', ACTOR);
      return ok(result, `${result.archived.length} item(s) archived, ${result.skipped.length} skipped, ${result.failed.length} failed.`);
    }
  );

  defineTool(
    server,
    {
      name: 'unarchive_items',
      title: 'Unarchive items',
      description: 'Lift the archive mark and its protection so rules may consider the items again. The same as unprotect_items for archived items.',
      group: 'actions',
      inputSchema: {
        ids: z.array(z.number().int().positive()).min(1).max(500),
      },
      annotations: MUTATING,
    },
    async ({ ids }) => {
      const result = unprotectItems(ids, ACTOR);
      return ok(result, `${result.unprotected.length} item(s) unarchived, ${result.skipped.length} were not archived, ${result.failed.length} failed.`);
    }
  );

  defineTool(
    server,
    {
      name: 'clear_availability_hold',
      title: 'Delete an at-risk item anyway',
      description:
        'Archive is holding a queued item because it may not be downloadable again. This records the decision to delete it anyway, so it goes when its grace period ends. Confirm with the user first; the alternative is archive_items.',
      group: 'actions',
      inputSchema: {
        ids: z.array(z.number().int().positive()).min(1).max(100).describe('Prunerr media item ids of queued items.'),
      },
      annotations: MUTATING,
    },
    async ({ ids }) => {
      const cleared: Array<{ id: number; title: string }> = [];
      const failed: Array<{ id: number; error: string }> = [];
      for (const id of ids) {
        const result = allowDeletionAnyway(id, ACTOR);
        if (result.ok) cleared.push({ id, title: result.item.title });
        else failed.push({ id, error: result.error });
      }
      return ok({ cleared, failed }, `${cleared.length} hold(s) lifted, ${failed.length} failed.`);
    }
  );

  defineTool(
    server,
    {
      name: 'queue_episodes_for_deletion',
      title: 'Queue episodes or seasons for deletion',
      description:
        'For a show, queue individual episodes or whole seasons for deletion in Sonarr after a grace period (one queue entry per episode, so any can be cancelled). Get episode ids from get_show_episodes. Set immediate=true to delete right away instead; that requires the "allow immediate deletion" setting. Protected shows are refused.',
      group: 'actions',
      inputSchema: {
        id: z.number().int().positive().describe('Prunerr media item id of the show.'),
        episodeIds: z.array(z.number().int().positive()).optional().describe('Sonarr episode ids.'),
        seasonNumbers: z.array(z.number().int().min(0)).optional().describe('Whole seasons.'),
        deletionAction: z.enum(EPISODE_DELETION_ACTIONS).optional().describe('Default unmonitor_and_delete.'),
        gracePeriodDays: z.number().int().min(0).max(365).optional().describe('Default 7.'),
        immediate: z.boolean().optional().describe('Delete now instead of queueing. Needs the immediate-deletion opt-in.'),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ id, episodeIds = [], seasonNumbers = [], deletionAction = 'unmonitor_and_delete', gracePeriodDays = 7, immediate = false }) => {
      if (episodeIds.length === 0 && seasonNumbers.length === 0) {
        return fail('Provide at least one episodeId or seasonNumber');
      }
      if (immediate && !allowsImmediateDeletion()) {
        return fail(IMMEDIATE_DELETION_REFUSED);
      }

      const item = mediaItemsRepo.getById(id);
      if (!item) return fail(`Media item ${id} not found`);
      if (item.is_protected) return fail(`"${item.title}" is protected; its episodes cannot be deleted`);
      const protectedCollections = collectionsRepo.findProtectedContainingItem(id);
      if (protectedCollections.length > 0) {
        return fail(`"${item.title}" is protected via collection "${protectedCollections[0]!.title}"`);
      }

      const sonarr = getSonarrService();
      if (!sonarr) return fail('Sonarr is not configured');
      const seriesId = await resolveSonarrSeriesId(item);
      if (!seriesId) return fail(`"${item.title}" is not matched to a series in Sonarr`);

      const [episodes, files] = await Promise.all([sonarr.getEpisodes(seriesId), sonarr.getEpisodeFiles(seriesId)]);
      const targets = resolveTargets({ episodes, files, episodeIds, seasonNumbers, action: deletionAction });
      if (targets.length === 0) {
        return fail('Nothing to do for the selected episodes with that action (they may have no files)');
      }

      const queued = queueEpisodeDeletions({
        item,
        seriesId,
        targets,
        action: deletionAction,
        gracePeriodDays: immediate ? 0 : gracePeriodDays,
        ...(immediate ? { skipActivityLog: true } : {}),
      });

      if (!immediate) {
        return ok(
          { queued: queued.length, alreadyQueued: targets.length - queued.length, deleteAfter: queued[0]?.delete_after ?? null, deletionAction },
          `Queued ${queued.length} episode(s) of "${item.title}" for deletion (${targets.length - queued.length} already queued).`
        );
      }

      const result = await executeQueuedDeletions(queued);
      return ok(
        {
          deleted: result.deleted,
          failed: result.failed,
          freedBytes: result.freedBytes,
          errors: result.outcomes.filter((o) => !o.success).map((o) => ({ title: o.label, error: o.error })),
        },
        `Deleted ${result.deleted} episode(s) of "${item.title}", ${result.failed} failed.`
      );
    }
  );

  defineTool(
    server,
    {
      name: 'cancel_episode_deletions',
      title: 'Cancel queued episode deletions',
      description: 'Take episodes of a show back out of the deletion queue, by Sonarr episode id.',
      group: 'actions',
      inputSchema: {
        id: z.number().int().positive().describe('Prunerr media item id of the show.'),
        episodeIds: z.array(z.number().int().positive()).min(1),
      },
      annotations: MUTATING,
    },
    async ({ id, episodeIds }) => {
      const item = mediaItemsRepo.getById(id);
      if (!item) return fail(`Media item ${id} not found`);
      const cancelled = episodeDeletionsRepo.cancelByEpisodeIds(id, episodeIds);
      if (cancelled > 0) {
        logActivity({
          eventType: 'manual_action',
          action: 'episodes_unqueued',
          actorType: 'user',
          actorName: ACTOR,
          targetType: 'media_item',
          targetId: id,
          targetTitle: item.title,
          metadata: JSON.stringify({ episodes: cancelled }),
        });
      }
      return ok({ cancelled }, `Removed ${cancelled} episode(s) of "${item.title}" from the deletion queue.`);
    }
  );

  defineTool(
    server,
    {
      name: 'get_deletion_defaults',
      title: 'Deletion defaults',
      description: 'The configured default grace period and deletion action used when queue_for_deletion is called without them.',
      group: 'actions',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () =>
      ok({
        gracePeriodDays: defaultGracePeriodDays(),
        deletionAction: defaultDeletionAction(),
        immediateDeletionAllowed: allowsImmediateDeletion(),
        deletionActions: DELETION_ACTIONS,
      })
  );
}
