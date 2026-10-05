import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity, AlertTriangle, CheckCircle2, Clock, Loader2, PauseCircle, Play, RefreshCw, Search, ShieldCheck, Trash2, FolderOpen, XCircle } from 'lucide-react';

import { Card } from '@/components/common/Card';
import { Button } from '@/components/common/Button';
import { Badge } from '@/components/common/Badge';
import { ErrorState } from '@/components/common/ErrorState';
import { useToast } from '@/components/common/Toast';
import { useRunTask, useTasksStatus } from '@/hooks/useApi';
import { useAvailabilityText } from '@/lib/availabilityText';
import { cn, formatDate, formatDuration, formatRelativeTime } from '@/lib/utils';
import type { ScheduledJob, TaskRun } from '@/types';

/** The sync progress log is loosely typed; pull the message out when it has one. */
function syncMessage(latest: unknown): string | null {
  if (latest && typeof latest === 'object' && 'message' in latest && typeof (latest as { message: unknown }).message === 'string') {
    return (latest as { message: string }).message;
  }
  return null;
}

/** Code names are stable identifiers; these are the words on the page. */
function useTaskNames() {
  const { t } = useTranslation('tasks');
  const names: Record<string, string> = {
    syncPlexLibrary: t('names.syncPlexLibrary', 'Library sync'),
    scanLibraries: t('names.scanLibraries', 'Rules scan'),
    processDeletionQueue: t('names.processDeletionQueue', 'Queue run'),
    sendDeletionReminders: t('names.sendDeletionReminders', 'Deletion reminders'),
    captureStorageSnapshot: t('names.captureStorageSnapshot', 'Storage snapshot'),
    captureUnraidCapacitySnapshot: t('names.captureUnraidCapacitySnapshot', 'Unraid capacity snapshot'),
    syncPlexUsers: t('names.syncPlexUsers', 'Users sync'),
    monitorDiskPressure: t('names.monitorDiskPressure', 'Disk pressure monitor'),
    captureInsightSnapshot: t('names.captureInsightSnapshot', 'Insights snapshot'),
    checkAvailability: t('names.checkAvailability', 'Archive availability check'),
    verifyAuditLog: t('names.verifyAuditLog', 'Audit log verification'),
    availabilityPass: t('names.availabilityPass', 'Archive availability pass'),
  };
  return (name: string) => names[name] ?? name;
}

/**
 * Everything Prunerr does in the background, in one place: what is running
 * right now (with progress), every scheduled job with its last and next run,
 * and the recent run history. Polls every five seconds while open.
 */
