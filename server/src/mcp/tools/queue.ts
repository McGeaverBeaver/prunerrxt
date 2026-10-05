import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listQueue, processQueue, removeFromQueue } from '../../services/deletionQueue';
import { enqueueDeleteNow, enqueueReadyItems, listJobs } from '../../services/deletionJobs';
import { formatBytes } from '../../utils/format';
import { DESTRUCTIVE, MUTATING, READ_ONLY, clampLimit, defineTool, fail, ok } from '../helpers';
import { describeReasons } from '../../services/availabilityVerdict';
import { getAvailabilityStatus } from '../../services/availability';

export function registerQueueTools(server: McpServer): void {
  defineTool(
    server,
    {
      name: 'list_queue',
      title: 'List the deletion queue',
      description:
        'Everything waiting to be deleted — whole movies/shows and individual episodes — soonest first, with days remaining, the rule that queued it (if any), the deletion action and the total space it will free. Each movie/show carries its Archive verdict (availability: replaceable, at_risk or unknown, with why) and `held`, true while Archive keeps it back for a decision; resolve a hold with archive_items or clear_availability_hold. Queue ids are strings; episode entries are prefixed "ep-".',
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
        // Archive: can it be downloaded again, and is it being held for a decision?
        availability: i.availability
          ? { verdict: i.availability.verdict, reasons: i.availability.reasons, detail: describeReasons(i.availability), checkedAt: i.availability.checkedAt, releases: i.availability.releases, best: i.availability.best }
          : null,
        held: i.held,
        heldReason: i.heldReason ?? null,
        deleteAnyway: i.deleteAnyway,
      }));
      return ok(
        {
          total: items.length,
          offset: start,
          summary: {
            ...listing.summary,
            totalSizeFormatted: formatBytes(listing.summary.totalSize),
            archive: getAvailabilityStatus(),
          },
          items: page,
        },
        `${listing.summary.totalItems} queued item(s), ${formatBytes(listing.summary.totalSize)} reclaimable, ${listing.summary.readyForDeletion} ready for deletion now, ${listing.summary.replaceable} replaceable, ${listing.summary.atRisk} at risk${listing.summary.unchecked > 0 ? `, ${listing.summary.unchecked} unchecked` : ''}${listing.summary.held > 0 ? `, ${listing.summary.held} held by Archive for a decision (archive_items or clear_availability_hold)` : ''}. Showing ${page.length}.`
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
        const result = removeFromQueue(raw, 'MCP assistant');
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
        'Run the queue. With dryRun=true (the default) it reports exactly what would be deleted and how much space it would free, touching nothing. With dryRun=false it queues background deletion jobs for items whose grace period has expired (force=true: every queued item regardless of grace period) and returns at once; follow them with list_deletion_jobs. Real runs require the "allow immediate deletion" setting and should be confirmed with the user first.',
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
      if (isDryRun) {
        const result = await processQueue({ dryRun: true, force: force === true });
        return ok(result, result.message);
      }
      const batch = enqueueReadyItems({ force: force === true, actorName: 'MCP connector' });
      return ok(
        { ...batch, background: true },
        batch.queued.length > 0
          ? `Queued ${batch.queued.length} deletion job(s) (batch ${batch.batchId}); they run in the background. ${batch.alreadyQueued} were already being deleted. Use list_deletion_jobs to follow progress.`
          : batch.alreadyQueued > 0
            ? 'Those items are already being deleted.'
            : 'No items ready for deletion.'
      );
    }
  );

  defineTool(
    server,
    {
      name: 'list_deletion_jobs',
      title: 'List background deletion jobs',
      description:
        'Deletions run in the background. This lists the jobs that are pending, running or verifying (waiting for Sonarr/Radarr to finish a slow file delete) and the recently finished ones, with their step, elapsed time, outcome, per-step durations and any error.',
      group: 'queue',
      inputSchema: {
        recentLimit: z.number().int().min(1).max(200).optional().describe('How many finished jobs to include (default 25).'),
      },
      annotations: READ_ONLY,
    },
    async ({ recentLimit }) => {
      const jobs = listJobs(clampLimit(recentLimit, 25, 200));
      const now = Date.now();
      const describe = (job: (typeof jobs.active)[number]) => ({
        ...job,
        sizeFormatted: formatBytes(job.size),
        fileSizeFreedFormatted: job.fileSizeFreed === null ? null : formatBytes(job.fileSizeFreed),
        stepElapsedSeconds:
          job.stepStartedAt && (job.status === 'running' || job.status === 'verifying')
            ? Math.round((now - new Date(job.stepStartedAt).getTime()) / 1000)
            : null,
      });
      const active = jobs.active.map(describe);
      const recent = jobs.recent.map(describe);
      const summary =
        active.length === 0
          ? `No deletions in progress; ${recent.length} finished recently (${recent.filter((j) => j.status === 'failed').length} failed).`
          : `${active.length} deletion job(s) in progress: ${active
              .slice(0, 5)
              .map((j) => `"${j.title}" ${j.status}${j.step ? ` (${j.step}${j.stepElapsedSeconds !== null ? `, ${j.stepElapsedSeconds}s` : ''})` : ''}`)
              .join('; ')}.`;
      return ok({ active, recent }, summary);
    }
  );

  defineTool(
    server,
    {
      name: 'delete_now',
      title: 'Delete a queued item now',
      description:
        'Delete one queued item now, skipping the rest of its grace period. The deletion runs as a background job (a large file on slow storage can take minutes); this returns the job at once and list_deletion_jobs reports its progress and outcome. Only items already in the queue can be deleted this way. Irreversible. Requires the "allow immediate deletion" setting; confirm with the user first.',
      group: 'queue',
      inputSchema: {
        queueId: z.string().min(1).describe('Queue id from list_queue (number for an item, "ep-N" for an episode).'),
      },
      annotations: DESTRUCTIVE,
      requiresImmediateDeletion: true,
    },
    async ({ queueId }) => {
      const result = enqueueDeleteNow(queueId, { actorName: 'MCP connector' });
      if (!result.ok) return fail(result.error);
      return ok(
        { job: result.job, alreadyQueued: result.alreadyQueued, background: true },
        result.alreadyQueued
          ? `"${result.job.title}" is already being deleted (job #${result.job.id}, ${result.job.status}).`
          : `Queued "${result.job.title}" for deletion as job #${result.job.id}; it runs in the background. Use list_deletion_jobs to follow it.`
      );
    }
  );
}
