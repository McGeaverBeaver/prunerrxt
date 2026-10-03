import { useState, useCallback, useEffect, memo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Trash2,
  Clock,
  AlertTriangle,
  Undo2,
  Play,
  Film,
  Tv,
  Shield,
  CheckCircle,
  RefreshCw,
  ExternalLink,
  Info,
  Loader2,
} from 'lucide-react';
import { Card } from '@/components/common/Card';
import { MaybeLink } from '@/components/common/MaybeLink';
import { Button } from '@/components/common/Button';
import { Badge } from '@/components/common/Badge';
import { Modal } from '@/components/common/Modal';
import { useDeletionQueue, useRemoveFromQueue, useProcessQueue, useProtectItem, useSettings } from '@/hooks/useApi';
import { useToast } from '@/components/common/Toast';
import { formatBytes, formatDate, formatRelativeTime, getDaysUntil } from '@/lib/utils';
import { deletionActionLabel } from '@/lib/deletionActions';
import { libraryItemPath, rulePath } from '@/lib/links';
import { usePageScroll } from '@/contexts/PageScrollContext';
import { ErrorState } from '@/components/common/ErrorState';
import { EmptyState } from '@/components/common/EmptyState';
import type { QueueItem, DeletionJob } from '@/types';
import { queueApi } from '@/services/api';
import { useDeletionJobs } from '@/contexts/DeletionJobsContext';
import { isActiveJob } from '@/lib/deletionJobs';
import { QueueJobBadge } from './QueueJobBadge';

const ITEMS_PER_PAGE = 25;

