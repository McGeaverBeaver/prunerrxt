import type { MediaItem, MediaType, DeletionType } from '../types';
import {
  DeletionAction,
  type QueueItem,
  type DeletionResult,
  type DeletionStep,
  type UpstreamService,
} from '../rules/types';
import logger from '../utils/logger';
import { logActivity } from '../db/repositories/activity';
import { upstreamStatus, type FileDeletionProgress } from './arrHttp';
import type { OverseerrResetResult } from './overseerr';
import { getArchiveSettings, holdState } from './availabilityVerdict';
import { kickAvailabilityChecks } from './availabilityKick';
import { namedActor, recordAudit } from './audit';

// ============================================================================
// Types
// ============================================================================

export type { DeletionStep, UpstreamService } from '../rules/types';

/** Where a deletion is right now, as streamed to the Queue page. */
export type DeletionStage =
  | 'starting'
  | 'unmonitoring'
  | 'deleting_files'
  | 'verifying'
  | 'resetting_overseerr'
  | 'complete'
  | 'error';

export interface DeletionProgressResult {
  success: boolean;
  fileSizeFreed?: number;
  overseerrReset?: boolean;
  overseerrError?: string;
  /** The item was already gone upstream; nothing was deleted by PrunerrXT. */
  reconciled?: boolean;
  error?: string;
  /** Step and service the failure happened at. */
  step?: DeletionStep;
  service?: UpstreamService;
  /** HTTP status the service answered with, when it answered. */
  upstreamStatus?: number;
  /** How long each step took, for the record. */
  stepDurationsMs?: Partial<Record<DeletionStep, number>>;
}

export interface DeletionProgress {
  stage: DeletionStage;
  step?: DeletionStep;
  service?: UpstreamService;
  message: string;
  fileProgress?: FileDeletionProgress;
  result?: DeletionProgressResult;
}

type StepReporter = (
  step: DeletionStep,
  service: UpstreamService,
  stage: DeletionStage,
  message: string,
  fileProgress?: FileDeletionProgress
) => void;

interface UpstreamOutcome {
  /** Sonarr/Radarr no longer had the item: deleted there already. */
  reconciled: boolean;
  /** At least one file was removed on this run. */
  filesDeleted: boolean;
  /** Which service reported the item missing. */
  service?: UpstreamService;
}

/** Human wording for a step, used in the error line. */
export function describeStep(step: DeletionStep): string {
  switch (step) {
    case 'unmonitor':
      return 'unmonitoring';
    case 'delete_files':
      return 'deleting files';
    case 'remove':
      return 'removing it';
    case 'overseerr_reset':
      return 'resetting the request';
  }
}

function fileMessage(service: UpstreamService, progress: FileDeletionProgress): string {
  const name = progress.fileName.split('/').pop() || progress.fileName;
  const position = progress.total > 1 ? ` (${progress.current}/${progress.total})` : '';
  switch (progress.status) {
    case 'deleting':
      return `Deleting ${name}${position} in ${service}...`;
    case 'verifying':
      return `${service} is still deleting ${name}${position}; waiting for it to finish...`;
    case 'deleted':
      return `Deleted ${name}${position} in ${service}`;
    case 'failed':
      return `${service} could not delete ${name}${position}`;
  }
}

export interface DeletionQueueItem {
  id: number;
  mediaItem: MediaItem;
  markedAt: Date;
  deleteAfter: Date;
  ruleId?: number;
  ruleName?: string;
  daysRemaining: number;
  action: DeletionAction;
}

export interface DeletionHistoryEntry {
  id: number;
  media_item_id: number | null;
  title: string;
  type: MediaType;
  file_size: number | null;
  deleted_at: string;
  deletion_type: DeletionType;
  deleted_by_rule_id: number | null;
}

// ============================================================================
// Service Dependencies
// ============================================================================

