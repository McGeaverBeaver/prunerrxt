import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { deleteQueueItemNow, listQueue, processQueue, removeFromQueue } from '../../services/deletionQueue';
import { formatBytes } from '../../utils/format';
import { DESTRUCTIVE, MUTATING, READ_ONLY, clampLimit, defineTool, fail, ok } from '../helpers';

export function registerQueueTools(server: McpServer): void {
  defineTool(
    server,
    {
      name: 'list_queue',
      title: 'List the deletion queue',
      description:
        'Everything waiting to be deleted — whole movies/shows and individual episodes — soonest first, with days remaining, the rule that queued it (if any), the deletion action and the total space it will free. Queue ids are strings; episode entries are prefixed "ep-".',
      group: 'queue',
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional().describe('Page size (default 50).'),
        offset: z.number().int().min(0).optional(),
        readyOnly: z.boolean().optional().describe('Only items whose grace period has already expired.'),
      },
      annotations: READ_ONLY,
    },
    async ({ limit, offset, readyOnly }) => {
      const listing = listQueue({ limit: 0, offset: 0 });
      let items = listing.items;
      if (readyOnly) items = items.filter((i) => i.daysRemaining === 0);
      const start = offset ?? 0;
      const size = clampLimit(limit, 50, 200);
      const page = items.slice(start, start + size).map((i) => ({
        queueId: i.id,
        mediaItemId: Number(i.mediaItemId),
        kind: i.kind,
        title: i.title,
        type: i.type,
        size: formatBytes(i.size),
        sizeBytes: i.size,
        queuedAt: i.queuedAt,
        deleteAt: i.deleteAt,
        daysRemaining: i.daysRemaining,
        deletionAction: i.deletionAction,
        resetOverseerr: i.resetOverseerr,
        matchedRule: i.matchedRule ?? null,
        ruleId: i.ruleId ? Number(i.ruleId) : null,
        requestedBy: i.requestedBy ?? null,
      }));
      return ok(
        {
          total: items.length,
          offset: start,
          summary: {
            ...listing.summary,
            totalSizeFormatted: formatBytes(listing.summary.totalSize),
          },
          items: page,
        },
        `${listing.summary.totalItems} queued item(s), ${formatBytes(listing.summary.totalSize)} reclaimable, ${listing.summary.readyForDeletion} ready for deletion now. Showing ${page.length}.`
      );
    }
  );

  defineTool(
    server,
    {
      name: 'remove_from_queue',
      title: 'Remove from the queue',
      description: 'Cancel queued deletions. Whole items go back to active; queued episodes are cancelled. Nothing is deleted. Accepts queue ids from list_queue (numbers for items, "ep-N" for episodes).',
      group: 'queue',
      inputSchema: {
        queueIds: z.array(z.string().min(1)).min(1).max(200),
      },
      annotations: MUTATING,
    },
    async ({ queueIds }) => {
      const removed: Array<{ queueId: string; title: string }> = [];
      const failed: Array<{ queueId: string; error: string }> = [];
      for (const raw of queueIds) {
        const result = removeFromQueue(raw);
        if (result.ok) removed.push({ queueId: result.id, title: result.title });
        else failed.push({ queueId: raw, error: result.error });
      }
      return ok({ removed, failed }, `${removed.length} removed from the queue, ${failed.length} failed.`);
    }
  );

  defineTool(
    server,
    {
      name: 'process_queue',
      title: 'Process the deletion queue',
      description:
        'Run the queue. With dryRun=true (the default) it reports exactly what would be deleted and how much space it would free, touching nothing. With dryRun=false it deletes items whose grace period has expired (force=true deletes every queued item regardless of grace period). Real runs require the "allow immediate deletion" setting and should be confirmed with the user first.',
      group: 'queue',
      inputSchema: {
        dryRun: z.boolean().optional().describe('Default true. Set false to actually delete.'),
        force: z.boolean().optional().describe('Ignore grace periods and process everything queued.'),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ dryRun, force }) => {
      const isDryRun = dryRun !== false;
      if (!isDryRun) {
        const { allowsImmediateDeletion, IMMEDIATE_DELETION_REFUSED } = await import('../config');
        if (!allowsImmediateDeletion()) return fail(IMMEDIATE_DELETION_REFUSED);
      }
      const result = await processQueue({ dryRun: isDryRun, force: force === true });
      return ok(result, result.message);
    }
  );

  defineTool(
    server,
    {
      name: 'delete_now',
      title: 'Delete a queued item now',
      description:
        'Delete one queued item immediately, skipping the rest of its grace period. Only items already in the queue can be deleted this way. Irreversible. Requires the "allow immediate deletion" setting; confirm with the user first.',
      group: 'queue',
      inputSchema: {
        queueId: z.string().min(1).describe('Queue id from list_queue (number for an item, "ep-N" for an episode).'),
      },
      annotations: DESTRUCTIVE,
      requiresImmediateDeletion: true,
    },
    async ({ queueId }) => {
      const result = await deleteQueueItemNow(queueId);
      if (!result.ok) return fail(result.error);
      const { ok: _ok, ...data } = result;
      return ok(data, `Deleted "${result.title}" (${result.deletionActionLabel}), freed ${result.fileSizeFreedFormatted}.`);
    }
  );
}