export default function Tasks() {
  const { t } = useTranslation('tasks');
  const { addToast } = useToast();
  const { data, isLoading, isError, error, refetch, isFetching } = useTasksStatus();
  const runTask = useRunTask();
  const [runningName, setRunningName] = useState<string | null>(null);
  const taskName = useTaskNames();
  const { pauseLine } = useAvailabilityText();

  const run = (job: ScheduledJob) => {
    setRunningName(job.name);
    runTask.mutate(job.name, {
      onSuccess: (result) => {
        addToast({ type: result.success ? 'success' : 'error', title: taskName(job.name), message: result.message || (result.success ? t('toasts.done', 'Finished') : t('toasts.failed', 'Failed')) });
      },
      onError: (err) => addToast({ type: 'error', title: taskName(job.name), message: err instanceof Error ? err.message : String(err) }),
      onSettled: () => setRunningName(null),
    });
  };

  if (isError) return <ErrorState error={error as Error} retry={() => void refetch()} />;

  const running = data?.running;
  const pass = running?.availabilityPass ?? null;
  const anythingRunning = Boolean(pass) || Boolean(running?.sync) || (running?.deletionJobs.length ?? 0) > 0 || (running?.folderJobs.length ?? 0) > 0 || (data?.jobs.some((j) => j.isRunning) ?? false);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center gap-4 sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-surface-50">{t('header.title', 'Tasks')}</h1>
          <p className="text-surface-400 mt-1 text-sm sm:text-base">{t('header.subtitle', 'What Prunerr is doing in the background, and what it did')}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isFetching}>
          <RefreshCw className={cn('w-3.5 h-3.5 mr-1.5', isFetching && 'animate-spin motion-reduce:animate-none')} />
          {t('actions.refresh', 'Refresh')}
        </Button>
      </div>

      {/* Running now */}
      <Card className="p-5">
        <div className="flex items-center gap-2 mb-4">
          <Activity className="w-4 h-4 text-surface-400" />
          <h2 className="text-sm font-semibold text-surface-300 uppercase tracking-wider">{t('running.title', 'Running now')}</h2>
          {data?.schedulerRunning === false && <Badge variant="danger" size="sm">{t('running.schedulerStopped', 'scheduler stopped')}</Badge>}
        </div>
        {isLoading ? (
          <p className="text-sm text-surface-400">{t('loading', 'Loading…')}</p>
        ) : !anythingRunning ? (
          <p className="flex items-center gap-2 text-sm text-surface-400">
            <CheckCircle2 className="w-4 h-4 text-emerald-text" />
            {t('running.idle', 'Idle. {{count}} queued titles still need an Archive verdict.', { count: running?.unchecked ?? 0 })}
          </p>
        ) : (
          <ul className="space-y-3">
            {pass && (
              <li className="rounded-xl border border-surface-700/60 bg-surface-800/40 p-4">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin text-accent-text motion-reduce:animate-none" />
                    <span className="text-sm font-medium text-surface-50">{t('running.availabilityPass', 'Archive: checking whether queued titles can be downloaded again')}</span>
                  </div>
                  <span className="text-xs text-surface-400">{t('running.startedAgo', 'started {{time}}', { time: formatRelativeTime(pass.startedAt) })}</span>
                </div>
                <div className="mt-3 h-1.5 w-full rounded-full bg-surface-700/60 overflow-hidden">
                  <div className="h-full bg-accent-500 transition-all" style={{ width: `${pass.total > 0 ? Math.round((pass.done / pass.total) * 100) : 0}%` }} />
                </div>
                <div className="mt-2 flex items-center justify-between gap-3 flex-wrap text-xs text-surface-400">
                  <span>
                    {pass.current
                      ? t('running.searching', 'Searching {{app}} for "{{title}}"', { app: pass.current.service === 'radarr' ? 'Radarr' : 'Sonarr', title: pass.current.title })
                      : t('running.between', 'Between titles')}
                  </span>
                  <span>
                    {t('running.passProgress', '{{done}} of {{total}} · {{replaceable}} replaceable · {{atRisk}} at risk · {{unknown}} unknown', {
                      done: pass.done,
                      total: pass.total,
                      replaceable: pass.replaceable,
                      atRisk: pass.atRisk,
                      unknown: pass.unknown,
                    })}
                  </span>
                </div>
              </li>
            )}
            {running?.sync && (
              <li className="flex items-center gap-2 rounded-xl border border-surface-700/60 bg-surface-800/40 p-4 text-sm text-surface-100">
                <Loader2 className="w-4 h-4 animate-spin text-accent-text motion-reduce:animate-none" />
                {t('running.sync', 'Library sync in progress')}
                {syncMessage(running.sync.latest) && <span className="text-xs text-surface-400">· {syncMessage(running.sync.latest)}</span>}
              </li>
            )}
            {data?.jobs.filter((j) => j.isRunning && j.name !== 'checkAvailability').map((job) => (
              <li key={job.name} className="flex items-center gap-2 rounded-xl border border-surface-700/60 bg-surface-800/40 p-4 text-sm text-surface-100">
                <Loader2 className="w-4 h-4 animate-spin text-accent-text motion-reduce:animate-none" />
                {taskName(job.name)}
                {job.lastRun && <span className="text-xs text-surface-400">· {t('running.startedAgo', 'started {{time}}', { time: formatRelativeTime(job.lastRun) })}</span>}
              </li>
            ))}
            {running?.deletionJobs.map((job) => (
              <li key={`del-${job.id}`} className="flex items-center gap-2 rounded-xl border border-surface-700/60 bg-surface-800/40 p-4 text-sm text-surface-100">
                <Trash2 className="w-4 h-4 text-ruby-text" />
                {t('running.deleting', 'Deleting "{{title}}"', { title: job.title })}
                <Badge variant="muted" size="sm">{job.status}</Badge>
              </li>
            ))}
            {running?.folderJobs.map((job) => (
              <li key={`folder-${job.id}`} className="flex items-center gap-2 rounded-xl border border-surface-700/60 bg-surface-800/40 p-4 text-sm text-surface-100">
                <FolderOpen className="w-4 h-4 text-surface-300" />
                {t('running.folderJob', '{{action}} "{{name}}"', { action: job.action, name: job.name })}
                <Badge variant="muted" size="sm">{job.status}</Badge>
              </li>
            ))}
          </ul>
        )}
        {running && running.archivePaused.length > 0 && (
          <ul className="mt-3 space-y-1 text-xs text-surface-400">
            {running.archivePaused.map((p) => (
              <li key={p.service} className="flex items-center gap-2">
                <PauseCircle className="w-3.5 h-3.5 text-surface-500" />
                {pauseLine(p)} · {t('running.retry', 'retrying {{time}}', { time: formatRelativeTime(p.until) })}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Scheduled */}
      <Card className="overflow-hidden">
        <div className="flex items-center gap-2 px-5 pt-5 pb-3">
          <Clock className="w-4 h-4 text-surface-400" />
          <h2 className="text-sm font-semibold text-surface-300 uppercase tracking-wider">{t('scheduled.title', 'Scheduled')}</h2>
          {data?.timezone && <span className="text-xs text-surface-500">{t('scheduled.tz', 'times in {{tz}}', { tz: data.timezone })}</span>}
        </div>
        <ul className="divide-y divide-surface-800">
          {(data?.jobs ?? []).map((job) => (
            <li key={job.name} className="flex items-start gap-3 px-5 py-3 hover:bg-surface-800/30 transition-colors">
              <div className="mt-0.5">
                {job.isRunning ? (
                  <Loader2 className="w-4 h-4 animate-spin text-accent-text motion-reduce:animate-none" />
                ) : !job.enabled ? (
                  <PauseCircle className="w-4 h-4 text-surface-600" />
                ) : job.lastResult?.success === false ? (
                  <XCircle className="w-4 h-4 text-ruby-text" />
                ) : (
                  <CheckCircle2 className="w-4 h-4 text-emerald-text" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-surface-50">{taskName(job.name)}</span>
                  <code className="text-[11px] text-surface-500 font-mono">{job.schedule}</code>
                  {!job.enabled && <Badge variant="muted" size="sm">{t('scheduled.disabled', 'off')}</Badge>}
                </div>
                {job.description && <p className="text-xs text-surface-500 mt-0.5">{job.description}</p>}
                <p className="text-xs text-surface-400 mt-1">
                  {job.lastRun
                    ? t('scheduled.lastRun', 'Last run {{time}}', { time: formatRelativeTime(job.lastRun) })
                    : t('scheduled.neverRan', 'Never run')}
                  {job.lastResult && (
                    <>
                      {' · '}
                      <span className={job.lastResult.success ? 'text-surface-300' : 'text-ruby-text'}>
                        {job.lastResult.success ? job.lastResult.message || t('scheduled.ok', 'ok') : job.lastResult.error || job.lastResult.message || t('scheduled.failed', 'failed')}
                      </span>
                      {job.lastResult.durationMs > 0 && <span className="text-surface-500"> ({formatDuration(job.lastResult.durationMs)})</span>}
                    </>
                  )}
                  {job.enabled && job.nextRun && (
                    <>
                      {' · '}
                      {t('scheduled.nextRun', 'next {{time}}', { time: formatRelativeTime(job.nextRun) })}
                    </>
                  )}
                </p>
              </div>
              {job.runnable && (
                <Button variant="ghost" size="sm" onClick={() => run(job)} disabled={job.isRunning || runningName === job.name} title={t('scheduled.runNow', 'Run now')}>
                  {runningName === job.name ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                </Button>
              )}
            </li>
          ))}
        </ul>
      </Card>

      {/* Recent runs */}
      <Card className="overflow-hidden">
        <div className="flex items-center gap-2 px-5 pt-5 pb-3">
          <Search className="w-4 h-4 text-surface-400" />
          <h2 className="text-sm font-semibold text-surface-300 uppercase tracking-wider">{t('recent.title', 'Recent runs')}</h2>
        </div>
        {(data?.recent.length ?? 0) === 0 ? (
          <p className="px-5 pb-5 text-sm text-surface-400">{t('recent.empty', 'No runs recorded yet. Every scheduled, manual and start-up run lands here from now on.')}</p>
        ) : (
          <ul className="divide-y divide-surface-800">
            {data!.recent.map((run) => (
              <RunRow key={run.id} run={run} name={taskName(run.name)} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function RunRow({ run, name }: { run: TaskRun; name: string }) {
  const { t } = useTranslation('tasks');
  const triggerLabel: Record<TaskRun['trigger'], string> = {
    schedule: t('recent.trigger.schedule', 'scheduled'),
    manual: t('recent.trigger.manual', 'manual'),
    startup: t('recent.trigger.startup', 'start-up'),
    queue: t('recent.trigger.queue', 'after queueing'),
    mcp: t('recent.trigger.mcp', 'MCP'),
  };
  return (
    <li className="flex items-start gap-3 px-5 py-2.5 text-sm">
      <div className="mt-0.5">
        {run.success === null ? (
          <Loader2 className="w-4 h-4 animate-spin text-accent-text motion-reduce:animate-none" />
        ) : run.success ? (
          <CheckCircle2 className="w-4 h-4 text-emerald-text" />
        ) : run.error === 'Interrupted by a restart' ? (
          <AlertTriangle className="w-4 h-4 text-accent-text" />
        ) : (
          <XCircle className="w-4 h-4 text-ruby-text" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-surface-100">{name}</span>
          <Badge variant="muted" size="sm">{triggerLabel[run.trigger] ?? run.trigger}</Badge>
          <span className="text-xs text-surface-500" title={formatDate(run.startedAt, 'MMM d, yyyy HH:mm:ss')}>{formatRelativeTime(run.startedAt)}</span>
          {run.durationMs !== null && <span className="text-xs text-surface-500">· {formatDuration(run.durationMs)}</span>}
        </div>
        {(run.message || run.error) && <p className={cn('text-xs mt-0.5 break-words', run.success === false ? 'text-ruby-text' : 'text-surface-400')}>{run.error || run.message}</p>}
      </div>
      {run.name === 'verifyAuditLog' && run.success && <ShieldCheck className="w-4 h-4 text-emerald-text mt-0.5" />}
    </li>
  );
}
