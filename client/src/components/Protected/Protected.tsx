import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Archive, ArchiveRestore, ChevronLeft, ChevronRight, Film, Layers, RotateCw, Search, Shield, ShieldCheck, ShieldOff, Tv } from 'lucide-react';

import { Card } from '@/components/common/Card';
import { Badge } from '@/components/common/Badge';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { EmptyState } from '@/components/common/EmptyState';
import { ErrorState } from '@/components/common/ErrorState';
import { useToast } from '@/components/common/Toast';
import { AvailabilityBadge } from '@/components/common/AvailabilityBadge';
import { useAvailabilityText } from '@/lib/availabilityText';
import { useCheckItemAvailability, useLibrary, useUnprotectItem } from '@/hooks/useApi';
import { collectionsApi } from '@/services/api';
import { cn, formatBytes, formatDate, formatRelativeTime } from '@/lib/utils';
import { libraryItemPath } from '@/lib/links';
import type { LibraryFilters, MediaItem } from '@/types';

type Tab = 'protected' | 'archived' | 'collections';
const TABS: Tab[] = ['protected', 'archived', 'collections'];
const PAGE_SIZE = 25;

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const handle = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(handle);
  }, [value, delay]);
  return debounced;
}

/**
 * Everything Prunerr has promised to leave alone, in one place: titles
 * protected by hand (or by an exclusion pattern), titles Archive kept because
 * they could not be downloaded again, and collections whose protection covers
 * their members. Each row says why and since when, and can be released here.
 */
