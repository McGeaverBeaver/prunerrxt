import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Film, Tv, FolderX, RefreshCw, Download, Trash2, EyeOff, Eye, AlertTriangle, Search, Loader2, HardDrive, Wrench, Lock, X, CheckSquare } from 'lucide-react';
import { Card } from '@/components/common/Card';
import { Badge } from '@/components/common/Badge';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { ConfirmModal, Modal } from '@/components/common/Modal';
import { EmptyState } from '@/components/common/EmptyState';
import { ErrorState } from '@/components/common/ErrorState';
import { useToast } from '@/components/common/Toast';
import { useAuth } from '@/contexts/AuthContext';
import {
  useBulkIgnoreFolders,
  useDeleteFolder,
  useFixFolderPermissions,
  useFolderCandidates,
  useFolderPermissions,
  useIgnoreFolder,
  useImportFolder,
  useOrphanFolders,
  useQualityProfiles,
  useQueueFolderJobs,
} from '@/hooks/useApi';
import { useFolderJobs } from '@/hooks/useFolderJobs';
import { formatBytes, formatRelativeTime, cn } from '@/lib/utils';
import type { OrphanFolder } from '@/types';
import { BulkImportModal } from './BulkImportModal';
import { FolderJobsPanel } from './FolderJobsPanel';

type ServiceFilter = 'all' | 'radarr' | 'sonarr';
type ProblemFilter = 'all' | 'permissions' | 'unmapped';

/**
 * Folders under Sonarr's and Radarr's root folders that no series or movie
 * owns. Each can be imported into the app that owns its root folder, deleted
 * (when a folder mapping lets PrunerrXT reach it), or ignored.
 */
