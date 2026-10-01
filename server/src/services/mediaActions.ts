/**
 * Manual actions on library items — queueing for deletion, protecting and
 * unprotecting — with the safety checks every entry point must apply.
 *
 * The REST routes under /api/library and the MCP connector both call these so
 * a protected item (directly or via a protected collection) can never be
 * queued, whichever door the request came through.
 */
import mediaItemsRepo from '../db/repositories/mediaItems';
import collectionsRepo from '../db/repositories/collections';
import settingsRepo from '../db/repositories/settings';
import { logActivity } from '../db/repositories/activity';
import type { MediaItem } from '../types';
import logger from '../utils/logger';

export const DELETION_ACTIONS = [
  'unmonitor_only',
  'delete_files_only',
  'unmonitor_and_delete',
  'full_removal',
] as const;
export type ManualDeletionAction = (typeof DELETION_ACTIONS)[number];

export interface MarkForDeletionOptions {
  /** Days before the item is eligible for deletion. Defaults to the configured grace period. */
  gracePeriodDays?: number;
  deletionAction?: ManualDeletionAction;
  resetOverseerr?: boolean;
  /** Who is acting, for the activity log. Defaults to a plain user action. */
  actorName?: string;
}

export interface ItemOutcome {
  id: number;
  title: string;
}

export interface SkippedOutcome extends ItemOutcome {
  reason: string;
}

export interface FailedOutcome {
  id: number;
  error: string;
}

export interface MarkForDeletionResult {
  queued: ItemOutcome[];
  skipped: SkippedOutcome[];
  failed: FailedOutcome[];
  deleteAfter: string;
  gracePeriodDays: number;
  deletionAction: string;
  resetOverseerr: boolean;
}

/**
 * Why an item cannot be queued, or null when it can.
 */
export function protectionReason(item: MediaItem): string | null {
  if (item.is_protected) return 'Item is protected';
  const protectedCollections = collectionsRepo.findProtectedContainingItem(item.id);
  if (protectedCollections.length > 0) {
    return `Protected via collection "${protectedCollections[0]!.title}"`;
  }
  return null;
}

/** The default grace period, as the Library page reads it. */
export function defaultGracePeriodDays(): number {
  return settingsRepo.getNumber('deletion_grace_period_days', settingsRepo.getNumber('default_grace_period_days', 7));
}

/** The default deletion action, as the Library page reads it. */
export function defaultDeletionAction(): ManualDeletionAction {
  const stored = settingsRepo.getValue('default_deletion_action');
  return (DELETION_ACTIONS as readonly string[]).includes(stored ?? '')
    ? (stored as ManualDeletionAction)
    : 'unmonitor_and_delete';
}

/**
 * Put items into the deletion queue with a grace period. Protected items and
 * tombstones are skipped, never failed; already-queued items keep their
 * original queued date and pick up the new options.
 */