export interface DeletionServiceDependencies {
  mediaItemRepository?: {
    getById(id: number): Promise<MediaItem | null>;
    update(id: number, data: Partial<MediaItem>): Promise<void>;
    delete(id: number): Promise<void>;
    getByStatus(status: string): Promise<MediaItem[]>;
  };
  deletionHistoryRepository?: {
    create(data: Omit<DeletionHistoryEntry, 'id'> & { overseerr_reset?: number }): Promise<DeletionHistoryEntry>;
  };
  ruleRepository?: {
    getById(id: number): Promise<{ id: number; name: string; deletion_action?: string; reset_overseerr?: number } | null>;
  };
  sonarrService?: {
    unmonitorSeries(seriesId: number): Promise<'unmonitored' | 'not_found'>;
    deleteAllEpisodeFiles(
      seriesId: number,
      onProgress?: (progress: FileDeletionProgress) => void
    ): Promise<{ outcome: 'deleted' | 'no_files' | 'not_found'; deleted: number; failed: number; errors: string[] }>;
    removeSeries(seriesId: number, deleteFiles: boolean): Promise<'deleted' | 'not_found'>;
    /** Find the series by folder or title when the sync stored no id (see arrMatch.ts). */
    findSeries?(item: MediaItem): Promise<{ id: number; how: string } | null>;
  };
  radarrService?: {
    unmonitorMovie(movieId: number): Promise<'unmonitored' | 'not_found'>;
    deleteMovieFilesByMovieId(
      movieId: number,
      onProgress?: (progress: FileDeletionProgress) => void
    ): Promise<{ outcome: 'deleted' | 'no_file' | 'not_found' }>;
    removeMovie(movieId: number, deleteFiles: boolean): Promise<'deleted' | 'not_found'>;
    /** Find the movie by folder or title when the sync stored no id (see arrMatch.ts). */
    findMovie?(item: MediaItem): Promise<{ id: number; how: string } | null>;
  };
  overseerrService?: {
    resetMediaByTmdbId(tmdbId: number, type: 'movie' | 'tv'): Promise<OverseerrResetResult>;
    getRequestedBy(tmdbId: number, type: 'movie' | 'tv'): Promise<string | null>;
    notifyRequesterOfDeletion(tmdbId: number, type: 'movie' | 'tv', title: string, reason?: string): Promise<boolean>;
  };
  fileService?: {
    deleteFile(path: string): Promise<boolean>;
    getFileSize(path: string): Promise<number | null>;
  };
  notificationService?: {
    notify(event: string, data: Record<string, unknown>): Promise<void>;
  };
}

// ============================================================================
// Deletion Service Class
// ============================================================================

/**
 * Service for managing media item deletion queue and execution
 */
export class DeletionService {
  private dependencies: DeletionServiceDependencies = {};
  private defaultGracePeriodDays: number = 7;
  private defaultDeletionAction: DeletionAction = DeletionAction.UNMONITOR_AND_DELETE;

  constructor(deps?: DeletionServiceDependencies) {
    if (deps) {
      this.dependencies = deps;
    }
  }

  /**
   * Set service dependencies
   */
  setDependencies(deps: DeletionServiceDependencies): void {
    this.dependencies = { ...this.dependencies, ...deps };
    logger.info('Deletion service dependencies configured');
  }

  /**
   * Set default configuration
   */
  setDefaults(gracePeriodDays: number, deletionAction: DeletionAction): void {
    this.defaultGracePeriodDays = gracePeriodDays;
    this.defaultDeletionAction = deletionAction;
  }

  // ============================================================================
  // Queue Management
  // ============================================================================

  /**
   * Mark an item for deletion with a grace period
   */
  async markForDeletion(
    itemId: number,
    options: {
      gracePeriodDays?: number;
      ruleId?: number;
      deletionAction?: DeletionAction;
      resetOverseerr?: boolean;
      skipNotification?: boolean;
    } = {}
  ): Promise<void> {
    const {
      gracePeriodDays = this.defaultGracePeriodDays,
      ruleId,
      deletionAction = this.defaultDeletionAction,
      resetOverseerr = false,
      skipNotification = false,
    } = options;

    logger.info(`Marking item ${itemId} for deletion with ${gracePeriodDays} day grace period, action: ${deletionAction}, reset overseerr: ${resetOverseerr}`);

    if (!this.dependencies.mediaItemRepository) {
      throw new Error('Media item repository not configured');
    }

    const item = await this.dependencies.mediaItemRepository.getById(itemId);
    if (!item) {
      throw new Error(`Media item ${itemId} not found`);
    }

    if (item.is_protected) {
      throw new Error(`Media item ${itemId} is protected and cannot be marked for deletion`);
    }

    const markedAt = new Date();
    const deleteAfter = new Date(markedAt);
    deleteAfter.setDate(deleteAfter.getDate() + gracePeriodDays);

    await this.dependencies.mediaItemRepository.update(itemId, {
      status: 'pending_deletion',
      marked_at: markedAt.toISOString(),
      delete_after: deleteAfter.toISOString(),
      deletion_action: deletionAction,
      reset_overseerr: resetOverseerr ? 1 : 0,
      matched_rule_id: ruleId || null,
    } as any);

    kickAvailabilityChecks();

    // Get rule name if ruleId provided
    let ruleName: string | undefined;
    if (ruleId && this.dependencies.ruleRepository) {
      const rule = await this.dependencies.ruleRepository.getById(ruleId);
      ruleName = rule?.name;
    }

    // Send notification (skipped during bulk operations)
    if (!skipNotification && this.dependencies.notificationService) {
      await this.dependencies.notificationService.notify('ITEMS_MARKED', {
        item: {
          id: item.id,
          title: item.title,
          type: item.type,
        },
        gracePeriodDays,
        deleteAfter: deleteAfter.toISOString(),
        deletionAction,
        resetOverseerr,
        ruleId,
        ruleName,
      });
    }

    // Log to activity log
    try {
      logActivity({
        eventType: 'rule_match',
        action: 'item_queued',
        actorType: ruleId ? 'rule' : 'user',
        actorId: ruleId?.toString() || null,
        actorName: ruleName || 'Manual queue',
        targetType: 'media_item',
        targetId: item.id,
        targetTitle: item.title,
        metadata: JSON.stringify({
          gracePeriodDays,
          deleteAfter: deleteAfter.toISOString(),
          deletionAction,
          resetOverseerr,
        }),
      });
    } catch (activityError) {
      logger.warn('Failed to log activity for mark for deletion:', activityError);
    }

    logger.info(`Item "${item.title}" marked for deletion, will be deleted after ${deleteAfter.toISOString()}`);
  }