export default function Folders() {
  const { t } = useTranslation('folders');
  const auth = useAuth();
  const canAct = auth.can('operator');
  const [showIgnored, setShowIgnored] = useState(false);
  const [filter, setFilter] = useState<ServiceFilter>('all');
  const [search, setSearch] = useState('');
  const [problems, setProblems] = useState<ProblemFilter>('all');
  const [importing, setImporting] = useState<OrphanFolder | null>(null);
  const [deleting, setDeleting] = useState<OrphanFolder | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkImporting, setBulkImporting] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const { addToast } = useToast();

  const { data, isLoading, isError, error, refetch, isFetching } = useOrphanFolders(showIgnored);
  const deleteMutation = useDeleteFolder();
  const ignoreMutation = useIgnoreFolder();
  const fixMutation = useFixFolderPermissions();
  const bulkIgnore = useBulkIgnoreFolders();
  const queueJobs = useQueueFolderJobs();
  const permissions = useFolderPermissions();
  const jobs = useFolderJobs();

  const folders = useMemo(() => {
    const list = data?.folders ?? [];
    const q = search.trim().toLowerCase();
    return list.filter(
      (f) =>
        (filter === 'all' || f.service === filter) &&
        (problems === 'all' ||
          (problems === 'permissions' && f.localPath !== null && ((f.permissionIssues ?? 0) > 0 || f.writable === false)) ||
          (problems === 'unmapped' && f.localPath === null)) &&
        (!q || f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q))
    );
  }, [data, filter, problems, search]);

  // Only folders still in the list count as selected: ids of folders that a
  // job has since deleted or imported fall away on their own.
  const selectedFolders = useMemo(() => (data?.folders ?? []).filter((f) => selected.has(f.id)), [data, selected]);
  const selectedSize = selectedFolders.reduce((sum, f) => sum + (f.sizeBytes ?? 0), 0);
  const selectedDeletable = selectedFolders.filter((f) => f.canDelete && !jobs.activeFolderIds.has(f.id));
  const selectedFixable = selectedFolders.filter((f) => f.localPath !== null && !jobs.activeFolderIds.has(f.id));
  const selectedImportable = selectedFolders.filter((f) => !jobs.activeFolderIds.has(f.id));
  const allShownSelected = folders.length > 0 && folders.every((f) => selected.has(f.id));

  const toggleSelected = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAllShown = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (allShownSelected) folders.forEach((f) => next.delete(f.id));
      else folders.forEach((f) => next.add(f.id));
      return next;
    });

  const queueBulk = (action: 'delete' | 'fix_permissions', ids: string[]) => {
    queueJobs.mutate(
      { action, folders: ids.map((id) => ({ id })) },
      {
        onSuccess: (result) => {
          addToast({
            type: 'success',
            title: action === 'delete' ? t('bulk.deleteQueuedTitle', 'Deletions queued') : t('bulk.fixQueuedTitle', 'Permission fixes queued'),
            message: result.message ?? t('bulk.queuedMsg', '{{count}} folders queued', { count: result.queued.length }),
          });
          setSelected(new Set());
          setBulkDeleting(false);
          void jobs.refresh();
        },
        onError: (err) => addToast({ type: 'error', title: t('bulk.queueFailed', 'Could not queue'), message: err instanceof Error ? err.message : String(err) }),
      }
    );
  };

  const bulkSetIgnored = (ignored: boolean) => {
    bulkIgnore.mutate(
      { ids: selectedFolders.map((f) => f.id), ignored },
      {
        onSuccess: (result) => {
          addToast({ type: 'success', title: ignored ? t('bulk.ignoredTitle', 'Folders ignored') : t('bulk.unignoredTitle', 'Folders shown again'), message: result.message });
          setSelected(new Set());
        },
        onError: (err) => addToast({ type: 'error', title: t('toasts.updateFailed', 'Could not update folder'), message: err instanceof Error ? err.message : String(err) }),
      }
    );
  };

  const hasMappings = (data?.mappings.length ?? 0) > 0;
  const serviceErrors = data?.services.filter((s) => s.error) ?? [];
  const nothingConfigured = data ? data.services.every((s) => !s.configured) : false;

  const confirmDelete = () => {
    if (!deleting) return;
    deleteMutation.mutate(deleting.id, {
      onSuccess: (result) => {
        addToast({
          type: 'success',
          title: t('toasts.deletedTitle', 'Folder deleted'),
          message: t('toasts.deletedMsg', '"{{name}}" removed, {{size}} freed', { name: result.folder.name, size: formatBytes(result.sizeBytes) }),
        });
        setDeleting(null);
      },
      onError: (err) => {
        addToast({ type: 'error', title: t('toasts.deleteFailed', 'Could not delete folder'), message: err instanceof Error ? err.message : String(err) });
      },
    });
  };

  const fixPermissions = (folder: OrphanFolder) => {
    fixMutation.mutate(folder.id, {
      onSuccess: (result) => {
        addToast({
          type: result.result.failed.length === 0 ? 'success' : 'error',
          title: t('toasts.fixedTitle', 'Permissions updated'),
          message: result.message || t('toasts.fixedMsg', '{{changed}} entries changed', { changed: result.result.changed }),
        });
      },
      onError: (err) => addToast({ type: 'error', title: t('toasts.fixFailed', 'Could not fix permissions'), message: err instanceof Error ? err.message : String(err) }),
    });
  };

  const toggleIgnore = (folder: OrphanFolder) => {
    ignoreMutation.mutate(
      { id: folder.id, ignored: !folder.ignored },
      {
        onError: (err) => addToast({ type: 'error', title: t('toasts.updateFailed', 'Could not update folder'), message: err instanceof Error ? err.message : String(err) }),
      }
    );
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="font-display text-2xl font-bold text-surface-50">{t('title', 'Unmanaged folders')}</h1>
          <p className="mt-1 max-w-2xl text-sm text-surface-400">
            {t('description', 'Folders inside your Sonarr and Radarr root folders that no series or movie owns: leftovers from moves, failed imports or titles removed without their files. Import them into the right app, or clean them up.')}
          </p>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          <label className="flex items-center gap-2 text-sm text-surface-400">
            <input type="checkbox" checked={showIgnored} onChange={(e) => setShowIgnored(e.target.checked)} className="h-4 w-4 rounded border-surface-600 bg-surface-700 text-accent-500 focus:ring-accent-500" />
            {t('showIgnored', 'Show ignored')}
          </label>
          <Button variant="secondary" size="sm" onClick={() => void refetch()} disabled={isFetching} title={t('refresh', 'Re-read from Sonarr and Radarr')}>
            <RefreshCw className={cn('h-4 w-4', isFetching && 'animate-spin')} />
            <span className="ml-1.5">{t('refresh', 'Re-read from Sonarr and Radarr')}</span>
          </Button>
        </div>
      </div>

      {/* Summary + filters */}
      {data && (
        <div className="flex flex-wrap items-center gap-3">
          <Badge variant="muted">{t('summary.count', '{{count}} folders', { count: data.folders.length })}</Badge>
          <Badge variant="muted">
            <HardDrive className="h-3 w-3" />
            {t('summary.size', '{{size}} measured', { size: formatBytes(data.totalSizeBytes) })}
          </Badge>
          {data.unsized > 0 && <Badge variant="warning">{t('summary.unsized', '{{count}} unmeasured', { count: data.unsized })}</Badge>}
          <div className="ml-auto flex items-center gap-1 rounded-lg bg-surface-800/60 p-1">
            {(['all', 'radarr', 'sonarr'] as ServiceFilter[]).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setFilter(value)}
                className={cn(
                  'rounded-md px-3 py-1 text-xs font-medium transition-colors',
                  filter === value ? 'bg-surface-700 text-surface-50' : 'text-surface-400 hover:text-surface-200'
                )}
              >
                {value === 'all' ? t('filter.all', 'All') : value === 'radarr' ? 'Radarr' : 'Sonarr'}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1 rounded-lg bg-surface-800/60 p-1">
            {(['all', 'permissions', 'unmapped'] as ProblemFilter[]).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setProblems(value)}
                className={cn(
                  'rounded-md px-3 py-1 text-xs font-medium transition-colors',
                  problems === value ? 'bg-surface-700 text-surface-50' : 'text-surface-400 hover:text-surface-200'
                )}
              >
                {value === 'all' ? t('filter.everything', 'Everything') : value === 'permissions' ? t('filter.permissions', 'Permission issues') : t('filter.unmapped', 'No mapping')}
              </button>
            ))}
          </div>
        </div>
      )}

      <FolderJobsPanel
        batches={jobs.batches}
        jobs={jobs.jobs}
        connected={jobs.connected}
        canAct={canAct}
        onCancelBatch={jobs.cancelBatch}
        onCancelJob={jobs.cancel}
        onRetryJob={jobs.retry}
        onClearFinished={jobs.clearFinished}
      />

      {/* Notices */}
      {data && !hasMappings && data.folders.length > 0 && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-500/20 bg-amber-500/10 p-4">
          <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0 text-accent-text" />
          <div className="text-sm">
            <p className="font-medium text-surface-50">{t('mappingNotice.title', 'Sizes and deletion need a folder mapping')}</p>
            <p className="mt-1 text-surface-400">
              {t('mappingNotice.body', "PrunerrXT can list these folders through Sonarr and Radarr, but it can only measure or delete them when it can see the files itself. Map the root folder's path to the path where PrunerrXT sees it.")}
              {auth.isAdmin && (
                <>
                  {' '}
                  <Link to="/settings#media-folders" className="text-accent-text underline-offset-2 hover:underline">
                    {t('mappingNotice.link', 'Add a mapping in Settings')}
                  </Link>
                </>
              )}
            </p>
          </div>
        </div>
      )}
      {permissions.data && !permissions.data.capabilities.canChown && hasMappings && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-500/20 bg-amber-500/10 p-4 text-sm">
          <Lock className="mt-0.5 h-5 w-5 flex-shrink-0 text-accent-text" />
          <p className="text-surface-300">
            <span className="font-medium text-surface-50">{t('capabilityNotice.title', 'PrunerrXT cannot change ownership on this install. ')}</span>
            {permissions.data.capabilities.reason}
          </p>
        </div>
      )}
      {serviceErrors.map((s) => (
        <div key={s.service} className="flex items-start gap-3 rounded-xl border border-ruby-500/20 bg-ruby-500/10 p-4 text-sm">
          <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0 text-ruby-text" />
          <p className="text-surface-300">
            <span className="font-medium text-surface-50">{s.serviceLabel}: </span>
            {s.error}
          </p>
        </div>
      ))}

      {/* Search */}
      {data && data.folders.length > 5 && (
        <Input icon={<Search className="h-4 w-4" />} placeholder={t('searchPlaceholder', 'Filter by name or path')} value={search} onChange={(e) => setSearch(e.target.value)} />
      )}

      {/* List */}
      {isLoading ? (
        <Card className="p-8 text-center text-sm text-surface-400">
          <Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin text-accent-text" />
          {t('loading', 'Asking Sonarr and Radarr for their unmapped folders…')}
        </Card>
      ) : isError ? (
        <ErrorState error={error instanceof Error ? error : new Error(String(error))} retry={() => void refetch()} />
      ) : nothingConfigured ? (
        <EmptyState icon={FolderX} title={t('empty.notConfiguredTitle', 'Connect Sonarr or Radarr first')} description={t('empty.notConfiguredBody', 'Unmanaged folders are read from the apps that own the root folders.')} />
      ) : folders.length === 0 ? (
        <EmptyState icon={FolderX} title={t('empty.title', 'Nothing unmanaged')} description={t('empty.body', 'Every folder under your root folders belongs to a series or movie. Nice and tidy.')} />
      ) : (
        <Card>
          {canAct && (
            <div className="flex flex-wrap items-center gap-3 border-b border-surface-800 px-4 py-2.5">
              <label className="flex items-center gap-2 text-sm text-surface-300">
                <input type="checkbox" checked={allShownSelected} onChange={toggleAllShown} className="h-4 w-4 rounded border-surface-600 bg-surface-700 text-accent-500 focus:ring-accent-500" />
                {allShownSelected ? t('bulk.deselectShown', 'Deselect the {{count}} shown', { count: folders.length }) : t('bulk.selectShown', 'Select the {{count}} shown', { count: folders.length })}
              </label>
              {selectedFolders.length > 0 && (
                <>
                  <Badge variant="accent" size="sm">
                    <CheckSquare className="h-3 w-3" />
                    {t('bulk.selected', '{{count}} selected', { count: selectedFolders.length })}
                    {selectedSize > 0 && ` · ${formatBytes(selectedSize)}`}
                  </Badge>
                  <div className="ml-auto flex flex-wrap items-center gap-1">
                    <Button variant="secondary" size="sm" onClick={() => setBulkImporting(true)} disabled={selectedImportable.length === 0} title={t('bulk.importHint', 'Match each folder to a title and import the ones you accept')}>
                      <Download className="h-4 w-4" />
                      <span className="ml-1">{t('bulk.import', 'Import {{count}}…', { count: selectedImportable.length })}</span>
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => queueBulk('fix_permissions', selectedFixable.map((f) => f.id))}
                      disabled={selectedFixable.length === 0 || !(permissions.data?.capabilities.canChown ?? false) || queueJobs.isPending}
                      title={permissions.data?.capabilities.canChown ? t('bulk.fixHint', 'Set the configured owner and modes on each selected folder') : t('row.fixDisabled', 'PrunerrXT cannot change ownership on this install')}
                    >
                      <Wrench className="h-4 w-4" />
                      <span className="ml-1">{t('bulk.fix', 'Fix permissions {{count}}', { count: selectedFixable.length })}</span>
                    </Button>
                    <Button variant="danger" size="sm" onClick={() => setBulkDeleting(true)} disabled={selectedDeletable.length === 0} title={selectedDeletable.length < selectedFolders.length ? t('bulk.deleteHint', 'Only folders a mapping covers can be deleted') : undefined}>
                      <Trash2 className="h-4 w-4" />
                      <span className="ml-1">{t('bulk.delete', 'Delete {{count}}…', { count: selectedDeletable.length })}</span>
                    </Button>
                    {selectedFolders.some((f) => !f.ignored) ? (
                      <Button variant="ghost" size="sm" onClick={() => bulkSetIgnored(true)} disabled={bulkIgnore.isPending} title={t('bulk.ignore', 'Ignore selected')}>
                        <EyeOff className="h-4 w-4" />
                      </Button>
                    ) : (
                      <Button variant="ghost" size="sm" onClick={() => bulkSetIgnored(false)} disabled={bulkIgnore.isPending} title={t('bulk.unignore', 'Show selected again')}>
                        <Eye className="h-4 w-4" />
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())} title={t('bulk.clear', 'Clear selection')}>
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}
          <ul className="divide-y divide-surface-800">
            {folders.map((folder) => (
              <FolderRow
                key={folder.id}
                folder={folder}
                canAct={canAct}
                selected={selected.has(folder.id)}
                onToggleSelected={() => toggleSelected(folder.id)}
                queued={jobs.activeFolderIds.has(folder.id)}
                busy={ignoreMutation.isPending && ignoreMutation.variables?.id === folder.id}
                fixing={fixMutation.isPending && fixMutation.variables === folder.id}
                canFix={permissions.data?.capabilities.canChown ?? false}
                owner={permissions.data ? `${permissions.data.settings.uid}:${permissions.data.settings.gid}` : ''}
                onImport={() => setImporting(folder)}
                onDelete={() => setDeleting(folder)}
                onToggleIgnore={() => toggleIgnore(folder)}
                onFix={() => fixPermissions(folder)}
              />
            ))}
          </ul>
        </Card>
      )}

      {importing && <ImportModal folder={importing} onClose={() => setImporting(null)} />}
      {bulkImporting && (
        <BulkImportModal
          folders={selectedImportable}
          onClose={() => setBulkImporting(false)}
          onQueued={() => {
            setBulkImporting(false);
            setSelected(new Set());
            void jobs.refresh();
          }}
        />
      )}

      <ConfirmModal
        isOpen={bulkDeleting}
        onClose={() => !queueJobs.isPending && setBulkDeleting(false)}
        onConfirm={() => queueBulk('delete', selectedDeletable.map((f) => f.id))}
        title={t('bulkDeleteModal.title', 'Delete {{count}} folders?', { count: selectedDeletable.length })}
        message={t('bulkDeleteModal.message', '{{count}} folders ({{size}}) will be removed from disk in the background, one at a time per app, each re-checked as still unmanaged just before it goes. There is no recycle bin for this.{{skipped}}', {
          count: selectedDeletable.length,
          size: formatBytes(selectedDeletable.reduce((sum, f) => sum + (f.sizeBytes ?? 0), 0)),
          skipped:
            selectedDeletable.length < selectedFolders.length
              ? ' ' + t('bulkDeleteModal.skipped', '{{count}} of the selected folders have no mapping or are already being worked on and are left out.', { count: selectedFolders.length - selectedDeletable.length })
              : '',
        })}
        confirmText={t('bulkDeleteModal.confirm', 'Delete {{count}} folders', { count: selectedDeletable.length })}
        variant="danger"
        isLoading={queueJobs.isPending}
      />

      <ConfirmModal
        isOpen={!!deleting}
        onClose={() => !deleteMutation.isPending && setDeleting(null)}
        onConfirm={confirmDelete}
        title={t('deleteModal.title', 'Delete this folder?')}
        message={
          deleting
            ? t('deleteModal.message', '"{{name}}" and everything in it ({{files}} files, {{size}}) will be removed from disk. There is no recycle bin for this.', {
                name: deleting.name,
                files: deleting.fileCount ?? 0,
                size: formatBytes(deleting.sizeBytes ?? 0),
              })
            : ''
        }
        confirmText={t('deleteModal.confirm', 'Delete folder')}
        variant="danger"
        isLoading={deleteMutation.isPending}
      />
    </div>
  );
}

