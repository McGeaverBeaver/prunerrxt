/**
 * The deletion queue, as one shared implementation.
 *
 * The Queue page, the REST API and the MCP connector all read and act on the
 * same queue, so the shaping (media rows and queued episodes into one list),
 * the removal, the batch processing and the immediate deletion live here and
 * the routes and tools stay thin. Anything that frees disk space ends up in
 * one of the functions below.
 */
import mediaItemsRepo from '../db/repositories/mediaItems';
import type { MediaItem, DeletionType } from '../types';
import { logActivity } from '../db/repositories/activity';
import logger from '../utils/logger';
import { toThumbnailUrl } from '../utils/posterUrl';
import { getDeletionService, type DeletionProgress } from './deletion';
import episodeDeletionsRepo, { type EpisodeDeletion } from '../db/repositories/episodeDeletions';
import { episodeLabel, executeQueuedDeletions } from './episodeDeletions';
import { DeletionAction, DELETION_ACTION_LABELS } from '../rules/types';
import rulesRepo from '../db/repositories/rules';
import { getNotificationService } from '../notifications';
import { getArchiveSettings, holdState, type ArchiveSettings, type AvailabilityReport, type HoldReason } from './availabilityVerdict';

// ============================================================================
// Shapes
// ============================================================================

export interface QueueItemResponse {
  id: string;
  mediaItemId: string;
  /** 'media' is a whole movie/show row; 'episode' is a single queued episode. */
  kind: 'media' | 'episode';
  title: string;
  type: string;
  size: number;
  posterUrl?: string;
  queuedAt: string;
  deleteAt: string;
  /** Name of the rule that queued the item; absent when queued by hand. */
  matchedRule?: string;
  /** Id of that rule, so the client can link back to it. */
  ruleId?: string;
  daysRemaining: number;
  deletionAction: DeletionAction;
  deletionActionLabel: string;
  resetOverseerr: boolean;
  requestedBy?: string;
  tmdbId?: number;
  overseerrResetAt?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  /** Archive: the last re-acquisition check; absent for episodes and unchecked items. */
  availability?: AvailabilityReport;
  /** Archive is holding the item from automatic deletion until a person decides. */
  held: boolean;
  heldReason?: HoldReason;
  /** A person chose "delete anyway" on an at-risk item. */
  deleteAnyway: boolean;
}

export interface QueueSummary {
  totalItems: number;
  totalSize: number;
  readyForDeletion: number;
  willResetOverseerr: number;
  /** Items Archive is holding for a decision. */
  held: number;
  atRisk: number;
}