export default function Queue() {
  const navigate = useNavigate();
  const [selectedItems, setSelectedItems] = useState<string[]>([]);
  const [confirmProcessing, setConfirmProcessing] = useState(false);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const [confirmDeleteNow, setConfirmDeleteNow] = useState<QueueItem | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const { scrollToTop } = usePageScroll();

  // Paging swaps the rows without changing the route, so nothing resets the
  // scroll — clicking these controls at the bottom of the list would
  // otherwise land you on the new page already scrolled past its first rows.
  const goToPage = (next: number) => {
    setCurrentPage(next);
    scrollToTop();
  };

  const { data: queue, isLoading, isError, error, refetch } = useDeletionQueue();
  const jobs = useDeletionJobs();
  const removeFromQueueMutation = useRemoveFromQueue();
  const processQueueMutation = useProcessQueue();
  const protectMutation = useProtectItem();
  const { addToast } = useToast();
  const { t } = useTranslation('queue');

  const handleSelectAll = () => {
    if (queue && selectedItems.length === queue.length) {
      setSelectedItems([]);
    } else if (queue) {
      setSelectedItems(queue.map((item) => item.id));
    }
  };

  const handleSelectItem = (id: string) => {
    if (selectedItems.includes(id)) {
      setSelectedItems(selectedItems.filter((i) => i !== id));
    } else {
      setSelectedItems([...selectedItems, id]);
    }
  };

  const [isRemoving, setIsRemoving] = useState(false);
  const [removeProgress, setRemoveProgress] = useState({ current: 0, total: 0 });

  const handleRemoveFromQueue = (id: string) => {
    removeFromQueueMutation.mutate(id, { onSuccess: () => refetch() });
  };

  const handleRemoveSelected = async () => {
    if (selectedItems.length === 0) return;

    const itemsToRemove = [...selectedItems];
    const total = itemsToRemove.length;

    setIsRemoving(true);
    setRemoveProgress({ current: 0, total });
    setSelectedItems([]); // Clear selection immediately

    let successCount = 0;
    let failCount = 0;

    // Process sequentially to avoid overwhelming the server
    for (const id of itemsToRemove) {
      try {
        await new Promise<void>((resolve) => {
          removeFromQueueMutation.mutate(id, {
            onSuccess: () => {
              successCount++;
              setRemoveProgress({ current: successCount + failCount, total });
              resolve();
            },
            onError: (error) => {
              failCount++;
              setRemoveProgress({ current: successCount + failCount, total });
              console.error('Failed to remove item:', id, error);
              resolve(); // Continue even on failure
            },
          });
        });
      } catch {
        failCount++;
        setRemoveProgress({ current: successCount + failCount, total });
      }
    }

    setIsRemoving(false);
    setRemoveProgress({ current: 0, total: 0 });

    if (successCount > 0) {
      addToast({
        type: 'success',
        title: t('toasts.itemsRemovedTitle', 'Items removed'),
        message: t('toasts.itemsRemovedMsg', '{{count}} item(s) removed from queue', { count: successCount }),
      });
    }
    if (failCount > 0) {
      addToast({
        type: 'error',
        title: t('toasts.someItemsFailedTitle', 'Some items failed'),
        message: t('toasts.someItemsFailedMsg', '{{count}} item(s) could not be removed', { count: failCount }),
      });
    }

    refetch();
  };

  const handleProtect = (id: string) => {
    protectMutation.mutate(id, { onSuccess: () => refetch() });
  };

  const handleProcessQueue = () => {
    processQueueMutation.mutate(false, {
      onSuccess: (data) => {
        setConfirmProcessing(false);
        addToast({
          type: 'success',
          title: t('toasts.processingTitle', 'Deleting in the background'),
          message: data.message || t('toasts.processingMsg', '{{count}} item(s) queued for deletion', { count: data.queued.length }),
        });
        refetch();
      },
    });
  };

  const handleDeleteAll = () => {
    processQueueMutation.mutate(true, {
      onSuccess: (data) => {
        setConfirmDeleteAll(false);
        addToast({
          type: 'success',
          title: t('toasts.processingTitle', 'Deleting in the background'),
          message: data.message || t('toasts.processingMsg', '{{count}} item(s) queued for deletion', { count: data.queued.length }),
        });
        refetch();
      },
    });
  };

  const handleDeleteNow = (item: QueueItem) => setConfirmDeleteNow(item);

  // Delete Now queues a background job and returns at once; the row badge,
  // the sidebar indicator and the jobs panel follow it from there.
  const [isQueueingDeleteNow, setIsQueueingDeleteNow] = useState(false);
  const handleConfirmDeleteNow = useCallback(async () => {
    if (!confirmDeleteNow) return;
    setIsQueueingDeleteNow(true);
    try {
      const result = await queueApi.deleteNow(confirmDeleteNow.id);
      addToast({
        type: 'success',
        title: result.alreadyQueued
          ? t('toasts.alreadyDeletingTitle', 'Already in progress')
          : t('toasts.deletingTitle', 'Deleting in the background'),
        message: result.message || t('toasts.deletingMsg', '"{{title}}" is being deleted. Progress shows in the sidebar.', { title: confirmDeleteNow.title }),
      });
      setConfirmDeleteNow(null);
    } catch (error) {
      addToast({
        type: 'error',
        title: t('toasts.deleteFailedTitle', 'Delete failed'),
        message: error instanceof Error ? error.message : t('toasts.deleteFailedMsg', 'Failed to delete item'),
      });
    } finally {
      setIsQueueingDeleteNow(false);
    }
  }, [confirmDeleteNow, addToast, t]);

  const { data: settings } = useSettings();

  const hasArrService = Boolean(settings?.services?.sonarr?.url || settings?.services?.radarr?.url);

  // Calculate stats
  const totalSize = queue?.reduce((acc, item) => acc + item.size, 0) || 0;
  const readyItems = queue?.filter((item) => (item.daysRemaining ?? getDaysUntil(item.deleteAt)) <= 0) || [];
  const readyToDelete = readyItems.length;
  const readyToDeleteSize = readyItems.reduce((acc, item) => acc + item.size, 0);
  const willResetOverseerr = queue?.filter((item) => item.resetOverseerr).length || 0;

  // Pagination
  const totalItems = queue?.length || 0;
  const totalPages = Math.ceil(totalItems / ITEMS_PER_PAGE);
  const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
  const endIndex = startIndex + ITEMS_PER_PAGE;
  const paginatedQueue = queue?.slice(startIndex, endIndex) || [];

  // Reset to page 1 if current page is out of bounds
  useEffect(() => {
    if (currentPage > totalPages && totalPages > 0) {
      setCurrentPage(1);
    }
  }, [currentPage, totalPages]);

  // Get Overseerr URL for links
  const overseerrUrl = settings?.services?.overseerr?.url?.replace(/\/$/, '');

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-4 sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-surface-50">{t('header.title', 'Deletion Queue')}</h1>
          <p className="text-surface-400 mt-1 text-sm sm:text-base">
            {t('header.subtitle', 'Items marked for deletion with grace period countdown')}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          {(selectedItems.length > 0 || isRemoving) && (
            <Button variant="secondary" onClick={handleRemoveSelected} disabled={isRemoving}>
              {isRemoving ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Undo2 className="w-4 h-4 mr-2" />
              )}
              {isRemoving
                ? t('actions.removingProgress', 'Removing {{current}}/{{total}}...', { current: removeProgress.current, total: removeProgress.total })
                : t('actions.removeSelected', 'Remove Selected ({{count}})', { count: selectedItems.length })}
            </Button>
          )}
          <div className="relative group">
            <Button
              variant="danger"
              onClick={() => setConfirmProcessing(true)}
              disabled={!hasArrService || !queue || queue.length === 0 || readyToDelete === 0}
            >
              <Play className="w-4 h-4 mr-2" />
              <span className="hidden sm:inline">{t('actions.processQueue', 'Process Queue')}</span>
              <span className="sm:hidden">{t('actions.process', 'Process')}</span>
              {readyToDelete > 0 && ` (${readyToDelete})`}
            </Button>
            {queue && queue.length > 0 && readyToDelete === 0 && hasArrService && (
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-1.5 text-xs text-surface-200 bg-surface-700 rounded-lg shadow-lg whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                {t('actions.noItemsPastGrace', 'No items have passed their grace period yet')}
              </div>
            )}
          </div>
          <Button
            variant="danger"
            onClick={() => setConfirmDeleteAll(true)}
            disabled={!hasArrService || !queue || queue.length === 0}
          >
            <Trash2 className="w-4 h-4 mr-2" />
            <span className="hidden sm:inline">{t('actions.deleteAllNow', 'Delete All Now')}</span>
            <span className="sm:hidden">{t('actions.deleteAll', 'Delete All')}</span>
          </Button>
        </div>
      </div>

      {/* Arr Service Warning */}
      {!hasArrService && (
        <div className="flex items-center justify-between gap-4 p-4 bg-amber-500/10 rounded-xl border border-amber-500/20">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-accent-text flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-surface-50">{t('arrWarning.title', 'Sonarr/Radarr not configured')}</p>
              <p className="text-xs text-surface-400 mt-1">
                {t('arrWarning.bannerDesc', "Deletion requires Sonarr or Radarr to remove files from disk. Items can be queued but won't be processed until a service is set up.")}
              </p>
            </div>
          </div>
          <Button variant="secondary" size="sm" onClick={() => navigate('/settings')}>
            {t('arrWarning.goToSettings', 'Go to Settings')}
          </Button>
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card className="p-4">
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-lg bg-warning-500/10">
              <Clock className="w-6 h-6 text-warning-400" />
            </div>
            <div>
              <p className="text-sm text-surface-400">{t('stats.itemsInQueue', 'Items in Queue')}</p>
              <p className="text-2xl font-bold text-surface-50">{queue?.length || 0}</p>
            </div>
          </div>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-lg bg-ruby-500/10">
              <Trash2 className="w-6 h-6 text-ruby-text" />
            </div>
            <div>
              <p className="text-sm text-surface-400">{t('stats.readyToDelete', 'Ready to Delete')}</p>
              <p className="text-2xl font-bold text-surface-50">{readyToDelete}</p>
            </div>
          </div>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-lg bg-accent-500/10">
              <AlertTriangle className="w-6 h-6 text-accent-text" />
            </div>
            <div>
              <p className="text-sm text-surface-400">{t('stats.spaceToReclaim', 'Space to Reclaim')}</p>
              <p className="text-2xl font-bold text-surface-50">{formatBytes(totalSize)}</p>
            </div>
          </div>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-lg bg-violet-500/10">
              <RefreshCw className="w-6 h-6 text-violet-text" />
            </div>
            <div>
              <p className="text-sm text-surface-400">{t('stats.willResetSeerr', 'Will Reset Seerr')}</p>
              <p className="text-2xl font-bold text-surface-50">{willResetOverseerr}</p>
            </div>
          </div>
        </Card>
      </div>

      {/* Queue List */}
      {isLoading ? (
        <Card>
          <div className="divide-y divide-surface-800">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-20 animate-pulse bg-surface-800/50" />
            ))}
          </div>
        </Card>
      ) : isError ? (
        <ErrorState
          error={error as Error}
          title={t('errors.loadQueue', 'Failed to load queue')}
          retry={refetch}
        />
      ) : queue && queue.length > 0 ? (
        <Card>
          {/* Table Header */}
          <div className="px-3 sm:px-4 py-3 border-b border-surface-800 bg-surface-800/30">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-3 sm:gap-4">
                <input
                  type="checkbox"
                  checked={selectedItems.length === queue.length && queue.length > 0}
                  ref={(el) => {
                    if (el) {
                      el.indeterminate = selectedItems.length > 0 && selectedItems.length < queue.length;
                    }
                  }}
                  onChange={handleSelectAll}
                  className="w-4 h-4 rounded border-surface-600 bg-surface-700 text-accent-500 focus:ring-accent-500"
                />
                <span className="text-sm text-surface-400">
                  {selectedItems.length > 0
                    ? t('table.selectedCount', '{{count}} of {{total}} selected', { count: selectedItems.length, total: totalItems })
                    : t('table.selectAll', 'Select All')}
                </span>
              </div>
              <span className="text-sm text-surface-400">
                {t('table.showingRange', 'Showing {{start}}-{{end}} of {{total}}', { start: startIndex + 1, end: Math.min(endIndex, totalItems), total: totalItems })}
              </span>
            </div>
          </div>

          {/* Queue Items */}
          <div className="divide-y divide-surface-800">
            {paginatedQueue.map((item) => (
              <QueueItemRow
                key={item.id}
                item={item}
                selected={selectedItems.includes(item.id)}
                onSelect={() => handleSelectItem(item.id)}
                onRemove={() => handleRemoveFromQueue(item.id)}
                onProtect={() => handleProtect(item.id)}
                onDeleteNow={() => handleDeleteNow(item)}
                onRetryJob={() => {
                  const job = jobs.byQueueId(item.id);
                  if (job) void jobs.retry(job.id);
                }}
                job={jobs.byQueueId(item.id)}
                now={isActiveJob(jobs.byQueueId(item.id)) ? jobs.now : 0}
                overseerrUrl={overseerrUrl}
                hasArrService={hasArrService}
              />
            ))}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="px-3 sm:px-4 py-3 border-t border-surface-800 bg-surface-800/30 flex items-center justify-between gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => goToPage(Math.max(1, currentPage - 1))}
                disabled={currentPage === 1}
              >
                {t('pagination.previous', 'Previous')}
              </Button>
              <div className="flex items-center gap-2">
                {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                  let pageNum: number;
                  if (totalPages <= 5) {
                    pageNum = i + 1;
                  } else if (currentPage <= 3) {
                    pageNum = i + 1;
                  } else if (currentPage >= totalPages - 2) {
                    pageNum = totalPages - 4 + i;
                  } else {
                    pageNum = currentPage - 2 + i;
                  }
                  return (
                    <button
                      key={pageNum}
                      onClick={() => goToPage(pageNum)}
                      className={`w-8 h-8 rounded text-sm font-medium transition-colors ${
                        currentPage === pageNum
                          ? 'bg-accent-500 text-amber-950'
                          : 'text-surface-400 hover:bg-surface-700'
                      }`}
                    >
                      {pageNum}
                    </button>
                  );
                })}
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => goToPage(Math.min(totalPages, currentPage + 1))}
                disabled={currentPage === totalPages}
              >
                {t('pagination.next', 'Next')}
              </Button>
            </div>
          )}
        </Card>
      ) : (
        <Card className="p-12">
          <EmptyState
            icon={CheckCircle}
            variant="success"
            title={t('empty.title', 'Queue is empty')}
            description={t('empty.description', 'No items are currently marked for deletion. Browse your library to queue items for cleanup, or set up rules to automate the process.')}
            action={{ label: t('empty.browseLibrary', 'Browse Library'), onClick: () => navigate('/library') }}
            secondaryAction={{ label: t('empty.setUpRules', 'Set up rules'), onClick: () => navigate('/rules') }}
          />
        </Card>
      )}

      {/* Confirm Processing Modal */}
      <Modal
        isOpen={confirmProcessing}
        onClose={() => setConfirmProcessing(false)}
        title={t('processModal.title', 'Process Deletion Queue')}
      >
        <div className="space-y-4">
          {!hasArrService && (
            <div className="flex items-start gap-3 p-4 bg-amber-500/10 rounded-lg border border-amber-500/20">
              <AlertTriangle className="w-5 h-5 text-accent-text flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-surface-50">{t('arrWarning.title', 'Sonarr/Radarr not configured')}</p>
                <p className="text-xs text-surface-400 mt-1">{t('arrWarning.modalDesc', "Items will be marked as deleted in Prunerr but files won't be removed from disk. Set up Sonarr or Radarr in Settings first.")}</p>
              </div>
            </div>
          )}
          <div className="flex items-center gap-3 p-4 bg-ruby-500/10 rounded-lg border border-ruby-500/20">
            <AlertTriangle className="w-6 h-6 text-ruby-text flex-shrink-0" />
            <div>
              <p className="text-sm text-surface-50">
                {t('processModal.warning', 'This will delete items that have passed their grace period.')}
              </p>
              <p className="text-sm text-ruby-text mt-1">
                {t('processModal.readySummary', '{{ready}} of {{total}} item(s) ready ({{size}})', { ready: readyToDelete, total: queue?.length || 0, count: queue?.length || 0, size: formatBytes(readyToDeleteSize) })}
              </p>
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-4">
            <Button variant="secondary" onClick={() => setConfirmProcessing(false)}>
              {t('actions.cancel', 'Cancel')}
            </Button>
            <Button
              variant="danger"
              onClick={handleProcessQueue}
              disabled={processQueueMutation.isPending || readyToDelete === 0}
            >
              {processQueueMutation.isPending ? t('actions.processing', 'Processing...') : t('actions.confirmDelete', 'Confirm Delete')}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Confirm Delete All Modal */}
      <Modal
        isOpen={confirmDeleteAll}
        onClose={() => setConfirmDeleteAll(false)}
        title={t('deleteAllModal.title', 'Delete All Items Now')}
      >
        <div className="space-y-4">
          {!hasArrService && (
            <div className="flex items-start gap-3 p-4 bg-amber-500/10 rounded-lg border border-amber-500/20">
              <AlertTriangle className="w-5 h-5 text-accent-text flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-surface-50">{t('arrWarning.title', 'Sonarr/Radarr not configured')}</p>
                <p className="text-xs text-surface-400 mt-1">{t('arrWarning.modalDesc', "Items will be marked as deleted in Prunerr but files won't be removed from disk. Set up Sonarr or Radarr in Settings first.")}</p>
              </div>
            </div>
          )}
          <div className="flex items-center gap-3 p-4 bg-ruby-500/10 rounded-lg border border-ruby-500/20">
            <AlertTriangle className="w-6 h-6 text-ruby-text flex-shrink-0" />
            <div>
              <p className="text-sm text-surface-50">
                {t('deleteAllModal.warning', 'This will permanently delete all items in the queue, ignoring grace periods.')}
              </p>
              <p className="text-sm text-ruby-text mt-1">
                {t('deleteAllModal.summary', '{{count}} item(s) will be deleted ({{size}})', { count: queue?.length || 0, size: formatBytes(totalSize) })}
              </p>
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-4">
            <Button variant="secondary" onClick={() => setConfirmDeleteAll(false)}>
              {t('actions.cancel', 'Cancel')}
            </Button>
            <Button
              variant="danger"
              onClick={handleDeleteAll}
              disabled={processQueueMutation.isPending}
            >
              {processQueueMutation.isPending ? t('actions.deleting', 'Deleting...') : t('actions.deleteAllNow', 'Delete All Now')}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Confirm Delete Now Modal */}
      <Modal
        isOpen={!!confirmDeleteNow}
        onClose={() => !isQueueingDeleteNow && setConfirmDeleteNow(null)}
        title={t('deleteNowModal.title', 'Delete Now')}
      >
        <div className="space-y-4">
          <div className="flex items-center gap-3 p-4 bg-ruby-500/10 rounded-lg border border-ruby-500/20">
            <AlertTriangle className="w-6 h-6 text-ruby-text flex-shrink-0" />
            <div>
              <p className="text-sm text-surface-50">
                {t('deleteNowModal.warning', 'This will immediately and permanently delete this item, bypassing the grace period.')}
              </p>
              {confirmDeleteNow && (
                <p className="text-sm text-ruby-text mt-1">
                  "{confirmDeleteNow.title}" ({formatBytes(confirmDeleteNow.size)})
                </p>
              )}
            </div>
          </div>

          {confirmDeleteNow && (
            <div className="text-sm text-surface-400 space-y-1">
              <p><span className="text-surface-300">{t('deleteNowModal.actionLabel', 'Action:')}</span> {deletionActionLabel(confirmDeleteNow.deletionAction)}</p>
              {confirmDeleteNow.resetOverseerr && (
                <p className="text-violet-text">{t('deleteNowModal.willResetSeerr', 'Will reset in Seerr for re-request')}</p>
              )}
            </div>
          )}

          <p className="text-xs text-surface-500">
            {t('deleteNowModal.background', 'The deletion runs in the background. Keep using Prunerr; progress shows on this row and in the sidebar, and the outcome lands in the Activity log.')}
          </p>

          <div className="flex justify-end gap-3 pt-4">
            <Button variant="secondary" onClick={() => setConfirmDeleteNow(null)} disabled={isQueueingDeleteNow}>
              {t('actions.cancel', 'Cancel')}
            </Button>
            <Button variant="danger" onClick={handleConfirmDeleteNow} disabled={isQueueingDeleteNow}>
              {isQueueingDeleteNow ? t('actions.queueing', 'Starting...') : t('deleteNowModal.title', 'Delete Now')}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

