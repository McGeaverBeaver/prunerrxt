import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Activity, AlertTriangle, CheckCircle2, ExternalLink, FolderOpen, HeartPulse, Loader2, RefreshCw, ScrollText, Search, Trash2 } from 'lucide-react';

import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Badge } from '@/components/common/Badge';
import { Dropdown } from '@/components/common/dropdown';
import { diagnosticsApi } from '@/services/api';
import { cn, formatBytes, formatRelativeTime } from '@/lib/utils';
import type { ArrLogLevel, DiagnosticsService, ServiceConnection } from '@/types';

import { PanelSection } from '../../components/PanelSection';
import { SegmentedControl } from '../../components/SegmentedControl';
import { SettingsCard } from '../../components/SettingsCard';
import { SettingsEmptyState } from '../../components/SettingsEmptyState';

const LABEL: Record<DiagnosticsService, string> = { sonarr: 'Sonarr', radarr: 'Radarr' };

function configured(conn: ServiceConnection | undefined): boolean {
  return Boolean(conn?.url && (conn.apiKey || conn.token));
}

/**
 * What Sonarr and Radarr are doing right now, read through their own APIs:
 * version and health, how deletion is set up (recycle bin, root folders, the
 * cross-filesystem trap), the command queue, and a filtered log tail. The
 * MCP connector has had these for a while; this is the same data for people.
 */
export function DiagnosticsSection({
  registerSection,
  services,
}: {
  registerSection: (id: string, node: HTMLElement | null) => void;
  services: { sonarr?: ServiceConnection; radarr?: ServiceConnection } | undefined;
}) {
  const { t } = useTranslation('settings');
  const available = useMemo(() => (['sonarr', 'radarr'] as DiagnosticsService[]).filter((s) => configured(services?.[s])), [services]);
  const [chosen, setChosen] = useState<DiagnosticsService | null>(null);
  const service = chosen && available.includes(chosen) ? chosen : (available[0] ?? null);

  return (
    <PanelSection
      id="diagnostics"
      register={registerSection}
      title={t('diagnostics.title', 'Diagnostics')}
      description={t('diagnostics.description', "Health, deletion setup, activity and logs straight from Sonarr and Radarr, so a failed delete can be explained without leaving this page")}
    >
      {available.length === 0 ? (
        <SettingsCard className="p-4">
          <SettingsEmptyState
            title={t('diagnostics.emptyTitle', 'Connect Sonarr or Radarr first')}
            body={t('diagnostics.emptyBody', 'Diagnostics read each app through its API. Add a URL and API key above and this section fills in.')}
          />
        </SettingsCard>
      ) : (
        <div className="flex flex-col gap-3">
          {available.length > 1 && (
            <SegmentedControl
              value={service}
              options={available.map((s) => ({ value: s, label: LABEL[s] }))}
              onChange={setChosen}
              ariaLabel={t('diagnostics.pickService', 'Which app to inspect')}
            />
          )}
          {service && <ServiceDiagnostics key={service} service={service} />}
        </div>
      )}
    </PanelSection>
  );
}