function FolderRow({
  folder,
  canAct,
  selected,
  onToggleSelected,
  queued,
  busy,
  fixing,
  canFix,
  owner,
  onImport,
  onDelete,
  onToggleIgnore,
  onFix,
}: {
  folder: OrphanFolder;
  canAct: boolean;
  selected: boolean;
  onToggleSelected: () => void;
  /** A bulk job owns this folder right now. */
  queued: boolean;
  busy: boolean;
  fixing: boolean;
  canFix: boolean;
  owner: string;
  onImport: () => void;
  onDelete: () => void;
  onToggleIgnore: () => void;
  onFix: () => void;
}) {
  const { t } = useTranslation('folders');
  const Icon = folder.service === 'radarr' ? Film : Tv;
  const permissionTrouble = folder.localPath !== null && ((folder.permissionIssues ?? 0) > 0 || folder.writable === false);
  return (
    <li className={cn('flex flex-col gap-3 p-4 sm:flex-row sm:items-start', folder.ignored && 'opacity-60', selected && 'bg-accent-500/5')}>
      {canAct && (
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelected}
          aria-label={t('bulk.selectOne', 'Select {{name}}', { name: folder.name })}
          className="mt-4 h-4 w-4 flex-shrink-0 rounded border-surface-600 bg-surface-700 text-accent-500 focus:ring-accent-500"
        />
      )}
      <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-xl bg-surface-800">
        <Icon className="h-6 w-6 text-surface-500" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="truncate text-sm font-medium text-surface-50 sm:text-base">{folder.name}</h3>
          <Badge variant={folder.service === 'radarr' ? 'movie' : 'tv'} size="sm">{folder.serviceLabel}</Badge>
          {folder.sizeBytes !== null ? (
            <Badge variant="muted" size="sm">{formatBytes(folder.sizeBytes)}</Badge>
          ) : (
            <Badge variant="warning" size="sm" title={t('row.unmeasuredHint', 'No folder mapping covers this path')}>{t('row.unmeasured', 'size unknown')}</Badge>
          )}
          {folder.fileCount !== null && <Badge variant="muted" size="sm">{t('row.files', '{{count}} files', { count: folder.fileCount })}</Badge>}
          {folder.ignored && <Badge variant="default" size="sm">{t('row.ignored', 'Ignored')}</Badge>}
          {queued && (
            <Badge variant="accent" size="sm">
              <Loader2 className="h-3 w-3 animate-spin" />
              {t('row.queued', 'in a bulk job')}
            </Badge>
          )}
          {permissionTrouble && (
            <Badge
              variant="danger"
              size="sm"
              title={
                folder.writable === false
                  ? t('row.notWritableHint', 'PrunerrXT cannot write to this folder as it is; a delete or import would fail with permission denied')
                  : t('row.permissionIssuesHint', 'Entries not owned by {{owner}} or with other modes than configured', { owner })
              }
            >
              <Lock className="h-3 w-3" />
              {folder.writable === false
                ? t('row.notWritable', 'not writable')
                : t('row.permissionIssues', '{{count}} with other owner/mode', { count: folder.permissionIssues ?? 0 })}
            </Badge>
          )}
        </div>
        <p className="mt-1 truncate font-mono text-xs text-surface-500" title={folder.path}>{folder.path}</p>
        <p className="mt-1 text-xs text-surface-400">
          {t('row.looksLike', 'Looks like: {{title}}', { title: folder.guess.year ? `${folder.guess.title} (${folder.guess.year})` : folder.guess.title })}
          {folder.modifiedAt && <span className="text-surface-500"> · {t('row.modified', 'changed {{when}}', { when: formatRelativeTime(folder.modifiedAt) })}</span>}
        </p>
        {folder.videoFiles.length > 0 && (
          <p className="mt-1 truncate text-2xs text-surface-500" title={folder.videoFiles.join('\n')}>
            {folder.videoFiles.join(' · ')}
          </p>
        )}
      </div>
      {canAct && (
        <div className="flex flex-shrink-0 items-center gap-1">
          <Button variant="secondary" size="sm" onClick={onImport} disabled={queued} title={t('row.import', 'Import into {{service}}', { service: folder.serviceLabel })}>
            <Download className="h-4 w-4" />
            <span className="ml-1 hidden sm:inline">{t('row.importShort', 'Import')}</span>
          </Button>
          {permissionTrouble && (
            <Button
              variant="secondary"
              size="sm"
              onClick={onFix}
              disabled={!canFix || fixing || queued}
              title={canFix ? t('row.fix', 'Fix permissions (owner {{owner}})', { owner }) : t('row.fixDisabled', 'PrunerrXT cannot change ownership on this install')}
            >
              {fixing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wrench className="h-4 w-4" />}
            </Button>
          )}
          <Button
            variant="danger"
            size="sm"
            onClick={onDelete}
            disabled={!folder.canDelete || queued}
            title={folder.canDelete ? t('row.delete', 'Delete folder') : t('row.deleteDisabled', 'Add a folder mapping in Settings so PrunerrXT can reach this folder')}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={onToggleIgnore} disabled={busy} title={folder.ignored ? t('row.unignore', 'Show again') : t('row.ignore', 'Ignore')}>
            {folder.ignored ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
          </Button>
        </div>
      )}
    </li>
  );
}

