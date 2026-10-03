import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { deletionJobsApi } from '@/services/api';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/components/common/Toast';
import { formatBytes } from '@/lib/utils';
import type { DeletionJob } from '@/types';

/**
 * Background deletions, live, from anywhere in the app.
 *
 * Delete Now and Delete All queue jobs on the server and return at once; this
 * context follows them over the server's event stream (falling back to
 * polling while the stream is down) so the sidebar indicator, the Queue rows
 * and the jobs panel all show the same state, on every page, across reloads.
 */
interface DeletionJobsValue {
  /** Pending, running and verifying jobs, oldest first. */
  active: DeletionJob[];
  /** Finished jobs the server still remembers, newest first. */
  recent: DeletionJob[];
  /** The live job for a queue entry, else its most recent finished one. */
  byQueueId: (queueId: string) => DeletionJob | undefined;
  /** Ticks once a second while anything is active, for elapsed-time displays. */
  now: number;
  /** Whether the event stream is connected (false means polling). */
  connected: boolean;
  cancel: (id: number) => Promise<void>;
  retry: (id: number) => Promise<void>;
  clearFinished: () => Promise<void>;
  refresh: () => Promise<void>;
}

const DeletionJobsContext = createContext<DeletionJobsValue | undefined>(undefined);

const ACTIVE = new Set(['pending', 'running', 'verifying']);
const POLL_MS = 5_000;

type StreamEvent = { type: 'snapshot'; active: DeletionJob[]; recent: DeletionJob[] } | { type: 'job'; job: DeletionJob };

export function DeletionJobsProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  const { t } = useTranslation('queue');
  const [jobs, setJobs] = useState<Map<number, DeletionJob>>(new Map());
  const [connected, setConnected] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // Status per job id as last seen, to toast only on real transitions.
  const lastStatus = useRef<Map<number, string>>(new Map());
  const primed = useRef(false);

  // The stream needs a session when login is on; wait for auth to settle.
  const allowed = auth.status === 'ready' && (!auth.enabled || auth.user !== null);

  const applySnapshot = useCallback((active: DeletionJob[], recent: DeletionJob[]) => {
    setJobs(new Map([...active, ...recent].map((job) => [job.id, job])));
  }, []);

  const applyJob = useCallback((job: DeletionJob) => {
    setJobs((prev) => {
      const next = new Map(prev);
      next.set(job.id, job);
      return next;
    });
  }, []);

  const refresh = useCallback(async () => {
    try {
      const listing = await deletionJobsApi.list();
      applySnapshot(listing.active, listing.recent);
    } catch {
      /* the next poll or stream event will catch up */
    }
  }, [applySnapshot]);

  // Event stream with automatic reconnects; EventSource sends the session
  // cookie, so it works the same with login on or off.
  useEffect(() => {
    if (!allowed) return;
    let source: EventSource | null = null;
    let closed = false;
    try {
      source = new EventSource('/api/deletion-jobs/stream');
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
    () =>
      [...jobs.values()]
        .filter((job) => ACTIVE.has(job.status))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id),
    [jobs]
  );
  const recent = useMemo(
    () =>
      [...jobs.values()]
        .filter((job) => !ACTIVE.has(job.status))
        .sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? '') || b.id - a.id),
    [jobs]
  );

  // Polling: the safety net while the stream is down, and a slow heartbeat
  // while jobs run even when it is up (a missed event would otherwise leave a
  // row stuck in the UI).
  useEffect(() => {
    if (!allowed) return;
    if (connected && active.length === 0) return;
    const interval = setInterval(() => void refresh(), connected ? POLL_MS * 6 : POLL_MS);
    return () => clearInterval(interval);
  }, [allowed, connected, active.length, refresh]);

  // One-second clock for elapsed times, only while something is running.
  useEffect(() => {
    if (active.length === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active.length]);

  // Transitions to a final state: a toast, and the lists that changed refetch.
  useEffect(() => {
    const seen = lastStatus.current;
    const finished: DeletionJob[] = [];
    for (const job of jobs.values()) {
      const previous = seen.get(job.id);
      seen.set(job.id, job.status);
      if (!primed.current) continue; // the first snapshot is history, not news
      if (previous === job.status) continue;
      if (previous === undefined && !ACTIVE.has(job.status)) continue; // learned about it already finished
      if (!ACTIVE.has(job.status)) finished.push(job);
    }
    primed.current = true;
    if (finished.length === 0) return;

    for (const job of finished) {
      if (job.status === 'done') {
        addToast({
          type: 'success',
          title: t('jobs.toast.doneTitle', 'Deleted'),
          message: t('jobs.toast.doneMsg', '"{{title}}" deleted ({{size}} freed)', { title: job.title, size: formatBytes(job.fileSizeFreed ?? 0) }),
        });
      } else if (job.status === 'reconciled') {
        addToast({
          type: 'success',
          title: t('jobs.toast.reconciledTitle', 'Already deleted'),
          message: t('jobs.toast.reconciledMsg', '"{{title}}" was already gone in {{service}}; removed from the queue', { title: job.title, service: job.service ?? 'Sonarr/Radarr' }),
        });
      } else if (job.status === 'failed') {
        addToast({
          type: 'error',
          title: t('jobs.toast.failedTitle', 'Deletion failed'),
          message: `"${job.title}": ${job.error ?? t('jobs.toast.failedMsg', 'See the deletion jobs panel for details')}`,
        });
      }
    }
    for (const key of [['queue'], ['library'], ['history'], ['stats'], ['activity']]) {
      queryClient.invalidateQueries({ queryKey: key });
    }
  }, [jobs, addToast, queryClient, t]);

  const byQueueId = useCallback(
    (queueId: string) => active.find((job) => job.queueId === queueId) ?? recent.find((job) => job.queueId === queueId),
    [active, recent]
  );

  const cancel = useCallback(
    async (id: number) => {
      const job = await deletionJobsApi.cancel(id);
      applyJob(job);
    },
    [applyJob]
  );
  const retry = useCallback(
    async (id: number) => {
      const job = await deletionJobsApi.retry(id);
      applyJob(job);
    },
    [applyJob]
  );
  const clearFinished = useCallback(async () => {
    await deletionJobsApi.clearFinished();
    setJobs((prev) => new Map([...prev].filter(([, job]) => ACTIVE.has(job.status))));
  }, []);

  const value = useMemo<DeletionJobsValue>(
    () => ({ active, recent, byQueueId, now, connected, cancel, retry, clearFinished, refresh }),
    [active, recent, byQueueId, now, connected, cancel, retry, clearFinished, refresh]
  );

  return <DeletionJobsContext.Provider value={value}>{children}</DeletionJobsContext.Provider>;
}

export function useDeletionJobs(): DeletionJobsValue {
  const ctx = useContext(DeletionJobsContext);
  if (!ctx) throw new Error('useDeletionJobs must be used within DeletionJobsProvider');
  return ctx;
}
