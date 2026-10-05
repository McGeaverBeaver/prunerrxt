import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { Bot, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Clock, Download, KeyRound, Search, ShieldAlert, ShieldCheck, User, Cpu, Scale } from 'lucide-react';

import { Card } from '@/components/common/Card';
import { Button } from '@/components/common/Button';
import { Badge } from '@/components/common/Badge';
import { Input } from '@/components/common/Input';
import { Dropdown } from '@/components/common/dropdown';
import { ErrorState } from '@/components/common/ErrorState';
import { EmptyState } from '@/components/common/EmptyState';
import { useAuth } from '@/contexts/AuthContext';
import { useAuditLog, useVerifyAudit } from '@/hooks/useApi';
import { auditApi } from '@/services/api';
import { libraryItemPath } from '@/lib/links';
import { cn, formatDate, formatRelativeTime } from '@/lib/utils';
import type { AuditEntry, AuditVerification } from '@/types';

const PAGE_SIZE = 50;
type ActionGroup = 'all' | 'auth.' | 'settings.' | 'rule.' | 'item.' | 'queue.' | 'collection.' | 'folder.' | 'mcp.' | 'apiKey.' | 'task.' | 'audit.' | 'system.';

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const handle = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(handle);
  }, [value, delay]);
  return debounced;
}

/**
 * The audit log: who did what, when and from where, in a chain nobody can
 * quietly edit. Read-only here by design; Verify recomputes every hash.
 */
