import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { foldersApi } from '@/services/api';
import { useAuth } from '@/contexts/AuthContext';
import type { FolderBatchSummary, FolderJob } from '@/types';

/**
 * Bulk folder jobs, live. Follows the server's event stream (polling while it
 * is down) and refreshes the folder list as jobs finish, so deleted and
 * imported folders drop out of the page while the batch runs.
 */
const ACTIVE = new Set(['pending', 'running']);
const POLL_MS = 5_000;

type StreamEvent = { type: 'snapshot'; active: FolderJob[]; recent: FolderJob[] } | { type: 'job'; job: FolderJob };

export function summariseBatches(jobs: FolderJob[]): FolderBatchSummary[] {
  const byBatch = new Map<string, FolderBatchSummary>();
  for (const job of jobs) {
    let summary = byBatch.get(job.batchId);
    if (!summary) {
      summary = { batchId: job.batchId, action: job.action, requestedBy: job.requestedBy, total: 0, pending: 0, running: 0, done: 0, failed: 0, cancelled: 0, freedBytes: 0, createdAt: job.createdAt, finishedAt: null };
      byBatch.set(job.batchId, summary);
    }
    summary.total += 1;
    summary[job.status] += 1;
    if (job.createdAt < summary.createdAt) summary.createdAt = job.createdAt;
    if (job.status === 'done' && job.action === 'delete') summary.freedBytes += Number(job.result?.['sizeBytes'] ?? 0);
    if (job.finishedAt && (!summary.finishedAt || job.finishedAt > summary.finishedAt)) summary.finishedAt = job.finishedAt;
  }
  for (const summary of byBatch.values()) {
    if (summary.pending > 0 || summary.running > 0) summary.finishedAt = null;
  }
  return [...byBatch.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function useFolderJobs() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [jobs, setJobs] = useState<Map<number, FolderJob>>(new Map());
  const [connected, setConnected] = useState(false);
  const lastStatus = useRef<Map<number, string>>(new Map());
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const allowed = auth.status === 'ready' && (!auth.enabled || auth.user !== null);

  // A finished job changes the folder list; refresh it, but not more than
  // once a second during a fast batch.
  const scheduleListRefresh = useCallback(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      void queryClient.invalidateQueries({ queryKey: ['folders'] });
      void queryClient.invalidateQueries({ queryKey: ['activity'] });
    }, 1_000);
  }, [queryClient]);

  const noteTransitions = useCallback(
    (incoming: FolderJob[]) => {
      let finished = false;
      for (const job of incoming) {
        const previous = lastStatus.current.get(job.id);
        if (previous !== undefined && previous !== job.status && !ACTIVE.has(job.status)) finished = true;
        lastStatus.current.set(job.id, job.status);
      }
      if (finished) scheduleListRefresh();
    },
    [scheduleListRefresh]
  );

  const applySnapshot = useCallback(
    (active: FolderJob[], recent: FolderJob[]) => {
      const all = [...active, ...recent];
      noteTransitions(all);
      setJobs(new Map(all.map((job) => [job.id, job])));
    },
    [noteTransitions]
  );

  const applyJob = useCallback(
    (job: FolderJob) => {
      noteTransitions([job]);
      setJobs((prev) => {
        const next = new Map(prev);
        next.set(job.id, job);
        return next;
      });
    },
    [noteTransitions]
  );

  const refresh = useCallback(async () => {
    try {
      const listing = await foldersApi.jobs();
      applySnapshot(listing.active, listing.recent);
    } catch {
      /* next poll or stream event catches up */
    }
  }, [applySnapshot]);

  useEffect(() => {
    if (!allowed) return;
    let source: EventSource | null = null;
    let closed = false;
    try {
      source = new EventSource('/api/folders/jobs/stream');
    } catch {
      source = null;
    }
    if (!source) {
      void refresh();
      return;
    }
    source.onopen = () => {
      if (!closed) setConnected(true);
    };
    source.onmessage = (event) => {
      let parsed: StreamEvent;
      try {
        parsed = JSON.parse(event.data) as StreamEvent;
      } catch {
        return;
      }
      if (parsed.type === 'snapshot') applySnapshot(parsed.active, parsed.recent);
      else if (parsed.type === 'job') applyJob(parsed.job);
    };
    source.onerror = () => {
      if (!closed) setConnected(false);
    };
    return () => {
      closed = true;
      source?.close();
      setConnected(false);
    };
  }, [allowed, applySnapshot, applyJob, refresh]);

  const active = useMemo(
    () => [...jobs.values()].filter((job) => ACTIVE.has(job.status)).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id),
    [jobs]
  );
  const recent = useMemo(
    () => [...jobs.values()].filter((job) => !ACTIVE.has(job.status)).sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? '') || b.id - a.id),
    [jobs]
  );
  const batches = useMemo(() => summariseBatches([...jobs.values()]), [jobs]);
  const activeFolderIds = useMemo(() => new Set(active.map((job) => job.folderId)), [active]);

  useEffect(() => {
    if (!allowed) return;
    if (connected && active.length === 0) return;
    const interval = setInterval(() => void refresh(), connected ? POLL_MS * 6 : POLL_MS);
    return () => clearInterval(interval);
  }, [allowed, connected, active.length, refresh]);

  const cancel = useCallback(async (id: number) => {
    applyJob(await foldersApi.cancelJob(id));
  }, [applyJob]);
  const retry = useCallback(async (id: number) => {
    applyJob(await foldersApi.retryJob(id));
  }, [applyJob]);
  const cancelBatch = useCallback(async (batchId: string) => {
    await foldersApi.cancelBatch(batchId);
    await refresh();
  }, [refresh]);
  const clearFinished = useCallback(async () => {
    await foldersApi.clearFinishedJobs();
    await refresh();
  }, [refresh]);

  return { jobs, active, recent, batches, activeFolderIds, connected, refresh, cancel, retry, cancelBatch, clearFinished };
}