function ImportModal({ folder, onClose }: { folder: OrphanFolder; onClose: () => void }) {
  const { t } = useTranslation('folders');
  const { addToast } = useToast();
  const [term, setTerm] = useState('');
  const [submittedTerm, setSubmittedTerm] = useState<string | undefined>(undefined);
  const [candidateId, setCandidateId] = useState<number | null>(null);
  const [profileId, setProfileId] = useState<number | null>(null);
  const [monitored, setMonitored] = useState(true);

  const candidates = useFolderCandidates(folder.id, submittedTerm);
  const profiles = useQualityProfiles(folder.service);
  const importMutation = useImportFolder();

  const chosenProfile = profileId ?? profiles.data?.[0]?.id ?? null;
  const list = candidates.data?.candidates ?? [];
  const selected = candidateId ?? list.find((c) => !c.inLibrary)?.id ?? null;

  const submit = () => {
    if (selected === null) return;
    importMutation.mutate(
      { id: folder.id, candidateId: selected, qualityProfileId: chosenProfile ?? undefined, monitored },
      {
        onSuccess: (result) => {
          addToast({ type: 'success', title: t('toasts.importedTitle', 'Imported'), message: result.message || t('toasts.importedMsg', '"{{title}}" added to {{service}}', { title: result.title, service: folder.serviceLabel }) });
          onClose();
        },
        onError: (err) => addToast({ type: 'error', title: t('toasts.importFailed', 'Import failed'), message: err instanceof Error ? err.message : String(err) }),
      }
    );
  };

  return (
    <Modal isOpen onClose={() => !importMutation.isPending && onClose()} title={t('importModal.title', 'Import into {{service}}', { service: folder.serviceLabel })} size="lg">
      <div className="space-y-4">
        <p className="text-sm text-surface-400">
          {t('importModal.intro', '{{service}} will add the title with this folder as its path and scan it in place. Nothing is moved.', { service: folder.serviceLabel })}
        </p>
        <p className="truncate font-mono text-xs text-surface-500" title={folder.path}>{folder.path}</p>

        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setSubmittedTerm(term.trim() || undefined);
            setCandidateId(null);
          }}
        >
          <Input
            icon={<Search className="h-4 w-4" />}
            placeholder={candidates.data?.term ?? t('importModal.searchPlaceholder', 'Search by title, tmdb:123 or tvdb:123')}
            value={term}
            onChange={(e) => setTerm(e.target.value)}
          />
          <Button type="submit" variant="secondary" disabled={candidates.isFetching}>
            {t('importModal.search', 'Search')}
          </Button>
        </form>

        <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
          {candidates.isLoading ? (
            <p className="py-6 text-center text-sm text-surface-500">
              <Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin text-accent-text" />
              {t('importModal.searching', 'Searching {{service}}…', { service: folder.serviceLabel })}
            </p>
          ) : candidates.isError ? (
            <p className="text-sm text-ruby-text">{candidates.error instanceof Error ? candidates.error.message : String(candidates.error)}</p>
          ) : list.length === 0 ? (
            <p className="py-6 text-center text-sm text-surface-500">{t('importModal.noMatches', 'No matches. Try another search term.')}</p>
          ) : (
            list.map((c) => (
              <label
                key={c.id}
                className={cn(
                  'flex cursor-pointer gap-3 rounded-lg border p-2 transition-colors',
                  selected === c.id ? 'border-accent-500/50 bg-accent-500/10' : 'border-surface-700/50 hover:bg-surface-800/60',
                  c.inLibrary && 'cursor-not-allowed opacity-60'
                )}
              >
                <input type="radio" name="candidate" className="mt-1" checked={selected === c.id} disabled={c.inLibrary} onChange={() => setCandidateId(c.id)} />
                <div className="h-16 w-11 flex-shrink-0 overflow-hidden rounded bg-surface-800">
                  {c.posterUrl && <img src={c.posterUrl} alt="" className="h-full w-full object-cover" loading="lazy" />}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-surface-50">
                    {c.title} {c.year ? <span className="text-surface-400">({c.year})</span> : null}
                    {c.inLibrary && <Badge variant="warning" size="sm" className="ml-2">{t('importModal.inLibrary', 'already in {{service}}', { service: folder.serviceLabel })}</Badge>}
                  </p>
                  {c.overview && <p className="mt-0.5 line-clamp-2 text-xs text-surface-500">{c.overview}</p>}
                  <p className="mt-0.5 text-2xs text-surface-500">{folder.service === 'radarr' ? 'TMDB' : 'TVDB'} {c.id}</p>
                </div>
              </label>
            ))
          )}
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="flex-1 text-sm">
            <span className="mb-1 block text-xs font-medium text-surface-400">{t('importModal.qualityProfile', 'Quality profile')}</span>
            <select
              value={chosenProfile ?? ''}
              onChange={(e) => setProfileId(Number(e.target.value))}
              className="w-full rounded-lg border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-surface-50 focus:outline-none focus:ring-2 focus:ring-accent-500/50"
            >
              {(profiles.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 pb-2 text-sm text-surface-300">
            <input type="checkbox" checked={monitored} onChange={(e) => setMonitored(e.target.checked)} className="h-4 w-4 rounded border-surface-600 bg-surface-700 text-accent-500 focus:ring-accent-500" />
            {t('importModal.monitored', 'Monitor after import')}
          </label>
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <Button variant="secondary" onClick={onClose} disabled={importMutation.isPending}>{t('importModal.cancel', 'Cancel')}</Button>
          <Button onClick={submit} disabled={selected === null || importMutation.isPending || chosenProfile === null}>
            {importMutation.isPending ? t('importModal.importing', 'Importing…') : t('importModal.confirm', 'Import')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