export default function Protected() {
  const { t } = useTranslation('protected');
  const { addToast } = useToast();
  const [params, setParams] = useSearchParams();
  const tabParam = params.get('tab');
  const tab: Tab = TABS.includes(tabParam as Tab) ? (tabParam as Tab) : 'protected';
  const setTab = (next: Tab) => {
    setParams(next === 'protected' ? {} : { tab: next }, { replace: true });
    setPage(1);
    setSelected(new Set());
  };

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search, 300);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Both item tabs are one library query with a different status filter; the
  // counts for the tab labels come from the same endpoint with limit 1.
  const listFilters = (status: 'protected' | 'archived', limit: number, pageNo: number): LibraryFilters => ({
    status,
    search: debouncedSearch || undefined,
    page: pageNo,
    limit,
    sortBy: 'title',
    sortOrder: 'asc',
  });
  const protectedCount = useLibrary({ status: 'protected', page: 1, limit: 1, sortBy: 'title', sortOrder: 'asc' });
  const archivedCount = useLibrary({ status: 'archived', page: 1, limit: 1, sortBy: 'title', sortOrder: 'asc' });
  const items = useLibrary(listFilters(tab === 'archived' ? 'archived' : 'protected', PAGE_SIZE, page));
  const collections = useQuery({ queryKey: ['collections'], queryFn: collectionsApi.list });
  const protectedCollections = useMemo(() => (collections.data ?? []).filter((c) => c.isProtected), [collections.data]);

  const unprotect = useUnprotectItem();
  const recheck = useCheckItemAvailability();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [releasing, setReleasing] = useState(false);

  const release = (item: MediaItem) => {
    setBusyId(item.id);
    unprotect.mutate(item.id, {
      onSuccess: () => {
        addToast({
          type: 'success',
          title: item.archivedAt ? t('toasts.unarchived', 'Unarchived') : t('toasts.unprotected', 'Protection removed'),
          message: t('toasts.releasedMsg', '"{{title}}" can be considered by rules again.', { title: item.title }),
        });
        items.refetch();
        protectedCount.refetch();
        archivedCount.refetch();
      },
      onError: (error) => addToast({ type: 'error', title: t('toasts.failed', 'Could not update'), message: error instanceof Error ? error.message : String(error) }),
      onSettled: () => setBusyId(null),
    });
  };

  const releaseSelected = async () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    setReleasing(true);
    let ok = 0;
    for (const id of ids) {
      try {
        await unprotect.mutateAsync(id);
        ok += 1;
      } catch {
        /* reported in the summary */
      }
    }
    setReleasing(false);
    setSelected(new Set());
    addToast({
      type: ok === ids.length ? 'success' : 'warning',
      title: t('toasts.bulkTitle', 'Protection removed'),
      message: t('toasts.bulkMsg', '{{ok}} of {{total}} released', { ok, total: ids.length }),
    });
    items.refetch();
    protectedCount.refetch();
    archivedCount.refetch();
  };

  const runRecheck = (item: MediaItem) => {
    setBusyId(item.id);
    recheck.mutate(item.id, {
      onSuccess: (result) => {
        addToast({ type: result.report.verdict === 'replaceable' ? 'success' : 'warning', title: t('toasts.checked', 'Availability checked'), message: result.message || item.title });
        items.refetch();
      },
      onError: (error) => addToast({ type: 'error', title: t('toasts.checkFailed', 'Check failed'), message: error instanceof Error ? error.message : String(error) }),
      onSettled: () => setBusyId(null),
    });
  };

  const rows = items.data?.items ?? [];
  const total = items.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)));
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const tabLabel: Record<Tab, string> = {
    protected: t('tabs.protected', 'Protected'),
    archived: t('tabs.archived', 'Archived'),
    collections: t('tabs.collections', 'Collections'),
  };
  const tabCount: Record<Tab, number | undefined> = {
    protected: protectedCount.data?.total,
    archived: archivedCount.data?.total,
    collections: collections.data ? protectedCollections.length : undefined,
  };
  const tabIcon: Record<Tab, typeof Shield> = { protected: Shield, archived: Archive, collections: Layers };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center gap-4 sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-surface-50">{t('header.title', 'Protected')}</h1>
          <p className="text-surface-400 mt-1 text-sm sm:text-base">
            {t('header.subtitle', 'Titles and collections no rule, scan or deletion will touch')}
          </p>
        </div>
        {selected.size > 0 && tab !== 'collections' && (
          <Button variant="secondary" onClick={releaseSelected} disabled={releasing} isLoading={releasing}>
            <ShieldOff className="w-4 h-4 mr-2" />
            {tab === 'archived'
              ? t('actions.unarchiveSelected', 'Unarchive selected ({{count}})', { count: selected.size })
              : t('actions.unprotectSelected', 'Remove protection ({{count}})', { count: selected.size })}
          </Button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap items-center gap-2" role="tablist">
        {TABS.map((id) => {
          const Icon = tabIcon[id];
          const active = tab === id;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(id)}
              className={cn(
                'inline-flex items-center gap-2 rounded-xl border px-3.5 py-2 text-sm font-medium transition-colors',
                active ? 'bg-accent-500/10 text-accent-text border-accent-500/20' : 'border-surface-700/70 text-surface-400 hover:text-surface-100 hover:bg-surface-800/60'
              )}
            >
              <Icon className="w-4 h-4" />
              {tabLabel[id]}
              {tabCount[id] !== undefined && (
                <span className={cn('rounded-full px-2 py-0.5 text-xs', active ? 'bg-accent-500/15' : 'bg-surface-800 text-surface-400')}>{tabCount[id]}</span>
              )}
            </button>
          );
        })}
      </div>

      {tab === 'collections' ? (
        <CollectionsTab collections={protectedCollections} isLoading={collections.isLoading} isError={collections.isError} refetch={() => collections.refetch()} />
      ) : (
        <>
          <div className="relative max-w-md">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-surface-500" />
            <Input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder={t('search.placeholder', 'Search titles…')}
              className="pl-9"
              aria-label={t('search.placeholder', 'Search titles…')}
            />
          </div>

          {items.isError ? (
            <ErrorState error={items.error} retry={() => void items.refetch()} />
          ) : items.isLoading ? (
            <Card className="p-8 text-center text-sm text-surface-400">{t('loading', 'Loading…')}</Card>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={tab === 'archived' ? Archive : ShieldCheck}
              title={
                debouncedSearch
                  ? t('empty.searchTitle', 'Nothing matches')
                  : tab === 'archived'
                    ? t('empty.archivedTitle', 'Nothing archived yet')
                    : t('empty.protectedTitle', 'Nothing protected yet')
              }
              description={
                debouncedSearch
                  ? t('empty.searchDesc', 'No {{tab}} title matches "{{search}}".', { tab: tabLabel[tab].toLowerCase(), search: debouncedSearch })
                  : tab === 'archived'
                    ? t('empty.archivedDesc', 'Archive keeps titles here when they could not be downloaded again. Pick Archive on a queued item, or let the Archive automatically mode do it.')
                    : t('empty.protectedDesc', 'Protect a title from its page, the library grid or the queue, and it shows up here.')
              }
            />
          ) : (
            <Card className="overflow-hidden">
              <div className="flex items-center gap-3 border-b border-surface-800 px-4 py-2.5 text-xs text-surface-400">
                <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label={t('selectAll', 'Select all on this page')} className="h-4 w-4 rounded border-surface-600 bg-surface-700 text-accent-500 focus:ring-accent-500" />
                <span>{t('count', '{{count}} titles', { count: total })}</span>
              </div>
              <ul className="divide-y divide-surface-800">
                {rows.map((item) => (
                  <ProtectedRow
                    key={item.id}
                    item={item}
                    selected={selected.has(item.id)}
                    onToggle={() => toggle(item.id)}
                    onRelease={() => release(item)}
                    onRecheck={() => runRecheck(item)}
                    busy={busyId === item.id}
                    archivedTab={tab === 'archived'}
                  />
                ))}
              </ul>
            </Card>
          )}

          {total > PAGE_SIZE && (
            <div className="flex items-center justify-between">
              <p className="text-sm text-surface-400">
                {t('pagination', 'Showing {{from}}–{{to}} of {{total}}', { from: (page - 1) * PAGE_SIZE + 1, to: Math.min(page * PAGE_SIZE, total), total })}
              </p>
              <div className="flex items-center gap-1">
                <button type="button" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} className="btn-ghost p-2" aria-label={t('prev', 'Previous page')}>
                  <ChevronLeft className="w-5 h-5" />
                </button>
                <span className="px-2 text-sm text-surface-300">
                  {page} / {totalPages}
                </span>
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

function ProtectedRow({
  item,
  selected,
  onToggle,
  onRelease,
  onRecheck,
  busy,
  archivedTab,
}: {
  item: MediaItem;
  selected: boolean;
  onToggle: () => void;
  onRelease: () => void;
  onRecheck: () => void;
  busy: boolean;
  archivedTab: boolean;
}) {
  const { t } = useTranslation('protected');
  const { reasonLine } = useAvailabilityText();
  const TypeIcon = item.type === 'movie' ? Film : Tv;
  const since = item.archivedAt ?? item.protectedAt ?? null;
  const viaCollection = !item.protectionReason && item.protectedByCollection;

  return (
    <li className="flex items-start gap-3 px-4 py-3 hover:bg-surface-800/30 transition-colors sm:items-center">
      <input type="checkbox" checked={selected} onChange={onToggle} className="mt-1 h-4 w-4 rounded border-surface-600 bg-surface-700 text-accent-500 focus:ring-accent-500 sm:mt-0" aria-label={item.title} />
      <Link to={libraryItemPath(item.id) ?? '#'} className="flex-shrink-0">
        {item.posterUrl ? (
          <img src={item.posterUrl} alt="" className="h-14 w-10 rounded object-cover" loading="lazy" decoding="async" />
        ) : (
          <div className="flex h-14 w-10 items-center justify-center rounded bg-surface-800">
            <TypeIcon className="h-5 w-5 text-surface-600" />
          </div>
        )}
      </Link>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link to={libraryItemPath(item.id) ?? '#'} className="truncate text-sm font-medium text-surface-50 hover:text-accent-text-hover transition-colors">
            {item.title}
          </Link>
          {item.year && <span className="text-xs text-surface-500">{item.year}</span>}
          <Badge variant={item.type} size="sm">{item.type}</Badge>
          {item.archivedAt ? (
            <Badge variant="accent" size="sm"><Archive className="w-3 h-3" />{t('badges.archived', 'Archived')}</Badge>
          ) : (
            <Badge variant="success" size="sm"><Shield className="w-3 h-3" />{t('badges.protected', 'Protected')}</Badge>
          )}
          {archivedTab && <AvailabilityBadge report={item.availability} className="text-[11px]" />}
        </div>
        <p className="mt-0.5 truncate text-xs text-surface-400" title={item.protectionReason ?? undefined}>
          {viaCollection
            ? t('row.viaCollection', 'Protected via collection "{{title}}"', { title: item.protectedByCollection!.title })
            : item.protectionReason || t('row.noReason', 'Manually protected')}
          {archivedTab && item.availability ? ` · ${reasonLine(item.availability)}` : ''}
        </p>
        <p className="mt-0.5 text-xs text-surface-500">
          {formatBytes(item.size)}
          {since ? ` · ${t('row.since', 'since {{time}}', { time: formatRelativeTime(since) })} (${formatDate(since)})` : ''}
        </p>
      </div>
      <div className="flex flex-shrink-0 items-center gap-1">
        {archivedTab && (
          <Button variant="ghost" size="sm" onClick={onRecheck} disabled={busy} title={t('row.recheck', 'Ask Radarr/Sonarr again')}>
            <RotateCw className={cn('w-4 h-4', busy && 'animate-spin')} />
          </Button>
        )}
        {viaCollection ? (
          <Link to={`/collections/${item.protectedByCollection!.id}`} className="btn-ghost px-2 py-1 text-xs">
            {t('row.openCollection', 'Open collection')}
          </Link>
        ) : (
          <Button variant="ghost" size="sm" onClick={onRelease} disabled={busy} title={item.archivedAt ? t('row.unarchive', 'Unarchive') : t('row.unprotect', 'Remove protection')}>
            {item.archivedAt ? <ArchiveRestore className="w-4 h-4" /> : <ShieldOff className="w-4 h-4" />}
          </Button>
        )}
      </div>
    </li>
  );
}

function CollectionsTab({
  collections,
  isLoading,
  isError,
  refetch,
}: {
  collections: Awaited<ReturnType<typeof collectionsApi.list>>;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
}) {
  const { t } = useTranslation('protected');
  if (isError) return <ErrorState error={new Error(t('collections.error', 'Could not load collections'))} retry={refetch} />;
  if (isLoading) return <Card className="p-8 text-center text-sm text-surface-400">{t('loading', 'Loading…')}</Card>;
  if (collections.length === 0) {
    return (
      <EmptyState
        icon={Layers}
        title={t('empty.collectionsTitle', 'No protected collections')}
        description={t('empty.collectionsDesc', 'Protect a collection on the Collections page and every title in it is shielded at once.')}
      />
    );
  }
  return (
    <Card className="overflow-hidden">
      <ul className="divide-y divide-surface-800">
        {collections.map((c) => (
          <li key={c.id} className="flex items-center gap-3 px-4 py-3 hover:bg-surface-800/30 transition-colors">
            {c.posterUrl ? (
              <img src={c.posterUrl} alt="" className="h-14 w-10 rounded object-cover" loading="lazy" decoding="async" />
            ) : (
              <div className="flex h-14 w-10 items-center justify-center rounded bg-surface-800">
                <Layers className="h-5 w-5 text-surface-600" />
              </div>
            )}
            <div className="min-w-0 flex-1">
              <Link to={`/collections/${c.id}`} className="truncate text-sm font-medium text-surface-50 hover:text-accent-text-hover transition-colors">
                {c.title}
              </Link>
              <p className="mt-0.5 text-xs text-surface-400">
                {t('collections.items', '{{count}} titles', { count: c.itemCount })}
                {c.protectionReason ? ` · ${c.protectionReason}` : ''}
              </p>
            </div>
            <Link to={`/collections/${c.id}`} className="btn-ghost px-2 py-1 text-xs">
              {t('row.openCollection', 'Open collection')}
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}