export interface QueueListing {
  items: QueueItemResponse[];
  total: number;
  limit: number;
  offset: number;
  summary: QueueSummary;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Normalize deletion action values to handle legacy/malformed values.
 */
export function normalizeDeletionAction(action: string | undefined | null): DeletionAction {
  if (!action) return DeletionAction.UNMONITOR_AND_DELETE;

  const legacyMappings: Record<string, DeletionAction> = {
    'delete_files': DeletionAction.DELETE_FILES_ONLY,
    'unmonitor': DeletionAction.UNMONITOR_ONLY,
    'full_delete': DeletionAction.FULL_REMOVAL,
    'remove': DeletionAction.FULL_REMOVAL,
  };

  const legacy = legacyMappings[action];
  if (legacy) return legacy;

  const validActions = Object.values(DeletionAction) as string[];
  if (validActions.includes(action)) {
    return action as DeletionAction;
  }

  logger.warn(`Unknown deletion action "${action}", defaulting to UNMONITOR_AND_DELETE`);
  return DeletionAction.UNMONITOR_AND_DELETE;
}

/** Queue ids carry an `ep-` prefix for episode rows so one route serves both. */
export function parseQueueId(raw: string): { kind: 'media' | 'episode'; id: number } | null {
  const isEpisode = raw.startsWith('ep-');
  const id = parseInt(isEpisode ? raw.slice(3) : raw, 10);
  if (isNaN(id)) return null;
  return { kind: isEpisode ? 'episode' : 'media', id };
}

export function daysUntil(deleteAfter: string, now: Date): number {
  return Math.max(0, Math.ceil((new Date(deleteAfter).getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
}

/**
 * Resolves rule names for queue attribution, caching per call so a queue of
 * hundreds of items queued by the same rule costs one lookup.
 */
export function createRuleNameResolver(): (id: number | null | undefined) => string | undefined {
  const cache = new Map<number, string | undefined>();
  return (id) => {
    if (id === null || id === undefined) return undefined;
    if (!cache.has(id)) cache.set(id, rulesRepo.rules.getById(id)?.name);
    return cache.get(id);
  };
}

/** Map a media row pending deletion into the shape the Queue page renders. */
export function mediaRowToQueueItem(
  item: MediaItem,
  now: Date,
  ruleName: (id: number | null | undefined) => string | undefined,
  archiveSettings?: ArchiveSettings
): QueueItemResponse {
  const itemAny = item as unknown as Record<string, unknown>;
  const deletionAction = normalizeDeletionAction(itemAny['deletion_action'] as string | undefined);
  const matchedRuleId = itemAny['matched_rule_id'] as number | null | undefined;
  const matchedRule = ruleName(matchedRuleId);
  const hold = holdState(item, archiveSettings ?? getArchiveSettings());

  return {
    id: String(item.id),
    mediaItemId: String(item.id),
    kind: 'media',
    title: item.title,
    type: item.type === 'show' ? 'tv' : item.type,
    size: item.file_size || 0,
    posterUrl: toThumbnailUrl(item.poster_url) || undefined,
    queuedAt: item.marked_at!,
    deleteAt: item.delete_after!,
    daysRemaining: daysUntil(item.delete_after!, now),
    deletionAction,
    deletionActionLabel: DELETION_ACTION_LABELS[deletionAction] || deletionAction,
    resetOverseerr: Boolean(itemAny['reset_overseerr']),
    requestedBy: (itemAny['requested_by'] as string | undefined) || undefined,
    tmdbId: (itemAny['tmdb_id'] as number | undefined) || undefined,
    overseerrResetAt: (itemAny['overseerr_reset_at'] as string | undefined) || undefined,
    // Only surface the id alongside a name — a rule that has since been
    // deleted would otherwise link nowhere.
    ...(matchedRule ? { matchedRule, ruleId: String(matchedRuleId) } : {}),
    ...(hold.report ? { availability: hold.report } : {}),
    held: hold.held,
    ...(hold.reason ? { heldReason: hold.reason } : {}),
    deleteAnyway: item.availability_decision === 'delete',
  };
}

/** Map a queued episode row into the same shape the Queue page already renders. */
export function episodeRowToQueueItem(row: EpisodeDeletion, now: Date): QueueItemResponse {
  // Episodes are partial deletions of a show that stays; Archive does not weigh in.
  const deletionAction = normalizeDeletionAction(row.deletion_action);
  const show = mediaItemsRepo.getById(row.media_item_id);

  return {
    id: `ep-${row.id}`,
    mediaItemId: String(row.media_item_id),
    kind: 'episode',
    title: episodeLabel(row.series_title, row.season_number, row.episode_number, row.episode_title),
    type: 'episode',
    size: row.file_size || 0,
    posterUrl: toThumbnailUrl(show?.poster_url ?? null) || undefined,
    queuedAt: row.marked_at,
    deleteAt: row.delete_after,
    daysRemaining: daysUntil(row.delete_after, now),
    deletionAction,
    deletionActionLabel: DELETION_ACTION_LABELS[deletionAction] || deletionAction,
    resetOverseerr: false,
    seasonNumber: row.season_number,
    episodeNumber: row.episode_number,
    held: false,
    deleteAnyway: false,
  };
}

export function pendingEpisodeQueueItems(now: Date): QueueItemResponse[] {
  return episodeDeletionsRepo.getAllPending().map((row) => episodeRowToQueueItem(row, now));
}

/**
 * Every item currently in the queue (whole items and queued episodes), soonest
 * deletion first. The Queue page renders all of it and paginates client-side.
 */
export function getAllQueueItems(now: Date = new Date()): QueueItemResponse[] {
  const pendingItems = mediaItemsRepo.getPendingDeletion();
  const ruleName = createRuleNameResolver();
  const archiveSettings = getArchiveSettings();
  return pendingItems
    .filter((item) => item.delete_after && item.marked_at)
    .map<QueueItemResponse>((item) => mediaRowToQueueItem(item, now, ruleName, archiveSettings))
    .concat(pendingEpisodeQueueItems(now))
    .sort((a, b) => a.daysRemaining - b.daysRemaining);
}

export function summarizeQueue(items: QueueItemResponse[]): QueueSummary {
  return {
    totalItems: items.length,
    totalSize: items.reduce((sum, item) => sum + item.size, 0),
    readyForDeletion: items.filter((item) => item.daysRemaining === 0 && !item.held).length,
    willResetOverseerr: items.filter((item) => item.resetOverseerr).length,
    held: items.filter((item) => item.held).length,
    atRisk: items.filter((item) => item.availability?.verdict === 'at_risk').length,
  };
}

/**
 * One page of the queue. `limit` of 0 or less returns everything after
 * `offset` — a default cap here would silently hide items from the Queue page.
 */
export function listQueue(options: { limit?: number; offset?: number } = {}): QueueListing {
  const all = getAllQueueItems();
  const offset = Math.max(0, options.offset ?? 0);
  const hasLimit = typeof options.limit === 'number' && options.limit > 0;
  const items = hasLimit ? all.slice(offset, offset + options.limit!) : all.slice(offset);
  return {
    items,
    total: all.length,
    limit: hasLimit ? options.limit! : all.length,
    offset,
    summary: summarizeQueue(all),
  };
}

// ============================================================================
// Notifications
// ============================================================================

/**
 * Fire a DELETION_COMPLETE notification covering the items deleted in a single
 * request (manual Process Queue, Delete Now, or the SSE stream). Silently
 * no-ops when no items were deleted.
 */
export async function sendDeletionCompleteNotification(
  items: Array<{ title: string; type: string; ruleId?: number | null }>,
  spaceFreedBytes: number,
  errorCount: number
): Promise<void> {
  if (items.length === 0) return;

  const resolveRuleName = createRuleNameResolver();

  try {
    await getNotificationService().notify('DELETION_COMPLETE', {
      itemsDeleted: items.length,
      spaceFreedBytes,
      spaceFreedGB: (spaceFreedBytes / (1024 * 1024 * 1024)).toFixed(2),
      errors: errorCount,
      items: items.map((i) => ({
        title: i.title,
        type: i.type,
        ruleName: resolveRuleName(i.ruleId) ?? (i.ruleId != null ? `Rule #${i.ruleId}` : undefined),
      })),
    });
  } catch (notifyError) {
    logger.error('Failed to send deletion complete notification:', notifyError);
  }
}

// ============================================================================
// Remove from queue
// ============================================================================

export type RemoveFromQueueResult =
  | { ok: true; id: string; title: string; item?: MediaItem }
  | { ok: false; status: 400 | 404 | 500; error: string };

/**
 * Cancel a queued deletion. Whole items go back to `monitored`; queued
 * episodes are cancelled in the episode queue. Nothing is deleted.
 */
export function removeFromQueue(rawId: string): RemoveFromQueueResult {
  const parsedId = parseQueueId(rawId);
  if (!parsedId) {
    return { ok: false, status: 400, error: 'Invalid queue item ID' };
  }

  if (parsedId.kind === 'episode') {
    const row = episodeDeletionsRepo.getById(parsedId.id);
    if (!row || row.status !== 'pending') {
      return { ok: false, status: 404, error: 'Episode is not in the deletion queue' };
    }

    const title = episodeLabel(row.series_title, row.season_number, row.episode_number, row.episode_title);
    episodeDeletionsRepo.cancelByIds([parsedId.id]);

    logActivity({
      eventType: 'manual_action',
      action: 'episodes_unqueued',
      actorType: 'user',
      targetType: 'media_item',
      targetId: row.media_item_id,
      targetTitle: title,
      metadata: JSON.stringify({ episodes: 1 }),
    });

    return { ok: true, id: `ep-${parsedId.id}`, title };
  }

  const id = parsedId.id;
  const item = mediaItemsRepo.getById(id);
  if (!item) {
    return { ok: false, status: 404, error: `Item not found: ${id}` };
  }

  if (item.status !== 'pending_deletion') {
    return { ok: false, status: 400, error: 'Item is not in the deletion queue' };
  }

  const updatedItem = mediaItemsRepo.update(id, {
    status: 'monitored',
    marked_at: undefined,
    delete_after: undefined,
  });

  if (!updatedItem) {
    return { ok: false, status: 500, error: 'Failed to update item' };
  }

  logger.info(`Removed item "${item.title}" from deletion queue`);

  logActivity({
    eventType: 'manual_action',
    action: 'queue_removed',
    actorType: 'user',
    targetType: 'media_item',
    targetId: id,
    targetTitle: item.title,
  });

  return { ok: true, id: String(id), title: item.title, item: updatedItem };
}

// ============================================================================
// Process the queue
// ============================================================================

export interface ProcessedItem {
  id: number;
  title: string;
  fileSize: number | null;
  deletionAction: DeletionAction;
  deletionActionLabel: string;
  overseerrReset?: boolean;
  overseerrError?: string;
}

export interface ProcessQueueResult {
  /** Items Archive kept back for a decision. */
  held: number;
  processed: number;
  deleted: number;
  failed: number;
  freedSpace: number;
  freedSpaceFormatted: string;
  overseerrResets: number;
  episodes: { processed: number; deleted: number; failed: number };
  dryRun: boolean;
  results: {
    deleted: ProcessedItem[];
    failed: Array<{ id: number; title: string; error: string }>;
  };
  message: string;
}

/**
 * Delete what the queue says is due.
 *
 * `force` processes every pending item regardless of its grace period (the
 * manual "Process Queue" button); otherwise only items whose grace period has
 * expired go. `dryRun` reports what would happen without touching anything.
 */
/**
 * Queue ids of everything due right now (or everything queued, with `force`):
 * media items first, then queued episodes. What Delete All turns into jobs.
 */
export function readyQueueIds(force: boolean, now: Date = new Date()): string[] {
  // Archive holds at-risk items even from Delete All: a person has to decide
  // per item ("delete anyway" or archive), and the Queue page says which.
  const archiveSettings = getArchiveSettings();
  const pendingItems = mediaItemsRepo.getPendingDeletion().filter((item) => !holdState(item, archiveSettings).held);
  const items = force
    ? pendingItems
    : pendingItems.filter((item) => item.delete_after && daysUntil(item.delete_after, now) === 0);
  const episodes = force ? episodeDeletionsRepo.getAllPending() : episodeDeletionsRepo.getDue(now);
  return [...items.map((item) => String(item.id)), ...episodes.map((row) => `ep-${row.id}`)];
}

export async function processQueue(
  options: { dryRun?: boolean; force?: boolean; deletionType?: DeletionType; actorName?: string } = {}
): Promise<ProcessQueueResult> {
  const dryRun = options.dryRun === true;
  const force = options.force === true;

  const deletionService = getDeletionService();
  const archiveSettings = getArchiveSettings();
  const allPending = mediaItemsRepo.getPendingDeletion();
  const pendingItems = allPending.filter((item) => !holdState(item, archiveSettings).held);
  const heldCount = allPending.length - pendingItems.length;
  const now = new Date();

  const itemsReadyForDeletion = force
    ? pendingItems.filter((item) => item.delete_after && item.marked_at)
    : pendingItems.filter((item) => item.delete_after && daysUntil(item.delete_after, now) === 0);

  const episodeRowsReady = force ? episodeDeletionsRepo.getAllPending() : episodeDeletionsRepo.getDue(now);

  const results: ProcessQueueResult['results'] = { deleted: [], failed: [] };

  if (itemsReadyForDeletion.length === 0 && episodeRowsReady.length === 0) {
    return {
      processed: 0,
      deleted: 0,
      failed: 0,
      freedSpace: 0,
      freedSpaceFormatted: '0.00 GB',
      overseerrResets: 0,
      episodes: { processed: 0, deleted: 0, failed: 0 },
      held: heldCount,
      dryRun,
      results,
      message: heldCount > 0 ? `No items ready for deletion (${heldCount} held by Archive for a decision)` : 'No items ready for deletion',
    };
  }

  const notifyItems: Array<{ title: string; type: string; ruleId?: number | null }> = [];
  let freedSpace = 0;
  let overseerrResets = 0;

  for (const item of itemsReadyForDeletion) {
    try {
      const itemAny = item as unknown as Record<string, unknown>;
      const deletionAction = normalizeDeletionAction(itemAny['deletion_action'] as string | undefined);
      const resetOverseerr = Boolean(itemAny['reset_overseerr']);
      const matchedRuleId = itemAny['matched_rule_id'] as number | undefined;

      if (dryRun) {
        const actionDeletesFiles = deletionAction !== DeletionAction.UNMONITOR_ONLY;
        logger.info(`[DRY RUN] Would process: "${item.title}" (action: ${deletionAction}, reset overseerr: ${resetOverseerr})`);
        results.deleted.push({
          id: item.id,
          title: item.title,
          fileSize: actionDeletesFiles ? item.file_size : 0,
          deletionAction,
          deletionActionLabel: DELETION_ACTION_LABELS[deletionAction] || deletionAction,
          overseerrReset: resetOverseerr,
        });
        if (actionDeletesFiles) freedSpace += item.file_size || 0;
        if (resetOverseerr) overseerrResets++;
        continue;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await deletionService.executeDelete(item as any, deletionAction, {
        resetOverseerr,
        ruleId: matchedRuleId,
        deletionType: options.deletionType ?? 'automatic',
        actorName: options.actorName,
      });

      if (result.success) {
        results.deleted.push({
          id: item.id,
          title: item.title,
          fileSize: result.fileSizeFreed || null,
          deletionAction,
          deletionActionLabel: DELETION_ACTION_LABELS[deletionAction] || deletionAction,
          overseerrReset: result.overseerrReset,
          overseerrError: result.overseerrError,
        });
        notifyItems.push({ title: item.title, type: item.type, ruleId: matchedRuleId ?? null });
        freedSpace += result.fileSizeFreed || 0;
        if (result.overseerrReset) overseerrResets++;
        logger.info(`Processed item: "${item.title}" (action: ${deletionAction}, overseerr reset: ${result.overseerrReset})`);
      } else {
        results.failed.push({ id: item.id, title: item.title, error: result.error || 'Unknown error' });
      }
    } catch (itemError) {
      const errorMessage = itemError instanceof Error ? itemError.message : String(itemError);
      logger.error(`Failed to process deletion for "${item.title}":`, itemError);
      results.failed.push({ id: item.id, title: item.title, error: errorMessage });
    }
  }

  // Episodes: dry runs only tally what would go, real runs execute them.
  let episodesDeleted = 0;
  let episodesFailed = 0;

  if (episodeRowsReady.length > 0) {
    if (dryRun) {
      episodesDeleted = episodeRowsReady.length;
      freedSpace += episodeRowsReady.reduce((sum, row) => sum + (row.file_size || 0), 0);
      logger.info(`[DRY RUN] Would process ${episodeRowsReady.length} queued episode(s)`);
    } else {
      const episodeResult = await executeQueuedDeletions(episodeRowsReady);
      episodesDeleted = episodeResult.deleted;
      episodesFailed = episodeResult.failed;
      freedSpace += episodeResult.freedBytes;
      for (const outcome of episodeResult.outcomes.filter((o) => o.success)) {
        notifyItems.push({ title: outcome.label, type: 'episode', ruleId: null });
      }
    }
  }

  const freedSpaceGB = (freedSpace / (1024 * 1024 * 1024)).toFixed(2);
  const totalDeleted = results.deleted.length + episodesDeleted;
  const totalFailed = results.failed.length + episodesFailed;

  logger.info(
    `Queue processing complete: ${totalDeleted} processed, ${totalFailed} failed, ${freedSpaceGB}GB freed, ${overseerrResets} Overseerr resets${dryRun ? ' (dry run)' : ''}`
  );

  if (!dryRun) {
    await sendDeletionCompleteNotification(notifyItems, freedSpace, results.failed.length);
  }

  return {
    processed: itemsReadyForDeletion.length + episodeRowsReady.length,
    deleted: totalDeleted,
    failed: totalFailed,
    freedSpace,
    freedSpaceFormatted: `${freedSpaceGB} GB`,
    overseerrResets,
    episodes: { processed: episodeRowsReady.length, deleted: episodesDeleted, failed: episodesFailed },
    held: heldCount,
    dryRun,
    results,
    message: `${
      dryRun
        ? `Dry run complete: ${totalDeleted} item(s) would be processed`
        : `Processed ${totalDeleted} item(s), ${totalFailed} failed, ${overseerrResets} Overseerr resets`
    }${heldCount > 0 ? `; ${heldCount} held by Archive for a decision` : ''}`,
  };
}

// ============================================================================
// Delete now
// ============================================================================

export type DeleteNowResult =
  | {
      ok: true;
      id: string;
      title: string;
      deletionAction: string;
      deletionActionLabel: string;
      fileSizeFreed: number;
      fileSizeFreedFormatted: string;
      overseerrReset?: boolean;
      overseerrError?: string;
      /** The item had already been deleted in Sonarr/Radarr; the queue caught up. */
      reconciled?: boolean;
      stepDurationsMs?: Record<string, number>;
    }
  | {
      ok: false;
      status: 400 | 404 | 500;
      error: string;
      overseerrError?: string;
      /** Where it failed, when the failure came from a downstream service. */
      step?: string;
      service?: string;
      upstreamStatus?: number;
      stepDurationsMs?: Record<string, number>;
    };

export interface DeleteNowOptions {
  /** Progress events, as streamed to the Queue page's dialog. */
  onProgress?: (progress: DeletionProgress) => void;
  /** Who asked: a person ('manual', the default) or a scheduled run. */
  deletionType?: DeletionType;
  /** Name for the activity log; defaults to "Manual deletion". */
  actorName?: string;
  /** Send the DELETION_COMPLETE notification (default true). Batches send one at the end instead. */
  notify?: boolean;
}

export type QueueItemInspection =
  | { ok: true; kind: 'media'; id: number; title: string; item: MediaItem }
  | { ok: true; kind: 'episode'; id: number; title: string; row: EpisodeDeletion }
  | { ok: false; status: 400 | 404; error: string };

/**
 * Check that a queue id names something that can be deleted right now, before
 * any stream is opened or any service is called.
 */
export function inspectQueueItem(rawId: string): QueueItemInspection {
  const parsedId = parseQueueId(rawId);
  if (!parsedId) {
    return { ok: false, status: 400, error: 'Invalid queue item ID' };
  }

  if (parsedId.kind === 'episode') {
    const row = episodeDeletionsRepo.getById(parsedId.id);
    if (!row || row.status !== 'pending') {
      return { ok: false, status: 404, error: 'Episode is not in the deletion queue' };
    }
    const title = episodeLabel(row.series_title, row.season_number, row.episode_number, row.episode_title);
    return { ok: true, kind: 'episode', id: parsedId.id, title, row };
  }

  const item = mediaItemsRepo.getById(parsedId.id);
  if (!item) {
    return { ok: false, status: 404, error: `Item not found: ${parsedId.id}` };
  }
  if (item.status !== 'pending_deletion') {
    return { ok: false, status: 400, error: 'Item is not in the deletion queue' };
  }
  return { ok: true, kind: 'media', id: parsedId.id, title: item.title, item };
}

/**
 * Delete one queued item immediately, skipping the rest of its grace period.
 * Only items already in the queue can be deleted this way — there is no path
 * from "monitored" straight to "gone".
 */
export async function deleteQueueItemNow(rawId: string, options: DeleteNowOptions = {}): Promise<DeleteNowResult> {
  const inspected = inspectQueueItem(rawId);
  if (!inspected.ok) {
    return { ok: false, status: inspected.status, error: inspected.error };
  }

  const emit = (progress: DeletionProgress): void => {
    try {
      options.onProgress?.(progress);
    } catch (progressError) {
      logger.debug(`Delete-now progress listener failed: ${progressError instanceof Error ? progressError.message : String(progressError)}`);
    }
  };

  if (inspected.kind === 'episode') {
    const { row, title } = inspected;
    emit({ stage: 'starting', message: `Starting deletion of "${title}"...` });
    emit({ stage: 'deleting_files', step: 'delete_files', service: 'Sonarr', message: `Deleting "${title}" in Sonarr...` });

    const result = await executeQueuedDeletions([row]);
    const outcome = result.outcomes[0];

    if (!outcome?.success) {
      const error = outcome?.error || 'Failed to delete episode';
      emit({
        stage: 'error',
        step: 'delete_files',
        service: 'Sonarr',
        message: `Failed while deleting files in Sonarr: ${error}`,
        result: { success: false, error, step: 'delete_files', service: 'Sonarr' },
      });
      return { ok: false, status: 500, error, step: 'delete_files', service: 'Sonarr' };
    }

    if (options.notify !== false) {
      await sendDeletionCompleteNotification([{ title: outcome.label, type: 'episode' }], result.freedBytes, 0);
    }

    emit({
      stage: 'complete',
      message: `"${title}" deleted successfully`,
      result: { success: true, fileSizeFreed: result.freedBytes },
    });

    const freedGB = (result.freedBytes / (1024 * 1024 * 1024)).toFixed(2);
    return {
      ok: true,
      id: `ep-${inspected.id}`,
      title: outcome.label,
      deletionAction: row.deletion_action,
      deletionActionLabel: DELETION_ACTION_LABELS[normalizeDeletionAction(row.deletion_action)] || row.deletion_action,
      fileSizeFreed: result.freedBytes,
      fileSizeFreedFormatted: `${freedGB} GB`,
    };
  }

  const { item } = inspected;
  const deletionService = getDeletionService();
  const itemAny = item as unknown as Record<string, unknown>;
  const deletionAction = normalizeDeletionAction(itemAny['deletion_action'] as string | undefined);
  const resetOverseerr = Boolean(itemAny['reset_overseerr']);
  const matchedRuleId = itemAny['matched_rule_id'] as number | undefined;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await deletionService.executeDelete(item as any, deletionAction, {
    resetOverseerr,
    ruleId: matchedRuleId,
    deletionType: options.deletionType ?? 'manual',
    actorName: options.actorName,
    onProgress: emit,
  });

  if (!result.success) {
    return {
      ok: false,
      status: 500,
      error: result.error || 'Failed to delete item',
      overseerrError: result.overseerrError,
      step: result.failedStep,
      service: result.failedService,
      upstreamStatus: result.upstreamStatus,
      stepDurationsMs: result.stepDurationsMs,
    };
  }

  const freedSpaceGB = ((result.fileSizeFreed || 0) / (1024 * 1024 * 1024)).toFixed(2);
  logger.info(
    result.reconciled
      ? `Reconciled "${item.title}": already deleted upstream, removed from the queue`
      : `Immediately deleted: "${item.title}" (action: ${deletionAction}, freed: ${freedSpaceGB}GB, overseerr reset: ${result.overseerrReset})`
  );

  if (!result.reconciled && options.notify !== false) {
    await sendDeletionCompleteNotification(
      [{ title: item.title, type: item.type, ruleId: matchedRuleId ?? null }],
      result.fileSizeFreed || 0,
      0
    );
  }

  return {
    ok: true,
    id: String(item.id),
    title: item.title,
    deletionAction,
    deletionActionLabel: DELETION_ACTION_LABELS[deletionAction] || deletionAction,
    fileSizeFreed: result.fileSizeFreed || 0,
    fileSizeFreedFormatted: `${freedSpaceGB} GB`,
    overseerrReset: result.overseerrReset,
    overseerrError: result.overseerrError,
    reconciled: result.reconciled,
    stepDurationsMs: result.stepDurationsMs,
  };
}