interface QueueItemRowProps {
  item: QueueItem;
  selected: boolean;
  onSelect: () => void;
  onRemove: () => void;
  onProtect: () => void;
  onDeleteNow: () => void;
  onRetryJob: () => void;
  /** The background deletion for this row, if any. */
  job?: DeletionJob;
  /** Clock for the job's elapsed time; 0 when no job is active. */
  now: number;
  overseerrUrl?: string;
  hasArrService?: boolean;
}

const QueueItemRow = memo(function QueueItemRow({ item, selected, onSelect, onRemove, onProtect, onDeleteNow, onRetryJob, job, now, overseerrUrl, hasArrService = true }: QueueItemRowProps) {
  const { t } = useTranslation('queue');
  // While a job owns the row nothing else may touch it.
  const jobActive = isActiveJob(job);
  const showJob = !!job && job.status !== 'cancelled';
  const daysLeft = item.daysRemaining ?? getDaysUntil(item.deleteAt);
  const isReady = daysLeft <= 0;
  const TypeIcon = item.type === 'movie' ? Film : Tv;
  // Protection is a property of the whole show, so a queued episode can't be
  // protected from here — it is removed from the queue instead.
  const isEpisode = item.kind === 'episode';

  // Build Overseerr link if available
  const overseerrLink = overseerrUrl && item.tmdbId
    ? `${overseerrUrl}/${item.type === 'movie' ? 'movie' : 'tv'}/${item.tmdbId}`
    : null;

  // Poster and title open the library detail page. A queued episode has no
  // page of its own, so it links to the show it belongs to.
  const detailHref = libraryItemPath(item.mediaItemId);

  return (
    <div className={`p-3 sm:p-4 hover:bg-surface-800/30 transition-colors ${isReady ? 'bg-ruby-500/5' : ''}`}>
      {/* Top row: checkbox + poster + info */}
      <div className="flex items-start gap-3 sm:gap-4">
        <input
          type="checkbox"
          checked={selected}
          onChange={onSelect}
          className="w-4 h-4 mt-1 rounded border-surface-600 bg-surface-700 text-accent-500 focus:ring-accent-500 flex-shrink-0"
        />

        {/* Poster/Icon */}
        <MaybeLink
          to={detailHref}
          className="flex-shrink-0 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/50"
          title={detailHref ? t('row.viewDetails', 'View details') : undefined}
        >
          {item.posterUrl ? (
            <img
              src={item.posterUrl}
              alt=""
              className="w-10 h-14 sm:w-12 sm:h-16 object-cover rounded"
              loading="lazy"
              decoding="async"
            />
          ) : (
            <div className="w-10 h-14 sm:w-12 sm:h-16 bg-surface-800 rounded flex items-center justify-center">
              <TypeIcon className="w-5 h-5 sm:w-6 sm:h-6 text-surface-600" />
            </div>
          )}
        </MaybeLink>

        {/* Info + Grace + Actions */}
        <div className="flex-1 min-w-0">
          {/* Title row */}
          <div className="flex items-start sm:items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <h3 className="font-medium text-surface-50 truncate text-sm sm:text-base">
                <MaybeLink to={detailHref} className="hover:text-accent-text-hover transition-colors">
                  {item.title}
                </MaybeLink>
              </h3>
              <Badge variant={isEpisode ? 'cyan' : item.type} className="hidden sm:inline-flex">
                {isEpisode ? t('row.episode', 'episode') : item.type}
              </Badge>
            </div>
            {/* Grace period — inline on desktop */}
            <div className="hidden sm:block text-right min-w-[120px] flex-shrink-0">
              {showJob ? (
                <div className="mb-1 flex justify-end"><QueueJobBadge job={job} now={now} onRetry={onRetryJob} /></div>
              ) : isReady ? (
                <Badge variant="danger" className="mb-1">{t('row.readyToDelete', 'Ready to Delete')}</Badge>
              ) : (
                <div className="flex items-center justify-end gap-1 text-warning-400">
                  <Clock className="w-4 h-4" />
                  <span className="text-sm font-medium">{t('row.daysLeft', '{{count}} days left', { count: daysLeft })}</span>
                </div>
              )}
              <p className="text-xs text-surface-400 mt-1">
                {t('row.deletesOn', 'Deletes {{date}}', { date: formatDate(item.deleteAt) })}
              </p>
            </div>
          </div>

          {/* Metadata */}
          <div className="flex items-center flex-wrap gap-x-3 gap-y-1 mt-1 text-xs sm:text-sm text-surface-400">
            <Badge variant={isEpisode ? 'cyan' : item.type} className="sm:hidden">
              {isEpisode ? t('row.episode', 'episode') : item.type}
            </Badge>
            <span>{formatBytes(item.size)}</span>
            <span>{t('row.queued', 'Queued {{time}}', { time: formatRelativeTime(item.queuedAt) })}</span>
            {item.matchedRule && (
              <MaybeLink
                to={rulePath(item.ruleId)}
                className="text-accent-text hidden sm:inline"
                linkClassName="hover:text-accent-text-hover transition-colors"
              >
                {t('row.rulePrefix', 'Rule: {{rule}}', { rule: item.matchedRule })}
              </MaybeLink>
            )}
          </div>

          {/* Deletion action badges */}
          <div className="flex items-center flex-wrap gap-x-2 gap-y-1 mt-1.5">
            <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-surface-800 text-surface-300" title={deletionActionLabel(item.deletionAction)}>
              <Info className="w-3 h-3" />
              <span className="truncate max-w-[150px] sm:max-w-none">{deletionActionLabel(item.deletionAction)}</span>
            </span>
            {item.resetOverseerr && (
              <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-violet-500/20 text-violet-text">
                <RefreshCw className="w-3 h-3" />
                <span className="hidden sm:inline">{t('row.willResetIn', 'Will reset in')}</span> Seerr
              </span>
            )}
            {item.overseerrResetAt && (
              <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-text">
                <CheckCircle className="w-3 h-3" />
                {t('row.reset', 'Reset')}
              </span>
            )}
            {item.requestedBy && (
              <span className="text-xs text-surface-500 hidden sm:inline">
                {t('row.requestedBy', 'Requested by: {{user}}', { user: item.requestedBy })}
              </span>
            )}
          </div>

          {/* Mobile: grace period + actions row */}
          <div className="flex items-center justify-between mt-2 sm:hidden">
            <div className="text-left">
              {showJob ? (
                <QueueJobBadge job={job} now={now} onRetry={onRetryJob} compact />
              ) : isReady ? (
                <Badge variant="danger">{t('row.ready', 'Ready')}</Badge>
              ) : (
                <div className="flex items-center gap-1 text-warning-400">
                  <Clock className="w-3.5 h-3.5" />
                  <span className="text-xs font-medium">{t('row.daysLeftShort', '{{count}}d left', { count: daysLeft })}</span>
                </div>
              )}
            </div>
            <div className="flex items-center gap-1">
              {overseerrLink && (
                <a href={overseerrLink} target="_blank" rel="noopener noreferrer" className="p-2 rounded hover:bg-surface-700 transition-colors" title={t('row.viewInSeerr', 'View in Seerr')}>
                  <ExternalLink className="w-4 h-4 text-violet-text" />
                </a>
              )}
              <Button variant="danger" size="sm" onClick={onDeleteNow} disabled={!hasArrService || jobActive} title={t('row.deleteNow', 'Delete now')}>
                <Trash2 className="w-4 h-4" />
              </Button>
              {!isEpisode && (
                <Button variant="ghost" size="sm" onClick={onProtect} disabled={jobActive} title={t('row.protect', 'Protect')}>
                  <Shield className="w-4 h-4 text-accent-text" />
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={onRemove} disabled={jobActive} title={t('row.remove', 'Remove')}>
                <Undo2 className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </div>

        {/* Desktop: Actions */}
        <div className="hidden sm:flex items-center gap-2 flex-shrink-0">
          {overseerrLink && (
            <a
              href={overseerrLink}
              target="_blank"
              rel="noopener noreferrer"
              className="p-2 rounded hover:bg-surface-700 transition-colors"
              title={t('row.viewInSeerr', 'View in Seerr')}
            >
              <ExternalLink className="w-4 h-4 text-violet-text" />
            </a>
          )}
          <Button variant="danger" size="sm" onClick={onDeleteNow} disabled={!hasArrService || jobActive} title={hasArrService ? t('row.deleteNow', 'Delete now') : t('row.deleteNowDisabled', 'Configure Sonarr/Radarr in Settings to enable deletion')}>
            <Trash2 className="w-4 h-4" />
          </Button>
          {!isEpisode && (
            <Button variant="ghost" size="sm" onClick={onProtect} disabled={jobActive} title={t('row.protect', 'Protect')}>
              <Shield className="w-4 h-4 text-accent-text" />
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onRemove} disabled={jobActive} title={t('row.removeFromQueue', 'Remove from queue')}>
            <Undo2 className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </div>
  );
});