export function markItemsForDeletion(ids: number[], options: MarkForDeletionOptions = {}): MarkForDeletionResult {
  const gracePeriodDays = options.gracePeriodDays ?? defaultGracePeriodDays();
  const deletionAction = options.deletionAction ?? defaultDeletionAction();
  const resetOverseerr = options.resetOverseerr === true;

  const now = new Date();
  const deleteAfter = new Date(now);
  deleteAfter.setDate(deleteAfter.getDate() + gracePeriodDays);
  const deleteAfterIso = deleteAfter.toISOString();

  const result: MarkForDeletionResult = {
    queued: [],
    skipped: [],
    failed: [],
    deleteAfter: deleteAfterIso,
    gracePeriodDays,
    deletionAction,
    resetOverseerr,
  };

  const protectedMap = collectionsRepo.findProtectedForItems(ids);

  for (const id of ids) {
    const item = mediaItemsRepo.getById(id);
    if (!item) {
      result.failed.push({ id, error: 'Item not found' });
      continue;
    }

    if (item.status === 'deleted') {
      result.skipped.push({ id, title: item.title, reason: 'Item is already deleted' });
      continue;
    }

    const protectedColls = protectedMap.get(id) ?? [];
    if (item.is_protected || protectedColls.length > 0) {
      const reason = item.is_protected
        ? 'Item is protected'
        : `Protected via collection "${protectedColls[0]!.title}"`;
      result.skipped.push({ id, title: item.title, reason });
      continue;
    }

    const isAlreadyQueued = item.status === 'pending_deletion';
    const updated = mediaItemsRepo.update(id, {
      status: 'pending_deletion',
      marked_at: isAlreadyQueued ? (item.marked_at ?? undefined) : now.toISOString(),
      delete_after: deleteAfterIso,
      deletion_action: deletionAction,
      reset_overseerr: resetOverseerr ? 1 : 0,
    });

    if (!updated) {
      result.failed.push({ id, error: 'Failed to update' });
      continue;
    }

    result.queued.push({ id, title: item.title });
    logActivity({
      eventType: 'manual_action',
      action: 'item_queued',
      actorType: 'user',
      actorName: options.actorName ?? null,
      targetType: 'media_item',
      targetId: id,
      targetTitle: item.title,
      metadata: JSON.stringify({ gracePeriodDays, deleteAfter: deleteAfterIso, deletionAction, resetOverseerr }),
    });
  }

  logger.info(
    `Mark for deletion: ${result.queued.length} queued, ${result.skipped.length} skipped, ${result.failed.length} failed`
  );

  return result;
}

export interface ProtectResult {
  protected: ItemOutcome[];
  skipped: SkippedOutcome[];
  failed: FailedOutcome[];
}

/**
 * Protect items from every rule and manual deletion. Protecting an item that
 * is in the queue pulls it out of the queue.
 */
export function protectItems(ids: number[], reason: string = 'Manually protected', actorName?: string): ProtectResult {
  const result: ProtectResult = { protected: [], skipped: [], failed: [] };

  for (const id of ids) {
    const item = mediaItemsRepo.getById(id);
    if (!item) {
      result.failed.push({ id, error: 'Item not found' });
      continue;
    }
    if (item.is_protected) {
      result.skipped.push({ id, title: item.title, reason: 'Already protected' });
      continue;
    }

    const updated = mediaItemsRepo.protect(id, reason);
    if (!updated) {
      result.failed.push({ id, error: 'Failed to protect' });
      continue;
    }

    result.protected.push({ id, title: item.title });
    logActivity({
      eventType: 'protection',
      action: 'protected',
      actorType: 'user',
      actorName: actorName ?? null,
      targetType: 'media_item',
      targetId: id,
      targetTitle: item.title,
      metadata: JSON.stringify({ reason }),
    });
  }

  return result;
}

export interface UnprotectResult {
  unprotected: ItemOutcome[];
  skipped: SkippedOutcome[];
  failed: FailedOutcome[];
}

/** Remove item-level protection. Collection-level protection is left alone. */
export function unprotectItems(ids: number[], actorName?: string): UnprotectResult {
  const result: UnprotectResult = { unprotected: [], skipped: [], failed: [] };

  for (const id of ids) {
    const item = mediaItemsRepo.getById(id);
    if (!item) {
      result.failed.push({ id, error: 'Item not found' });
      continue;
    }
    if (!item.is_protected) {
      result.skipped.push({ id, title: item.title, reason: 'Item is not protected' });
      continue;
    }

    const updated = mediaItemsRepo.unprotect(id);
    if (!updated) {
      result.failed.push({ id, error: 'Failed to remove protection' });
      continue;
    }

    result.unprotected.push({ id, title: item.title });
    logActivity({
      eventType: 'protection',
      action: 'unprotected',
      actorType: 'user',
      actorName: actorName ?? null,
      targetType: 'media_item',
      targetId: id,
      targetTitle: item.title,
    });
  }

  return result;
}
