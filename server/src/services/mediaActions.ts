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
import { kickAvailabilityChecks } from './availabilityKick';

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

  if (result.queued.length > 0) kickAvailabilityChecks();

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

export interface ArchiveResult {
  archived: ItemOutcome[];
  skipped: SkippedOutcome[];
  failed: FailedOutcome[];
}

/**
 * Archive items: protect them because they could not be downloaded again
 * (or because a person decided they are not worth the risk). An archived item
 * is a protected item with `archived_at` set, so every rule, scan and manual
 * deletion already leaves it alone; it leaves the queue if it was in it. The
 * only way out is "Remove protection" / unarchive.
 */
export function archiveItems(ids: number[], reason: string = 'Archived', actorName?: string): ArchiveResult {
  const result: ArchiveResult = { archived: [], skipped: [], failed: [] };
  const now = new Date().toISOString();

  for (const id of ids) {
    const item = mediaItemsRepo.getById(id);
    if (!item) {
      result.failed.push({ id, error: 'Item not found' });
      continue;
    }
    if (item.archived_at) {
      result.skipped.push({ id, title: item.title, reason: 'Already archived' });
      continue;
    }
    if (item.status === 'deleted') {
      result.skipped.push({ id, title: item.title, reason: 'Item is already deleted' });
      continue;
    }

    const updated = mediaItemsRepo.update(id, {
      is_protected: true,
      protection_reason: reason,
      archived_at: now,
      protected_at: now,
      status: 'protected',
      marked_at: null,
      delete_after: null,
      availability_decision: null,
    });
    if (!updated) {
      result.failed.push({ id, error: 'Failed to archive' });
      continue;
    }

    result.archived.push({ id, title: item.title });
    logActivity({
      eventType: 'protection',
      action: 'archived',
      actorType: actorName ? 'user' : 'scheduler',
      actorName: actorName ?? null,
      targetType: 'media_item',
      targetId: id,
      targetTitle: item.title,
      metadata: JSON.stringify({ reason, wasQueued: item.status === 'pending_deletion' }),
    });
  }

  logger.info(`Archive: ${result.archived.length} archived, ${result.skipped.length} skipped, ${result.failed.length} failed`);
  return result;
}

/** Record that a person wants an at-risk queued item deleted anyway. */
export function allowDeletionAnyway(id: number, actorName?: string): { ok: true; item: MediaItem } | { ok: false; status: number; error: string } {
  const item = mediaItemsRepo.getById(id);
  if (!item) return { ok: false, status: 404, error: `Item not found: ${id}` };
  if (item.status !== 'pending_deletion') return { ok: false, status: 400, error: 'Item is not in the deletion queue' };
  const updated = mediaItemsRepo.update(id, { availability_decision: 'delete' });
  if (!updated) return { ok: false, status: 500, error: 'Failed to update item' };
  logActivity({
    eventType: 'protection',
    action: 'availability_overridden',
    actorType: 'user',
    actorName: actorName ?? null,
    targetType: 'media_item',
    targetId: id,
    targetTitle: item.title,
  });
  return { ok: true, item: updated };
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
      action: item.archived_at ? 'unarchived' : 'unprotected',
      actorType: 'user',
      actorName: actorName ?? null,
      targetType: 'media_item',
      targetId: id,
      targetTitle: item.title,
    });
  }

  return result;
}
