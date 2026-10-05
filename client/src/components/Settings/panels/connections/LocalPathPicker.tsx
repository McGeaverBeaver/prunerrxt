import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, ChevronRight, FolderOpen, PencilLine } from 'lucide-react';

import { Input } from '@/components/common/Input';
import { cn } from '@/lib/utils';
import type { ContainerMount } from '@/types';

/** The mount a path lives on, by longest mount point prefix. */
function mountFor(path: string, mounts: ContainerMount[]): ContainerMount | undefined {
  let best: ContainerMount | undefined;
  for (const m of mounts) {
    if (path === m.mountPoint || path.startsWith(`${m.mountPoint}/`)) {
      if (!best || m.mountPoint.length > best.mountPoint.length) best = m;
    }
  }
  return best;
}

/** Direct children of `parent` among a mount's listed subfolders (one more path segment, no deeper). */
function childrenOf(parent: string, mount: ContainerMount): string[] {
  const prefix = parent === '/' ? '/' : `${parent}/`;
  return mount.subfolders.filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'));
}

function basename(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx === -1 ? p : p.slice(idx + 1) || p;
}

/**
 * The PrunerrXT side of a mapping: a dropdown of the volumes mounted into the
 * container. Only the mount roots show at first; a chevron on a row unfolds
 * its subfolders (two levels are known), so a volume with hundreds of movie
 * folders stays one line until it is opened. "Type a path…" switches to a
 * plain text field for anything deeper. Without any detected mounts (not
 * Linux, or nothing mounted) it is the text field it always was.
 */
export function LocalPathPicker({ value, onChange, mounts }: { value: string; onChange: (path: string) => void; mounts: ContainerMount[] }) {
  const { t } = useTranslation('settings');
  const known = useMemo(() => mounts.some((m) => m.mountPoint === value || m.subfolders.includes(value)), [mounts, value]);
  // Stays in free-text mode once chosen, even while the typed value happens to match an option.
  const [custom, setCustom] = useState(() => value !== '' && !known);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    // Open the branch that holds the current value, so it is visible on first open.
    const set = new Set<string>();
    const parts = value.split('/').filter(Boolean);
    for (let i = 1; i < parts.length; i++) set.add(`/${parts.slice(0, i).join('/')}`);
    return set;
  });
  const rootRef = useRef<HTMLDivElement>(null);
  const placeholder = t('mediaFolders.localPlaceholder', 'Path as PrunerrXT sees it, e.g. /media/movies');

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (mounts.length === 0) {
    return <Input placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} className="font-mono text-sm" aria-label={placeholder} />;
  }

  const showCustom = custom || (value !== '' && !known);
  const onMount = mountFor(value, mounts);

  const toggleExpanded = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const choose = (path: string) => {
    setCustom(false);
    onChange(path);
    setOpen(false);
  };

  const renderRow = (path: string, mount: ContainerMount, depth: number) => {
    const children = depth < 2 ? childrenOf(path, mount) : [];
    const isOpen = expanded.has(path);
    const selected = path === value;
    const label = depth === 0 ? path : basename(path);
    return (
      <li key={path}>
        <div
          className={cn(
            'flex items-center gap-1 rounded-lg pr-2 text-[13px] transition-colors',
            selected ? 'bg-accent-500/15 text-accent-text' : 'text-surface-100 hover:bg-surface-800/70'
          )}
          style={{ paddingLeft: `${depth * 18 + 4}px` }}
        >
          {children.length > 0 ? (
            <button
              type="button"
              onClick={() => toggleExpanded(path)}
              aria-expanded={isOpen}
              aria-label={isOpen ? t('mediaFolders.collapse', 'Hide subfolders of {{path}}', { path }) : t('mediaFolders.expand', 'Show {{count}} subfolders of {{path}}', { count: children.length, path })}
              className="flex h-8 w-7 shrink-0 items-center justify-center rounded-md text-surface-400 hover:bg-surface-700/60 hover:text-surface-100"
            >
              {isOpen ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />}
            </button>
          ) : (
            <span className="w-7 shrink-0" aria-hidden />
          )}
          <button type="button" onClick={() => choose(path)} className="flex min-h-[34px] min-w-0 flex-1 items-center gap-2 text-left">
            <span className="truncate font-mono">{label}</span>
            {depth === 0 && (
              <span className="shrink-0 text-[10.5px] text-surface-500">
                {mount.readOnly ? t('mediaFolders.mounts.readOnly', 'read-only') : t('mediaFolders.mounts.readWrite', 'read-write')}
                {mount.fsType ? ` · ${mount.fsType}` : ''}
              </span>
            )}
            {children.length > 0 && !isOpen && (
              <span className="shrink-0 text-[10.5px] text-surface-500">{t('mediaFolders.childCount', '{{count}} folders', { count: children.length })}</span>
            )}
            {selected && <Check className="ml-auto h-3.5 w-3.5 shrink-0" aria-hidden />}
          </button>
        </div>
        {isOpen && children.length > 0 && (
          <ul>
            {children.map((child) => renderRow(child, mount, depth + 1))}
            {depth === 0 && mount.truncated && (
              <li className="py-1 pl-10 text-[11px] text-surface-500">{t('mediaFolders.truncated', 'Only the first folders are listed; type a deeper path if yours is missing.')}</li>
            )}
          </ul>
        )}
      </li>
    );
  };

  return (
    <div ref={rootRef} className="relative flex min-w-0 flex-1 flex-col gap-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={placeholder}
        className={cn(
          'flex w-full items-center gap-2 rounded-xl border border-surface-600/50 bg-surface-800/60 px-3 py-2.5 text-left font-mono text-sm',
          'focus:outline-hidden focus:ring-2 focus:ring-accent-500/20 focus:border-accent-500/50',
          value ? 'text-surface-50' : 'text-surface-500'
        )}
      >
        <FolderOpen className="h-4 w-4 shrink-0 text-surface-400" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{value || t('mediaFolders.pickPath', 'Choose a mounted folder…')}</span>
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-surface-400 transition-transform', open && 'rotate-180')} aria-hidden />
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-xl border border-surface-700/70 bg-surface-900 shadow-xl shadow-black/30">
          <ul role="listbox" className="max-h-80 overflow-y-auto p-1.5">
            {mounts.map((m) => renderRow(m.mountPoint, m, 0))}
          </ul>
          <button
            type="button"
            onClick={() => {
              setCustom(true);
              setOpen(false);
            }}
            className="flex w-full items-center gap-2 border-t border-surface-700/60 px-3 py-2.5 text-left text-[12.5px] text-surface-300 hover:bg-surface-800/70 hover:text-surface-50"
          >
            <PencilLine className="h-3.5 w-3.5" aria-hidden />
            {t('mediaFolders.customPath', 'Type a path…')}
          </button>
        </div>
      )}

      {showCustom && (
        <Input placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} className="font-mono text-sm" aria-label={placeholder} autoFocus />
      )}
      {onMount?.readOnly && (
        <p className="text-xs text-accent-text">
          {t('mediaFolders.readOnlyHint', 'This volume is mounted read-only: folders under it can be measured but not deleted. Mount it read-write to enable deletion.')}
        </p>
      )}
    </div>
  );
}
