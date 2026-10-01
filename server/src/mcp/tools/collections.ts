import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import collectionsRepo, { type Collection } from '../../db/repositories/collections';
import mediaItemsRepo from '../../db/repositories/mediaItems';
import { logActivity } from '../../db/repositories/activity';
import { getDatabase } from '../../db';
import { getRadarrService } from '../../services/init';
import { DELETION_ACTIONS, markItemsForDeletion } from '../../services/mediaActions';
import { formatBytes } from '../../utils/format';
import { EXTERNAL_READ, MUTATING, READ_ONLY, defineTool, fail, ok, summarizeMediaItem } from '../helpers';

function toClient(col: Collection) {
  return {
    id: col.id,
    tmdbId: col.tmdb_id,
    title: col.title,
    overview: col.overview,
    itemCount: col.item_count,
    isProtected: Boolean(col.is_protected),
    protectionReason: col.protection_reason,
    protectedAt: col.protected_at,
    lastSyncedAt: col.last_synced_at,
  };
}

export function registerCollectionTools(server: McpServer): void {
  defineTool(
    server,
    {
      name: 'list_collections',
      title: 'List collections',
      description: 'Movie collections synced from Radarr (e.g. a film franchise) with item counts and whether each is protected. A protected collection shields every movie in it.',
      group: 'collections',
      inputSchema: { protectedOnly: z.boolean().optional() },
      annotations: READ_ONLY,
    },
    async ({ protectedOnly }) => {
      const collections = collectionsRepo.findAll().filter((c) => !protectedOnly || c.is_protected).map(toClient);
      return ok({ total: collections.length, collections }, `${collections.length} collection(s), ${collections.filter((c) => c.isProtected).length} protected.`);
    }
  );

  defineTool(
    server,
    {
      name: 'get_collection',
      title: 'Collection details',
      description: 'One collection with the movies in it.',
      group: 'collections',
      inputSchema: { id: z.number().int().positive() },
      annotations: READ_ONLY,
    },
    async ({ id }) => {
      const col = collectionsRepo.findById(id);
      if (!col) return fail(`Collection ${id} not found`);
      const items = collectionsRepo
        .getMediaItemIds(id)
        .map((mid) => mediaItemsRepo.getById(mid))
        .filter((item): item is NonNullable<typeof item> => item !== null)
        .map((item) => summarizeMediaItem(item));
      const totalBytes = items.reduce((sum, i) => sum + i.sizeBytes, 0);
      return ok(
        { ...toClient(col), totalSize: formatBytes(totalBytes), totalSizeBytes: totalBytes, items },
        `"${col.title}": ${items.length} movie(s), ${formatBytes(totalBytes)}${col.is_protected ? ', protected' : ''}.`
      );
    }
  );

  defineTool(
    server,
    {
      name: 'sync_collections',
      title: 'Sync collections from Radarr',
      description: 'Refresh collections and their membership from Radarr.',
      group: 'collections',
      annotations: { ...EXTERNAL_READ, readOnlyHint: false, idempotentHint: true },
    },
    async () => {
      const radarr = getRadarrService();
      if (!radarr) return fail('Radarr is not configured');
      const result = await radarr.syncCollections();
      return ok(result, `Synced ${result.collectionsSynced} collection(s), matched ${result.itemsMatched} item(s).`);
    }
  );

  defineTool(
    server,
    {
      name: 'set_collection_protection',
      title: 'Protect or unprotect a collection',
      description: 'Protect a whole collection so none of its movies can be queued or deleted, or remove that protection.',
      group: 'collections',
      inputSchema: {
        id: z.number().int().positive(),
        isProtected: z.boolean(),
        reason: z.string().max(200).optional(),
      },
      annotations: MUTATING,
    },
    async ({ id, isProtected, reason }) => {
      const existing = collectionsRepo.findById(id);
      if (!existing) return fail(`Collection ${id} not found`);

      const db = getDatabase();
      const updated = db.transaction(() => {
        const result = collectionsRepo.setProtection(id, isProtected, reason ?? null);
        if (!result) return null;
        logActivity({
          eventType: 'protection',
          action: isProtected ? 'collection_protected' : 'collection_unprotected',
          actorType: 'user',
          actorName: 'MCP assistant',
          targetType: 'collection',
          targetId: id,
          targetTitle: existing.title,
          metadata: JSON.stringify({ collectionId: id, itemCount: collectionsRepo.getMediaItemIds(id).length, isProtected, reason: reason ?? null }),
        });
        return result;
      })();

      if (!updated) return fail('Failed to update collection protection');
      return ok(toClient(updated), `Collection "${existing.title}" is now ${isProtected ? 'protected' : 'unprotected'}.`);
    }
  );

  defineTool(
    server,
    {
      name: 'queue_collection_for_deletion',
      title: 'Queue a whole collection for deletion',
      description: 'Queue every movie in a collection for deletion after a grace period. Protected movies (and a protected collection) are skipped. Confirm with the user first.',
      group: 'collections',
      inputSchema: {
        id: z.number().int().positive(),
        deletionAction: z.enum(DELETION_ACTIONS).optional(),
        gracePeriodDays: z.number().int().min(0).max(365).optional(),
        resetOverseerr: z.boolean().optional(),
      },
      annotations: MUTATING,
    },
    async ({ id, deletionAction, gracePeriodDays, resetOverseerr }) => {
      const col = collectionsRepo.findById(id);
      if (!col) return fail(`Collection ${id} not found`);
      if (col.is_protected) return fail(`Collection "${col.title}" is protected`);
      const ids = collectionsRepo.getMediaItemIds(id);
      if (ids.length === 0) return fail(`Collection "${col.title}" has no items in the library`);
      const result = markItemsForDeletion(ids, { deletionAction, gracePeriodDays, resetOverseerr, actorName: 'MCP assistant' });
      return ok(
        { collection: toClient(col), ...result },
        `"${col.title}": ${result.queued.length} queued, ${result.skipped.length} skipped, ${result.failed.length} failed. Delete after ${result.deleteAfter}.`
      );
    }
  );
}