function ServiceDiagnostics({ service }: { service: DiagnosticsService }) {
  const { t } = useTranslation('settings');
  const label = LABEL[service];
  const [level, setLevel] = useState<ArrLogLevel>('warn');
  const [search, setSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');

  const health = useQuery({ queryKey: ['diagnostics', service, 'health'], queryFn: () => diagnosticsApi.health(service), refetchOnWindowFocus: false });
  const setup = useQuery({ queryKey: ['diagnostics', service, 'deletion-setup'], queryFn: () => diagnosticsApi.deletionSetup(service), refetchOnWindowFocus: false });
  const activity = useQuery({ queryKey: ['diagnostics', service, 'activity'], queryFn: () => diagnosticsApi.activity(service), refetchOnWindowFocus: false, refetchInterval: 30_000 });
  const logs = useQuery({
    queryKey: ['diagnostics', service, 'logs', level, appliedSearch],
    queryFn: () => diagnosticsApi.logs(service, { level, limit: 60, search: appliedSearch || undefined }),
    refetchOnWindowFocus: false,
  });

  const refreshAll = () => {
    void health.refetch();
    void setup.refetch();
    void activity.refetch();
    void logs.refetch();
  };
  const refreshing = health.isFetching || setup.isFetching || activity.isFetching || logs.isFetching;

  const levelOptions: Array<{ value: ArrLogLevel; label: string }> = [
    { value: 'error', label: t('diagnostics.logs.levels.error', 'Errors only') },
    { value: 'warn', label: t('diagnostics.logs.levels.warn', 'Warnings and errors') },
    { value: 'info', label: t('diagnostics.logs.levels.info', 'Everything') },
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-end">
        <Button variant="outline" size="sm" onClick={refreshAll} disabled={refreshing}>
          <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin motion-reduce:animate-none')} aria-hidden />
          {t('diagnostics.refresh', 'Refresh')}
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        {/* Health */}
        <SettingsCard className="p-4">
          <CardHeading icon={HeartPulse} title={t('diagnostics.health.title', '{{app}} health', { app: label })} />
          {health.isLoading ? (
            <Loading />
          ) : health.isError ? (
            <Problem message={(health.error as Error).message} />
          ) : health.data ? (
            <div className="mt-3 flex flex-col gap-2 text-[12.5px]">
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-surface-300">
                <span>
                  {t('diagnostics.health.version', 'Version')} <span className="font-mono text-surface-100">{health.data.version ?? '—'}</span>
                </span>
                {health.data.startTime && (
                  <span>
                    {t('diagnostics.health.up', 'Up since')} <span className="text-surface-100">{formatRelativeTime(health.data.startTime)}</span>
                  </span>
                )}
              </div>
              {health.data.health.length === 0 ? (
                <p className="flex items-center gap-1.5 text-emerald-text">
                  <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> {t('diagnostics.health.ok', 'No health warnings')}
                </p>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {health.data.health.map((item, i) => (
                    <li key={`${item.source}-${i}`} className="rounded-lg border border-surface-700/70 bg-surface-800/50 px-3 py-2">
                      <div className="flex items-center gap-2">
                        <Badge variant={item.type.toLowerCase() === 'error' ? 'danger' : 'warning'} size="sm">
                          {item.type}
                        </Badge>
                        <span className="font-mono text-[11px] text-surface-400">{item.source}</span>
                        {item.wikiUrl && (
                          <a href={item.wikiUrl} target="_blank" rel="noopener noreferrer" className="ml-auto text-surface-400 hover:text-surface-100" title={t('diagnostics.health.wiki', 'Open the wiki page')}>
                            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                          </a>
                        )}
                      </div>
                      <p className="mt-1 text-surface-200">{item.message}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
        </SettingsCard>

        {/* Deletion setup */}
        <SettingsCard className="p-4">
          <CardHeading icon={Trash2} title={t('diagnostics.setup.title', 'How {{app}} deletes', { app: label })} />
          {setup.isLoading ? (
            <Loading />
          ) : setup.isError ? (
            <Problem message={(setup.error as Error).message} />
          ) : setup.data ? (
            <div className="mt-3 flex flex-col gap-2 text-[12.5px]">
              <p className="text-surface-300">
                {t('diagnostics.setup.recycleBin', 'Recycling bin')}{' '}
                {setup.data.recycleBin ? (
                  <>
                    <span className="font-mono text-surface-100">{setup.data.recycleBin}</span>
                    <span className="text-surface-500">
                      {' · '}
                      {setup.data.recycleBinCleanupDays
                        ? t('diagnostics.setup.cleanup', 'emptied after {{count}} days', { count: setup.data.recycleBinCleanupDays })
                        : t('diagnostics.setup.noCleanup', 'never emptied automatically')}
                    </span>
                  </>
                ) : (
                  <span className="text-surface-100">{t('diagnostics.setup.noBin', 'none, files are deleted outright')}</span>
                )}
              </p>
              <ul className="flex flex-col gap-1">
                {setup.data.rootFolders.map((folder) => (
                  <li key={folder.id} className="flex items-center gap-2 rounded-lg border border-surface-700/70 bg-surface-800/50 px-3 py-2">
                    <FolderOpen className="h-3.5 w-3.5 shrink-0 text-surface-400" aria-hidden />
                    <span className="min-w-0 flex-1 truncate font-mono text-surface-100">{folder.path}</span>
                    {folder.freeSpace !== undefined && <span className="shrink-0 text-surface-500">{formatBytes(folder.freeSpace)} {t('diagnostics.setup.free', 'free')}</span>}
                    {!folder.accessible ? (
                      <Badge variant="danger" size="sm">{t('diagnostics.setup.inaccessible', 'not accessible')}</Badge>
                    ) : folder.sameMountAsRecycleBin === false ? (
                      <Badge variant="warning" size="sm">{t('diagnostics.setup.crossMount', 'bin on another path')}</Badge>
                    ) : (
                      <Badge variant="success" size="sm">{t('diagnostics.setup.ok', 'ok')}</Badge>
                    )}
                  </li>
                ))}
              </ul>
              {setup.data.warnings.map((warning, i) => (
                <p key={i} className="flex items-start gap-1.5 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-surface-200">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-text" aria-hidden />
                  <span>{warning}</span>
                </p>
              ))}
            </div>
          ) : null}
        </SettingsCard>

        {/* Activity */}
        <SettingsCard className="p-4">
          <CardHeading icon={Activity} title={t('diagnostics.activity.title', 'What {{app}} is doing', { app: label })} />
          {activity.isLoading ? (
            <Loading />
          ) : activity.isError ? (
            <Problem message={(activity.error as Error).message} />
          ) : activity.data ? (
            <div className="mt-3 flex flex-col gap-2 text-[12.5px]">
              {activity.data.running.length === 0 && activity.data.queued.length === 0 ? (
                <p className="text-surface-400">{t('diagnostics.activity.idle', 'Idle: nothing running or queued')}</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {[...activity.data.running, ...activity.data.queued].map((cmd) => (
                    <li key={cmd.id} className="flex items-center gap-2 rounded-lg border border-surface-700/70 bg-surface-800/50 px-3 py-2">
                      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent-text motion-reduce:animate-none" aria-hidden />
                      <span className="min-w-0 flex-1 truncate text-surface-100">{cmd.commandName ?? cmd.name}</span>
                      <Badge variant={cmd.status === 'started' ? 'accent' : 'muted'} size="sm">{cmd.status}</Badge>
                      {cmd.started && <span className="text-surface-500">{formatRelativeTime(cmd.started)}</span>}
                    </li>
                  ))}
                </ul>
              )}
              {activity.data.recent.length > 0 && (
                <>
                  <p className="mt-1 text-[11px] font-medium uppercase tracking-wider text-surface-500">{t('diagnostics.activity.recent', 'Recently finished')}</p>
                  <ul className="flex flex-col gap-0.5">
                    {activity.data.recent.slice(0, 8).map((cmd) => (
                      <li key={cmd.id} className="flex items-center gap-2 px-1 text-surface-300">
                        <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', cmd.status === 'completed' ? 'bg-emerald-500' : cmd.status === 'failed' ? 'bg-ruby-500' : 'bg-surface-500')} aria-hidden />
                        <span className="min-w-0 flex-1 truncate">{cmd.commandName ?? cmd.name}</span>
                        {cmd.duration && <span className="font-mono text-[11px] text-surface-500">{cmd.duration.replace(/\.\d+$/, '')}</span>}
                        {cmd.ended && <span className="text-surface-500">{formatRelativeTime(cmd.ended)}</span>}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          ) : null}
        </SettingsCard>

        {/* Logs */}
        <SettingsCard className="p-4">
          <CardHeading icon={ScrollText} title={t('diagnostics.logs.title', '{{app}} log', { app: label })} />
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
            <Dropdown<ArrLogLevel> value={level} options={levelOptions} onChange={setLevel} ariaLabel={t('diagnostics.logs.level', 'Log level')} />
            <form
              className="relative flex-1"
              onSubmit={(e) => {
                e.preventDefault();
                setAppliedSearch(search.trim());
              }}
            >
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-surface-500" aria-hidden />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onBlur={() => setAppliedSearch(search.trim())}
                placeholder={t('diagnostics.logs.search', 'Filter by text, e.g. a title or "permission"')}
                className="pl-9 text-sm"
                aria-label={t('diagnostics.logs.search', 'Filter by text, e.g. a title or "permission"')}
              />
            </form>
          </div>
          {logs.isLoading ? (
            <Loading />
          ) : logs.isError ? (
            <Problem message={(logs.error as Error).message} />
          ) : logs.data ? (
            logs.data.records.length === 0 ? (
              <p className="mt-3 text-[12.5px] text-surface-400">{t('diagnostics.logs.empty', 'Nothing at this level matches')}</p>
            ) : (
              <ul className="mt-3 max-h-80 overflow-y-auto rounded-lg border border-surface-700/70 bg-surface-900/60 font-mono text-[11.5px]">
                {logs.data.records.map((record) => (
                  <li key={record.id} className="border-b border-surface-800 px-3 py-1.5 last:border-b-0">
                    <div className="flex items-center gap-2">
                      <span className="text-surface-500">{record.time.replace('T', ' ').slice(0, 19)}</span>
                      <span className={cn('uppercase', record.level.toLowerCase() === 'error' || record.level.toLowerCase() === 'fatal' ? 'text-ruby-text' : record.level.toLowerCase() === 'warn' ? 'text-accent-text' : 'text-surface-400')}>
                        {record.level}
                      </span>
                      <span className="truncate text-surface-500">{record.logger}</span>
                    </div>
                    <p className="whitespace-pre-wrap break-words text-surface-200">{record.message}</p>
                    {record.exception && <p className="mt-0.5 whitespace-pre-wrap break-words text-surface-500">{record.exception.split('\n').slice(0, 3).join('\n')}</p>}
                  </li>
                ))}
              </ul>
            )
          ) : null}
        </SettingsCard>
      </div>
    </div>
  );
}

function CardHeading({ icon: Icon, title }: { icon: typeof Activity; title: string }) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="h-4 w-4 text-surface-400" aria-hidden />
      <p className="font-display text-[13.5px] font-semibold text-surface-50">{title}</p>
    </div>
  );
}

function Loading() {
  const { t } = useTranslation('settings');
  return (
    <div className="mt-3 flex items-center gap-2 text-[12.5px] text-surface-400">
      <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
      {t('diagnostics.loading', 'Asking the app…')}
    </div>
  );
}

function Problem({ message }: { message: string }) {
  return (
    <p className="mt-3 flex items-start gap-1.5 text-[12.5px] text-ruby-text">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>{message}</span>
    </p>
  );
}