  /**
   * Remove an item from the deletion queue
   */
  async unmarkForDeletion(itemId: number): Promise<void> {
    logger.info(`Removing item ${itemId} from deletion queue`);

    if (!this.dependencies.mediaItemRepository) {
      throw new Error('Media item repository not configured');
    }

    const item = await this.dependencies.mediaItemRepository.getById(itemId);
    if (!item) {
      throw new Error(`Media item ${itemId} not found`);
    }

    await this.dependencies.mediaItemRepository.update(itemId, {
      status: 'monitored',
      marked_at: null,
      delete_after: null,
    });

    logger.info(`Item "${item.title}" removed from deletion queue`);
  }

  /**
   * Get all items in the deletion queue
   */
  async getQueue(): Promise<QueueItem[]> {
    if (!this.dependencies.mediaItemRepository) {
      throw new Error('Media item repository not configured');
    }

    const items = await this.dependencies.mediaItemRepository.getByStatus('pending_deletion');
    const now = new Date();

    const queueItems: QueueItem[] = items
      .filter((item) => item.delete_after)
      .map((item) => {
        const deleteAfter = new Date(item.delete_after!);
        const markedAt = item.marked_at ? new Date(item.marked_at) : now;
        const daysRemaining = Math.max(
          0,
          Math.ceil((deleteAfter.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
        );

        // Get deletion action from the item, or use default
        const itemWithExtras = item as any;
        const action = (itemWithExtras.deletion_action as DeletionAction) || this.defaultDeletionAction;
        const resetOverseerr = Boolean(itemWithExtras.reset_overseerr);
        const requestedBy = itemWithExtras.requested_by as string | undefined;
        const matchedRuleId = itemWithExtras.matched_rule_id as number | undefined;

        return {
          id: item.id,
          mediaItem: item,
          markedAt,
          deleteAfter,
          daysRemaining,
          action,
          resetOverseerr,
          requestedBy,
          ruleId: matchedRuleId,
        };
      })
      .sort((a, b) => a.daysRemaining - b.daysRemaining);

    return queueItems;
  }

  /**
   * Get items that are past their grace period and ready for deletion
   */
  async getPendingDeletions(): Promise<QueueItem[]> {
    const queue = await this.getQueue();
    const settings = getArchiveSettings();
    return queue.filter((item) => item.daysRemaining === 0 && !holdState(item.mediaItem, settings).held);
  }

  /** Items past their grace period that Archive is holding for a decision. */
  async getHeldDeletions(): Promise<QueueItem[]> {
    const queue = await this.getQueue();
    const settings = getArchiveSettings();
    return queue.filter((item) => item.daysRemaining === 0 && holdState(item.mediaItem, settings).held);
  }

  // ============================================================================
  // Deletion Execution
  // ============================================================================

  /**
   * Process all pending deletions
   */
  async processPendingDeletions(
    dryRun: boolean = false,
    options: { excludeItemIds?: Set<number> } = {}
  ): Promise<DeletionResult[]> {
    logger.info(`Processing pending deletions (dryRun: ${dryRun})`);

    const due = await this.getPendingDeletions();
    // Items a background job already owns are left to it.
    const pendingItems = options.excludeItemIds
      ? due.filter((queueItem) => !options.excludeItemIds!.has(queueItem.mediaItem.id))
      : due;
    if (pendingItems.length < due.length) {
      logger.info(`Skipping ${due.length - pendingItems.length} item(s) already being deleted by a background job`);
    }
    const results: DeletionResult[] = [];

    logger.info(`Found ${pendingItems.length} items ready for deletion`);

    for (const queueItem of pendingItems) {
      try {
        if (dryRun) {
          logger.info(`[DRY RUN] Would delete: "${queueItem.mediaItem.title}" (action: ${queueItem.action}, overseerr reset: ${queueItem.resetOverseerr})`);
          results.push({
            success: true,
            itemId: queueItem.mediaItem.id,
            title: queueItem.mediaItem.title,
            action: queueItem.action,
            fileSizeFreed: queueItem.action !== DeletionAction.UNMONITOR_ONLY ? (queueItem.mediaItem.file_size || 0) : 0,
            overseerrReset: queueItem.resetOverseerr,
          });
        } else {
          const result = await this.executeDelete(queueItem.mediaItem, queueItem.action, {
            resetOverseerr: queueItem.resetOverseerr,
            ruleId: queueItem.ruleId,
          });
          results.push(result);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`Failed to delete item "${queueItem.mediaItem.title}":`, error);
        results.push({
          success: false,
          itemId: queueItem.mediaItem.id,
          title: queueItem.mediaItem.title,
          action: queueItem.action,
          error: errorMessage,
        });
      }
    }

    // Log summary
    const successful = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);
    const totalFreed = successful.reduce((sum, r) => sum + (r.fileSizeFreed || 0), 0);
    const overseerrResets = successful.filter((r) => r.overseerrReset).length;

    logger.info(
      `Deletion processing complete: ${successful.length} successful, ${failed.length} failed, ` +
        `${(totalFreed / (1024 * 1024 * 1024)).toFixed(2)}GB freed, ${overseerrResets} Overseerr resets`
    );

    return results;
  }

  /**
   * Execute deletion for a single media item.
   *
   * Every call to Sonarr/Radarr is reported through `onProgress` with the step
   * and the service it is talking to, so a progress dialog can show exactly
   * where a deletion is. Three outcomes are not failures:
   *
   * - the item is no longer in Sonarr/Radarr (404): somebody deleted it there
   *   already. The remaining upstream steps are skipped, the Overseerr reset
   *   still runs, and the item is marked deleted and logged as reconciled.
   * - the item has no file left to delete: nothing is freed, the item is still
   *   marked deleted.
   * - a file delete outlasted the HTTP timeout but the upstream app finished it
   *   anyway (verified by the service clients).
   *
   * Anything else fails the deletion, leaves the item in the queue and writes
   * an `error` activity entry naming the step, the service and its answer.
   */
  async executeDelete(
    item: MediaItem,
    action: DeletionAction,
    options: {
      resetOverseerr?: boolean;
      ruleId?: number;
      /** Who asked: a scheduled run ('automatic') or a person ('manual'). */
      deletionType?: DeletionType;
      /** The person's name, when known, for the activity log. */
      actorName?: string;
      onProgress?: (progress: DeletionProgress) => void;
    } = {}
  ): Promise<DeletionResult> {
    logger.info(`Executing deletion for "${item.title}" with action: ${action}, resetOverseerr: ${options.resetOverseerr}`);

    const startTime = Date.now();
    const deletionType: DeletionType = options.deletionType ?? 'automatic';
    // Only count freed space if we're actually deleting files
    const deletesFiles = action !== DeletionAction.UNMONITOR_ONLY;
    let fileSizeFreed = 0;
    let overseerrReset = false;
    let overseerrError: string | undefined;
    let reconciled = false;
    let reconciledService: UpstreamService | undefined;

    // The step in flight, so a failure can say where it happened. Kept on an
    // object because it is written from a callback, which narrowing can't see.
    const inFlight: { current: { step: DeletionStep; service: UpstreamService } | null } = { current: null };
    // How long each step took, so a slow Sonarr/Radarr shows up in the activity
    // log with numbers rather than as a vague "it hung for a while".
    const stepDurations: Partial<Record<DeletionStep, number>> = {};
    let stepStartedAt = Date.now();
    const closeStep = (): void => {
      if (!inFlight.current) return;
      const step = inFlight.current.step;
      stepDurations[step] = (stepDurations[step] ?? 0) + (Date.now() - stepStartedAt);
    };

    const emit = (progress: DeletionProgress): void => {
      try {
        options.onProgress?.(progress);
      } catch (progressError) {
        logger.debug(`Deletion progress listener failed: ${progressError instanceof Error ? progressError.message : String(progressError)}`);
      }
    };
    const report: StepReporter = (step, service, stage, message, fileProgress) => {
      if (inFlight.current?.step !== step) {
        closeStep();
        stepStartedAt = Date.now();
      }
      inFlight.current = { step, service };
      emit(fileProgress ? { stage, step, service, message, fileProgress } : { stage, step, service, message });
    };

    emit({ stage: 'starting', message: `Starting deletion of "${item.title}"...` });

    try {
      const upstream = await this.runUpstreamSteps(item, action, report);
      reconciled = upstream.reconciled;
      reconciledService = upstream.service;
      if (deletesFiles && upstream.filesDeleted) {
        fileSizeFreed = item.file_size || 0;
      }

      // Reset in Overseerr if requested and item has TMDB ID. Runs even when the
      // item was already gone upstream: the request still needs clearing.
      if (options.resetOverseerr && item.tmdb_id && this.dependencies.overseerrService) {
        report('overseerr_reset', 'Overseerr', 'resetting_overseerr', 'Resetting in Seerr so it can be requested again...');
        try {
          const mediaType = item.type === 'movie' ? 'movie' : 'tv';
          const reset = await this.dependencies.overseerrService.resetMediaByTmdbId(item.tmdb_id, mediaType);

          if (reset.outcome === 'reset') {
            overseerrReset = true;
            logger.info(`Reset "${item.title}" in Overseerr - can be re-requested`);

            // Update media item with reset timestamp
            if (this.dependencies.mediaItemRepository) {
              await this.dependencies.mediaItemRepository.update(item.id, {
                overseerr_reset_at: new Date().toISOString(),
              } as any);
            }
          } else if (reset.outcome === 'nothing_to_reset') {
            logger.info(`Nothing to reset in Overseerr for "${item.title}": ${reset.message}`);
          } else {
            overseerrError = reset.message;
            logger.warn(`Failed to reset "${item.title}" in Overseerr: ${reset.message}`);
            await this.logOverseerrFailure(item, options.ruleId, deletionType, options.actorName, reset.message, reset.status);
          }
        } catch (overseerrErr) {
          overseerrError = overseerrErr instanceof Error ? overseerrErr.message : String(overseerrErr);
          logger.warn(`Failed to reset "${item.title}" in Overseerr: ${overseerrError}`);
          await this.logOverseerrFailure(item, options.ruleId, deletionType, options.actorName, overseerrError, upstreamStatus(overseerrErr));
          // Don't fail the deletion, just log the error
        }
      }
      closeStep();
      inFlight.current = null;

      // The Sonarr/Radarr work is done above. Each post-delete step (history
      // write, rule lookup, activity log, status update) runs in its own
      // try-catch so a failure in one doesn't lose the others or mark the
      // whole deletion as failed — the file is gone either way.

      recordAudit({
        action: 'item.deleted',
        actor: options.actorName ? namedActor(options.actorName, 'user') : deletionType === 'automatic' ? { type: 'scheduler', name: 'Scheduled queue run' } : { type: 'user', name: 'Manual deletion' },
        targetType: 'media_item',
        targetId: item.id,
        targetTitle: item.title,
        details: { deletionType, action, bytesFreed: fileSizeFreed, ruleId: options.ruleId ?? null, overseerrReset, radarrId: item.radarr_id, sonarrId: item.sonarr_id, filePath: item.file_path },
      });

      // Record in deletion history
      if (this.dependencies.deletionHistoryRepository) {
        try {
          await this.dependencies.deletionHistoryRepository.create({
            media_item_id: item.id,
            title: item.title,
            type: item.type,
            file_size: fileSizeFreed > 0 ? fileSizeFreed : null,
            deleted_at: new Date().toISOString(),
            deletion_type: deletionType,
            deleted_by_rule_id: options.ruleId || null,
            overseerr_reset: overseerrReset ? 1 : 0,
          });
        } catch (historyError) {
          logger.warn(`Failed to record deletion history for "${item.title}":`, historyError);
        }
      }

      const { actorType, actorId, actorName } = await this.actorFor(options.ruleId, deletionType, options.actorName);

      // Log to activity log
      try {
        logActivity({
          eventType: 'deletion',
          action: reconciled ? 'reconciled' : action === DeletionAction.UNMONITOR_ONLY ? 'unmonitored' : 'deleted',
          actorType,
          actorId,
          actorName,
          targetType: 'media_item',
          targetId: item.id,
          targetTitle: item.title,
          metadata: JSON.stringify({
            mediaType: item.type,
            fileSize: reconciled ? 0 : item.file_size,
            deletionAction: action,
            deletionType,
            overseerrReset,
            stepDurationsMs: stepDurations,
            ...(reconciled
              ? {
                  reconciled: true,
                  reason: 'already deleted upstream',
                  service: reconciledService,
                  upstreamStatus: 404,
                }
              : {}),
          }),
        });
      } catch (activityError) {
        logger.warn('Failed to log activity for deletion:', activityError);
      }

      // Mark the item as a "deleted" tombstone in the local catalog. The row
      // is kept (never hard-removed, even for FULL_REMOVAL) on purpose: Plex
      // holds a movie's metadata entry for a while after its file is gone, so
      // a hard-deleted row would simply be re-imported as a fresh `monitored`
      // item on the next sync and rules would immediately re-queue it — an
      // endless delete/re-queue loop. deleted_at lets a later sync distinguish
      // that stale entry from a genuine re-add.
      if (this.dependencies.mediaItemRepository) {
        try {
          await this.dependencies.mediaItemRepository.update(item.id, {
            status: 'deleted',
            marked_at: null,
            delete_after: null,
            deleted_at: new Date().toISOString(),
          });
        } catch (statusError) {
          logger.warn(`Failed to update status for "${item.title}":`, statusError);
        }
      }

      const duration = Date.now() - startTime;
      const timings = Object.entries(stepDurations).map(([step, ms]) => `${step} ${ms}ms`).join(', ');
      logger.info(
        reconciled
          ? `Reconciled "${item.title}" in ${duration}ms: already deleted in ${reconciledService}, removed from the queue`
          : `Successfully processed "${item.title}" in ${duration}ms (action: ${action}, overseerr reset: ${overseerrReset}; ${timings || 'no upstream steps'})`
      );

      emit({
        stage: 'complete',
        message: reconciled
          ? `"${item.title}" was already deleted in ${reconciledService}; removed from the queue`
          : `"${item.title}" deleted successfully`,
        result: { success: true, fileSizeFreed, overseerrReset, reconciled, stepDurationsMs: stepDurations, ...(overseerrError ? { overseerrError } : {}) },
      });

      return {
        success: true,
        itemId: item.id,
        title: item.title,
        action,
        fileSizeFreed,
        deletedAt: new Date(),
        overseerrReset,
        overseerrError,
        reconciled,
        stepDurationsMs: stepDurations,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      closeStep();
      const failedAt = inFlight.current;
      const status = upstreamStatus(error);
      logger.error(`Failed to delete "${item.title}" at step ${failedAt?.step ?? 'unknown'} (${failedAt?.service ?? 'PrunerrXT'}${status ? `, HTTP ${status}` : ''}): ${errorMessage}`);

      // Every failure is visible in the activity log, with enough detail to
      // act on: which step, which service, and what it answered.
      try {
        const { actorType, actorId, actorName } = await this.actorFor(options.ruleId, deletionType, options.actorName);
        logActivity({
          eventType: 'error',
          action: 'deletion_failed',
          actorType,
          actorId,
          actorName,
          targetType: 'media_item',
          targetId: item.id,
          targetTitle: item.title,
          metadata: JSON.stringify({
            mediaType: item.type,
            fileSize: item.file_size,
            deletionAction: action,
            deletionType,
            step: failedAt?.step ?? null,
            service: failedAt?.service ?? null,
            upstreamStatus: status ?? null,
            message: errorMessage,
            stepDurationsMs: stepDurations,
          }),
        });
      } catch (activityError) {
        logger.warn('Failed to log activity for deletion failure:', activityError);
      }

      emit({
        stage: 'error',
        message: failedAt
          ? `Failed while ${describeStep(failedAt.step)} in ${failedAt.service}: ${errorMessage}`
          : `Failed to delete: ${errorMessage}`,
        ...(failedAt ? { step: failedAt.step, service: failedAt.service } : {}),
        result: {
          success: false,
          error: errorMessage,
          ...(failedAt ? { step: failedAt.step, service: failedAt.service } : {}),
          ...(status !== undefined ? { upstreamStatus: status } : {}),
          overseerrReset,
        },
      });

      return {
        success: false,
        itemId: item.id,
        title: item.title,
        action,
        error: errorMessage,
        overseerrReset,
        overseerrError,
        failedStep: failedAt?.step,
        failedService: failedAt?.service,
        upstreamStatus: status,
        stepDurationsMs: stepDurations,
      };
    }
  }

  /**
   * Attribution for history and activity entries. A manual run is always the
   * person (by name when login knows it), even when a rule originally queued
   * the item; a scheduled run is the rule, or the scheduler.
   */
  private async actorFor(
    ruleId: number | undefined,
    deletionType: DeletionType,
    actorName?: string
  ): Promise<{ actorType: 'rule' | 'user'; actorId: string | null; actorName: string }> {
    if (deletionType === 'manual') {
      return { actorType: 'user', actorId: null, actorName: actorName || 'Manual deletion' };
    }
    if (!ruleId) {
      return { actorType: 'user', actorId: null, actorName: actorName || 'Scheduled deletion' };
    }
    let ruleName: string | undefined;
    if (this.dependencies.ruleRepository) {
      try {
        const rule = await this.dependencies.ruleRepository.getById(ruleId);
        ruleName = rule?.name;
      } catch (ruleLookupError) {
        logger.warn(`Failed to resolve rule name for ruleId ${ruleId}:`, ruleLookupError);
      }
    }
    return { actorType: 'rule', actorId: String(ruleId), actorName: ruleName || `Rule #${ruleId}` };
  }

  /**
   * A Seerr reset that did not happen is worth an error entry of its own: the
   * deletion still succeeded, but the request is still marked available and
   * nobody would otherwise know.
   */
  private async logOverseerrFailure(
    item: MediaItem,
    ruleId: number | undefined,
    deletionType: DeletionType,
    actorName: string | undefined,
    message: string,
    status: number | undefined
  ): Promise<void> {
    try {
      const actor = await this.actorFor(ruleId, deletionType, actorName);
      logActivity({
        eventType: 'error',
        action: 'overseerr_reset_failed',
        actorType: actor.actorType,
        actorId: actor.actorId,
        actorName: actor.actorName,
        targetType: 'media_item',
        targetId: item.id,
        targetTitle: item.title,
        metadata: JSON.stringify({
          mediaType: item.type,
          tmdbId: item.tmdb_id,
          step: 'overseerr_reset',
          service: 'Overseerr',
          upstreamStatus: status ?? null,
          message,
        }),
      });
    } catch (activityError) {
      logger.warn('Failed to log activity for Overseerr reset failure:', activityError);
    }
  }

  // ============================================================================
  // Upstream steps
  // ============================================================================

  /**
   * An item the sync could not link by id may still be findable: Radarr and
   * Sonarr name the folder the file sits in, and the title and year are
   * known. Ask the owning app once, and remember the answer so the next sync
   * and the next deletion do not have to look again.
   */
  private async resolveUpstreamId(item: MediaItem): Promise<void> {
    const sonarr = this.dependencies.sonarrService;
    const radarr = this.dependencies.radarrService;
    try {
      if (item.type === 'movie' && radarr?.findMovie) {
        const hit = await radarr.findMovie(item);
        if (!hit) return;
        item.radarr_id = hit.id;
        logger.info(`Linked "${item.title}" to Radarr #${hit.id} by ${hit.how} at deletion time`);
        await this.dependencies.mediaItemRepository?.update(item.id, { radarr_id: hit.id });
      } else if (item.type === 'show' && sonarr?.findSeries) {
        const hit = await sonarr.findSeries(item);
        if (!hit) return;
        item.sonarr_id = hit.id;
        logger.info(`Linked "${item.title}" to Sonarr #${hit.id} by ${hit.how} at deletion time`);
        await this.dependencies.mediaItemRepository?.update(item.id, { sonarr_id: hit.id });
      }
    } catch (error) {
      logger.warn(`Could not look "${item.title}" up upstream: ${(error as Error).message}`);
    }
  }

  /**
   * Talk to Sonarr/Radarr for the given action, reporting each step.
   *
   * Returns as soon as either app says it no longer has the item: the rest of
   * the upstream work is moot and the caller finishes the bookkeeping as a
   * reconciliation. Throws on a real failure, with the failing step already
   * reported through `report`.
   */
  private async runUpstreamSteps(
    item: MediaItem,
    action: DeletionAction,
    report: StepReporter
  ): Promise<UpstreamOutcome> {
    const unmonitor = action === DeletionAction.UNMONITOR_ONLY || action === DeletionAction.UNMONITOR_AND_DELETE;
    const deleteFiles = action === DeletionAction.DELETE_FILES_ONLY || action === DeletionAction.UNMONITOR_AND_DELETE;
    const remove = action === DeletionAction.FULL_REMOVAL;
    if (!unmonitor && !deleteFiles && !remove) {
      throw new Error(`Unknown deletion action: ${action}`);
    }

    const sonarr = this.dependencies.sonarrService;
    const radarr = this.dependencies.radarrService;
    let filesDeleted = false;
    let touchedUpstream = false;

    if (!item.sonarr_id && !item.radarr_id) {
      await this.resolveUpstreamId(item);
    }

    if (item.sonarr_id && sonarr) {
      touchedUpstream = true;
      const seriesId = item.sonarr_id;
      if (unmonitor) {
        report('unmonitor', 'Sonarr', 'unmonitoring', `Unmonitoring "${item.title}" in Sonarr...`);
        if ((await sonarr.unmonitorSeries(seriesId)) === 'not_found') {
          return { reconciled: true, filesDeleted: false, service: 'Sonarr' };
        }
      }
      if (deleteFiles) {
        report('delete_files', 'Sonarr', 'deleting_files', 'Looking up episode files in Sonarr...');
        const result = await sonarr.deleteAllEpisodeFiles(seriesId, (progress) =>
          report('delete_files', 'Sonarr', progress.status === 'verifying' ? 'verifying' : 'deleting_files', fileMessage('Sonarr', progress), progress)
        );
        if (result.outcome === 'not_found') {
          return { reconciled: true, filesDeleted: false, service: 'Sonarr' };
        }
        if (result.failed > 0) {
          const detail = result.errors.slice(0, 3).join('; ');
          throw new Error(
            `Sonarr could not delete ${result.failed} of ${result.deleted + result.failed} episode files${detail ? `: ${detail}` : ''}`
          );
        }
        filesDeleted = filesDeleted || result.deleted > 0;
      }
      if (remove) {
        report('remove', 'Sonarr', 'deleting_files', `Removing "${item.title}" and its files from Sonarr...`);
        if ((await sonarr.removeSeries(seriesId, true)) === 'not_found') {
          return { reconciled: true, filesDeleted: false, service: 'Sonarr' };
        }
        filesDeleted = true;
      }
    }

    if (item.radarr_id && radarr) {
      touchedUpstream = true;
      const movieId = item.radarr_id;
      if (unmonitor) {
        report('unmonitor', 'Radarr', 'unmonitoring', `Unmonitoring "${item.title}" in Radarr...`);
        if ((await radarr.unmonitorMovie(movieId)) === 'not_found') {
          return { reconciled: true, filesDeleted: false, service: 'Radarr' };
        }
      }
      if (deleteFiles) {
        report('delete_files', 'Radarr', 'deleting_files', 'Looking up the movie file in Radarr...');
        const result = await radarr.deleteMovieFilesByMovieId(movieId, (progress) =>
          report('delete_files', 'Radarr', progress.status === 'verifying' ? 'verifying' : 'deleting_files', fileMessage('Radarr', progress), progress)
        );
        if (result.outcome === 'not_found') {
          return { reconciled: true, filesDeleted: false, service: 'Radarr' };
        }
        filesDeleted = filesDeleted || result.outcome === 'deleted';
      }
      if (remove) {
        report('remove', 'Radarr', 'deleting_files', `Removing "${item.title}" and its file from Radarr...`);
        if ((await radarr.removeMovie(movieId, true)) === 'not_found') {
          return { reconciled: true, filesDeleted: false, service: 'Radarr' };
        }
        filesDeleted = true;
      }
    }

    if (!touchedUpstream) {
      // The service that should own this item is configured, but the item
      // has no id there: marking it deleted would leave the file on disk and
      // the queue none the wiser. Fail it so somebody looks.
      const expected: UpstreamService | null = item.type === 'movie' ? 'Radarr' : item.type === 'show' ? 'Sonarr' : null;
      const configured = expected === 'Radarr' ? Boolean(radarr) : expected === 'Sonarr' ? Boolean(sonarr) : false;
      if (expected && configured && !this.dependencies.fileService) {
        throw new Error(
          `"${item.title}" is not linked to ${expected} (no ${expected} match was found for it during sync), so PrunerrXT cannot ${remove ? 'remove' : deleteFiles ? 'delete its files' : 'unmonitor it'}. Check the title exists in ${expected}, then run a library sync.`
        );
      }
      logger.warn(`"${item.title}" is not linked to Sonarr or Radarr; nothing to ${remove ? 'remove' : deleteFiles ? 'delete' : 'unmonitor'} upstream`);
    }

    // Delete the physical file directly when a file service is wired up (none
    // is by default; Sonarr/Radarr own the files).
    if ((deleteFiles || remove) && item.file_path && this.dependencies.fileService) {
      const deleted = await this.dependencies.fileService.deleteFile(item.file_path);
      if (deleted) filesDeleted = true;
      else logger.warn(`Could not delete file at: ${item.file_path}`);
    }

    return { reconciled: false, filesDeleted };
  }

  // ============================================================================
  // Utility Methods
  // ============================================================================

  /**
   * Get deletion statistics
   */
  async getStatistics(): Promise<{
    queueSize: number;
    pendingDeletions: number;
    totalSizeToFree: number;
  }> {
    const queue = await this.getQueue();
    const pending = queue.filter((item) => item.daysRemaining === 0);
    const totalSize = queue.reduce(
      (sum, item) => sum + (item.mediaItem.file_size || 0),
      0
    );

    return {
      queueSize: queue.length,
      pendingDeletions: pending.length,
      totalSizeToFree: totalSize,
    };
  }

  /**
   * Bulk mark items for deletion
   */
  async bulkMarkForDeletion(
    itemIds: number[],
    options: {
      gracePeriodDays?: number;
      ruleId?: number;
      deletionAction?: DeletionAction;
      resetOverseerr?: boolean;
    } = {}
  ): Promise<{ success: number; failed: number; errors: Array<{ id: number; error: string }> }> {
    const results = {
      success: 0,
      failed: 0,
      errors: [] as Array<{ id: number; error: string }>,
    };

    const markedItems: Array<{ id: number; title: string; type: string }> = [];

    for (const itemId of itemIds) {
      try {
        // Get item info before marking (for bulk notification)
        const item = this.dependencies.mediaItemRepository
          ? await this.dependencies.mediaItemRepository.getById(itemId)
          : null;

        await this.markForDeletion(itemId, { ...options, skipNotification: true });
        results.success++;

        if (item) {
          markedItems.push({ id: item.id, title: item.title, type: item.type });
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        results.failed++;
        results.errors.push({ id: itemId, error: errorMessage });
      }
    }

    // Send a single bulk notification after all items are processed
    if (this.dependencies.notificationService && markedItems.length > 0) {
      const gracePeriodDays = options.gracePeriodDays ?? this.defaultGracePeriodDays;
      const deleteAfter = new Date();
      deleteAfter.setDate(deleteAfter.getDate() + gracePeriodDays);

      // Get rule name if ruleId provided
      let ruleName: string | undefined;
      if (options.ruleId && this.dependencies.ruleRepository) {
        const rule = await this.dependencies.ruleRepository.getById(options.ruleId);
        ruleName = rule?.name;
      }

      try {
        await this.dependencies.notificationService.notify('ITEMS_MARKED', {
          items: markedItems,
          count: markedItems.length,
          gracePeriodDays,
          deleteAfter: deleteAfter.toISOString(),
          deletionAction: options.deletionAction ?? this.defaultDeletionAction,
          resetOverseerr: options.resetOverseerr ?? false,
          ruleId: options.ruleId,
          ruleName,
        });
      } catch (notifyError) {
        logger.error('Failed to send bulk mark notification:', notifyError);
      }
    }

    logger.info(`Bulk mark for deletion: ${results.success} succeeded, ${results.failed} failed`);
    return results;
  }

  /**
   * Bulk unmark items from deletion
   */
  async bulkUnmarkForDeletion(
    itemIds: number[]
  ): Promise<{ success: number; failed: number; errors: Array<{ id: number; error: string }> }> {
    const results = {
      success: 0,
      failed: 0,
      errors: [] as Array<{ id: number; error: string }>,
    };

    for (const itemId of itemIds) {
      try {
        await this.unmarkForDeletion(itemId);
        results.success++;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        results.failed++;
        results.errors.push({ id: itemId, error: errorMessage });
      }
    }

    logger.info(`Bulk unmark for deletion: ${results.success} succeeded, ${results.failed} failed`);
    return results;
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let deletionServiceInstance: DeletionService | null = null;

/**
 * Get the singleton deletion service instance
 */
export function getDeletionService(): DeletionService {
  if (!deletionServiceInstance) {
    deletionServiceInstance = new DeletionService();
  }
  return deletionServiceInstance;
}

/**
 * Create a new deletion service instance
 */
export function createDeletionService(deps?: DeletionServiceDependencies): DeletionService {
  return new DeletionService(deps);
}

export { DeletionAction };
export default DeletionService;