export default function Audit() {
  const { t } = useTranslation('audit');
  const auth = useAuth();
  const [params] = useSearchParams();
  const initialKind = params.get('kind');
  const [group, setGroup] = useState<ActionGroup>(initialKind && /^[a-zA-Z]+\.$/.test(initialKind) ? (initialKind as ActionGroup) : 'all');
  const [actor, setActor] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const debouncedActor = useDebounced(actor, 300);
  const debouncedSearch = useDebounced(search, 300);
  const filters = useMemo(
    () => ({ limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE, action: group === 'all' ? undefined : group, actor: debouncedActor || undefined, search: debouncedSearch || undefined }),
    [group, debouncedActor, debouncedSearch, page]
  );
  const { data, isLoading, isError, error, refetch } = useAuditLog(filters);
  const verify = useVerifyAudit();
  const [verification, setVerification] = useState<AuditVerification | null>(null);

  const groups: Array<{ value: ActionGroup; label: string }> = [
    { value: 'all', label: t('filters.all', 'Everything') },
    { value: 'auth.', label: t('filters.auth', 'Logins') },
    { value: 'item.', label: t('filters.items', 'Titles: delete, protect, archive') },
    { value: 'queue.', label: t('filters.queue', 'Queue') },
    { value: 'rule.', label: t('filters.rules', 'Rules') },
    { value: 'settings.', label: t('filters.settings', 'Settings') },
    { value: 'collection.', label: t('filters.collections', 'Collections') },
    { value: 'folder.', label: t('filters.folders', 'Folders') },
    { value: 'mcp.', label: t('filters.mcp', 'MCP tool calls') },
    { value: 'apiKey.', label: t('filters.apiKey', 'API key') },
    { value: 'task.', label: t('filters.tasks', 'Manual task runs') },
    { value: 'audit.', label: t('filters.audit', 'Audit log itself') },
    { value: 'system.', label: t('filters.system', 'System') },
  ];

  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center gap-4 sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-surface-50">{t('header.title', 'Audit log')}</h1>
          <p className="text-surface-400 mt-1 text-sm sm:text-base">{t('header.subtitle', 'Who changed what, when and from where. Append-only and hash-chained; nothing here can be edited or removed.')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => verify.mutate(undefined, { onSuccess: setVerification })} disabled={verify.isPending}>
            <ShieldCheck className="w-3.5 h-3.5 mr-1.5" />
            {verify.isPending ? t('actions.verifying', 'Verifying…') : t('actions.verify', 'Verify chain')}
          </Button>
          {auth.isAdmin && (
            <a href={auditApi.exportUrl} className="btn-ghost inline-flex items-center gap-1.5 px-3 py-2 text-sm" download>
              <Download className="w-3.5 h-3.5" />
              {t('actions.export', 'Export')}
            </a>
          )}
        </div>
      </div>

      {verification && (
        <div className={cn('flex items-start gap-3 p-4 rounded-xl border', verification.ok ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-ruby-500/10 border-ruby-500/30')}>
          {verification.ok ? <ShieldCheck className="w-5 h-5 text-emerald-text shrink-0 mt-0.5" /> : <ShieldAlert className="w-5 h-5 text-ruby-text shrink-0 mt-0.5" />}
          <div className="text-sm">
            <p className="font-medium text-surface-50">
              {verification.ok
                ? t('verify.ok', 'Chain intact: {{count}} entries verified', { count: verification.entries })
                : verification.firstBreak
                  ? t('verify.broken', 'Chain BROKEN at entry #{{id}} ({{reason}}) recorded {{at}}', { id: verification.firstBreak.id, reason: verification.firstBreak.reason === 'hash_mismatch' ? t('verify.hashMismatch', 'hash does not match') : t('verify.chainGap', 'link to the previous entry is missing'), at: formatDate(verification.firstBreak.at, 'MMM d, yyyy HH:mm') })
                  : t('verify.anchorMismatch', 'The anchor file beside the database does not match the chain')}
            </p>
            <p className="text-xs text-surface-400 mt-0.5">
              {verification.anchorMatches === null
                ? t('verify.noAnchor', 'No anchor file yet; it is written on the next entry.')
                : verification.anchorMatches
                  ? t('verify.anchorOk', 'Anchor #{{id}} matches.', { id: verification.anchor?.id })
                  : t('verify.anchorBad', 'Anchor #{{id}} does not match: the table may have been replaced.', { id: verification.anchor?.id })}
              {' · '}
              {t('verify.checkedAt', 'checked {{time}}', { time: formatRelativeTime(verification.checkedAt) })}
            </p>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <Dropdown<ActionGroup> size="input" ariaLabel={t('filters.kind', 'Kind')} value={group} options={groups} onChange={(next) => { setGroup(next); setPage(1); }} />
        <div className="relative flex-1 max-w-xs">
          <User className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-surface-500" />
          <Input value={actor} onChange={(e) => { setActor(e.target.value); setPage(1); }} placeholder={t('filters.actor', 'Who (name or id)')} className="pl-9" aria-label={t('filters.actor', 'Who (name or id)')} />
        </div>
        <div className="relative flex-1 max-w-md">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-surface-500" />
          <Input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder={t('filters.search', 'Title, action or detail…')} className="pl-9" aria-label={t('filters.search', 'Title, action or detail…')} />
        </div>
      </div>

      {isError ? (
        <ErrorState error={error as Error} retry={() => void refetch()} />
      ) : isLoading ? (
        <Card className="p-8 text-center text-sm text-surface-400">{t('loading', 'Loading…')}</Card>
      ) : (data?.entries.length ?? 0) === 0 ? (
        <EmptyState icon={Scale} title={t('empty.title', 'Nothing recorded yet')} description={t('empty.desc', 'Logins, settings changes, rule changes and every delete, protect and archive decision land here as they happen.')} />
      ) : (
        <>
          <Card className="overflow-hidden">
            <ul className="divide-y divide-surface-800">
              {data!.entries.map((entry) => (
                <AuditRow key={entry.id} entry={entry} />
              ))}
            </ul>
          </Card>
          {total > PAGE_SIZE && (
            <div className="flex items-center justify-between">
              <p className="text-sm text-surface-400">{t('pagination', 'Showing {{from}}–{{to}} of {{total}}', { from: (page - 1) * PAGE_SIZE + 1, to: Math.min(page * PAGE_SIZE, total), total })}</p>
              <div className="flex items-center gap-1">
                <button type="button" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} className="btn-ghost p-2" aria-label={t('prev', 'Previous page')}>
                  <ChevronLeft className="w-5 h-5" />
                </button>
                <span className="px-2 text-sm text-surface-300">{page} / {totalPages}</span>
                <button type="button" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages} className="btn-ghost p-2" aria-label={t('next', 'Next page')}>
                  <ChevronRight className="w-5 h-5" />
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ActorIcon({ type }: { type: AuditEntry['actorType'] }) {
  const cls = 'w-4 h-4';
  switch (type) {
    case 'apiKey':
      return <KeyRound className={cn(cls, 'text-accent-text')} />;
    case 'mcp':
      return <Bot className={cn(cls, 'text-violet-text')} />;
    case 'scheduler':
    case 'rule':
      return <Clock className={cn(cls, 'text-surface-400')} />;
    case 'system':
      return <Cpu className={cn(cls, 'text-surface-400')} />;
    default:
      return <User className={cn(cls, 'text-emerald-text')} />;
  }
}

function useActionLabel() {
  const { t } = useTranslation('audit');
  const labels: Record<string, string> = {
    'auth.login': t('actions.auth.login', 'signed in'),
    'auth.logout': t('actions.auth.logout', 'signed out'),
    'auth.login_failed': t('actions.auth.loginFailed', 'failed to sign in'),
    'auth.login_refused': t('actions.auth.loginRefused', 'was refused (no mapped role)'),
    'auth.session_revoked': t('actions.auth.sessionRevoked', 'signed out a session of'),
    'settings.changed': t('actions.settings.changed', 'changed settings'),
    'apiKey.regenerated': t('actions.apiKey.regenerated', 'regenerated the API key'),
    'apiKey.enabled': t('actions.apiKey.enabled', 'enabled the API key'),
    'apiKey.disabled': t('actions.apiKey.disabled', 'disabled the API key'),
    'rule.created': t('actions.rule.created', 'created rule'),
    'rule.updated': t('actions.rule.updated', 'updated rule'),
    'rule.deleted': t('actions.rule.deleted', 'deleted rule'),
    'rule.enabled': t('actions.rule.enabled', 'enabled rule'),
    'rule.disabled': t('actions.rule.disabled', 'disabled rule'),
    'queue.added': t('actions.queue.added', 'queued for deletion'),
    'queue.removed': t('actions.queue.removed', 'removed from the queue'),
    'item.deleted': t('actions.item.deleted', 'deleted'),
    'item.protected': t('actions.item.protected', 'protected'),
    'item.unprotected': t('actions.item.unprotected', 'removed protection from'),
    'item.archived': t('actions.item.archived', 'archived'),
    'item.unarchived': t('actions.item.unarchived', 'unarchived'),
    'item.delete_anyway': t('actions.item.deleteAnyway', 'chose Delete anyway for'),
    'collection.protected': t('actions.collection.protected', 'protected collection'),
    'collection.unprotected': t('actions.collection.unprotected', 'removed protection from collection'),
    'folder.deleted': t('actions.folder.deleted', 'deleted folder'),
    'mcp.connection_revoked': t('actions.mcp.connectionRevoked', 'disconnected the assistant client'),
    'mcp.client_forgotten': t('actions.mcp.clientForgotten', 'forgot the assistant client'),
    'task.run': t('actions.task.run', 'ran task'),
    'audit.verified': t('actions.audit.verified', 'verified the audit chain'),
    'audit.exported': t('actions.audit.exported', 'exported the audit log'),
    'system.started': t('actions.system.started', 'started'),
  };
  return (action: string) => labels[action] ?? (action.startsWith('mcp.') ? t('actions.mcp.call', 'called MCP tool {{tool}}', { tool: action.slice(4) }) : action);
}

function AuditRow({ entry }: { entry: AuditEntry }) {
  const { t } = useTranslation('audit');
  const actionLabel = useActionLabel();
  const [open, setOpen] = useState(false);
  const targetHref = entry.targetType === 'media_item' && entry.targetId ? libraryItemPath(entry.targetId) : entry.targetType === 'collection' && entry.targetId ? `/collections/${entry.targetId}` : entry.targetType === 'rule' ? '/rules' : null;
  const hasDetails = entry.details && Object.keys(entry.details).length > 0;

  return (
    <li className="px-4 py-3 hover:bg-surface-800/30 transition-colors">
      <div className="flex items-start gap-3">
        <div className="mt-0.5"><ActorIcon type={entry.actorType} /></div>
        <div className="min-w-0 flex-1">
          <p className="text-sm text-surface-100 wrap-break-word">
            <span className="font-medium text-surface-50">{entry.actorName}</span>
            {entry.actorRole && <span className="text-xs text-surface-500"> ({entry.actorRole})</span>}{' '}
            <span className="text-surface-300">{actionLabel(entry.action)}</span>
            {entry.targetTitle && (
              <>
                {' '}
                {targetHref ? (
                  <Link to={targetHref} className="text-accent-text hover:text-accent-text-hover transition-colors">{entry.targetTitle}</Link>
                ) : (
                  <span className="text-surface-100">{entry.targetTitle}</span>
                )}
              </>
            )}
          </p>
          <p className="text-xs text-surface-500 mt-0.5 flex items-center gap-2 flex-wrap">
            <span title={formatDate(entry.at, 'MMM d, yyyy HH:mm:ss')}>{formatRelativeTime(entry.at)}</span>
            <Badge variant="muted" size="sm">{entry.source}</Badge>
            {entry.ip && <span className="font-mono">{entry.ip}</span>}
            <span className="font-mono">#{entry.id}</span>
            {hasDetails && (
              <button type="button" onClick={() => setOpen((v) => !v)} className="inline-flex items-center gap-1 text-surface-400 hover:text-surface-200">
                {open ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                {t('row.details', 'details')}
              </button>
            )}
          </p>
          {open && hasDetails && (
            <pre className="mt-2 max-h-72 overflow-auto rounded-lg border border-surface-700/60 bg-surface-900/60 p-3 font-mono text-[11px] text-surface-300 whitespace-pre-wrap wrap-break-word">
              {JSON.stringify(entry.details, null, 2)}
            </pre>
          )}
        </div>
      </div>
    </li>
  );
}
