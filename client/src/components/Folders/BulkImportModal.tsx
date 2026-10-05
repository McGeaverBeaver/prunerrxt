import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/common/Button';
import { Badge } from '@/components/common/Badge';
import { useToast } from '@/components/common/Toast';
import { useQualityProfiles, useQueueFolderJobs } from '@/hooks/useApi';
import { foldersApi } from '@/services/api';
import { formatBytes, cn } from '@/lib/utils';
import type { ImportConfidence, ImportSuggestion, OrphanFolder } from '@/types';

/** The server matches this many folders per request; the modal walks the rest. */
const CHUNK = 50;

interface Props {
  folders: OrphanFolder[];
  onClose: () => void;
  onQueued: () => void;
}

/**
 * Review step before a bulk import: the server's best match per folder with
 * a confidence grade. Exact and likely matches are ticked, weak ones are not,
 * and anything can be flipped before the imports are queued.
 */
export function BulkImportModal({ folders, onClose, onQueued }: Props) {
  const { t } = useTranslation('folders');
  const { addToast } = useToast();
  const [suggestions, setSuggestions] = useState<ImportSuggestion[]>([]);
  const [matched, setMatched] = useState(0);
  const [matching, setMatching] = useState(true);
  const [matchError, setMatchError] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [monitored, setMonitored] = useState(true);
  const [profile, setProfile] = useState<{ radarr: number | null; sonarr: number | null }>({ radarr: null, sonarr: null });
  const radarrProfiles = useQualityProfiles('radarr');
  const sonarrProfiles = useQualityProfiles('sonarr');
  const queue = useQueueFolderJobs();
  // The selection as it was when the modal opened; the parent re-renders as
  // jobs stream in and must not restart the matching.
  const [ids] = useState(() => folders.map((f) => f.id));

  // Match in chunks so a few hundred folders show progress instead of one long wait.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        for (let i = 0; i < ids.length; i += CHUNK) {
          const batch = await foldersApi.importPreview(ids.slice(i, i + CHUNK));
          if (cancelled) return;
          setSuggestions((prev) => [...prev, ...batch]);
          setChecked((prev) => {
            const next = new Set(prev);
            for (const s of batch) if (s.candidate && (s.confidence === 'exact' || s.confidence === 'likely')) next.add(s.folderId);
            return next;
          });
          setMatched(Math.min(ids.length, i + CHUNK));
        }
      } catch (error) {
        if (!cancelled) setMatchError(error instanceof Error ? error.message : String(error));
      } finally {
        if (!cancelled) setMatching(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ids]);

  const counts = useMemo(() => {
    const c: Record<ImportConfidence, number> = { exact: 0, likely: 0, weak: 0, none: 0 };
    for (const s of suggestions) c[s.confidence] += 1;
    return c;
  }, [suggestions]);

  const selected = suggestions.filter((s) => checked.has(s.folderId) && s.candidate);
  const services = new Set(selected.map((s) => s.service));
  const toggle = (id: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const setLevel = (levels: ImportConfidence[]) =>
    setChecked(new Set(suggestions.filter((s) => s.candidate && levels.includes(s.confidence)).map((s) => s.folderId)));

  const submit = async () => {
    try {
      let queued = 0;
      let skipped = 0;
      for (const service of ['radarr', 'sonarr'] as const) {
        const mine = selected.filter((s) => s.service === service);
        if (mine.length === 0) continue;
        const result = await queue.mutateAsync({
          action: 'import',
          folders: mine.map((s) => ({ id: s.folderId, params: { candidateId: s.candidate!.id } })),
          params: { monitored, qualityProfileId: profile[service] ?? undefined },
        });
        queued += result.queued.length;
        skipped += result.skipped.length + result.alreadyQueued;
      }
      addToast({
        type: 'success',
        title: t('bulkImport.queuedTitle', 'Imports queued'),
        message: t('bulkImport.queuedMsg', '{{count}} folders are being imported in the background{{skipped}}', { count: queued, skipped: skipped > 0 ? t('bulkImport.skippedSuffix', ', {{count}} skipped', { count: skipped }) : '' }),
      });
      onQueued();
    } catch (error) {
      addToast({ type: 'error', title: t('bulkImport.queueFailed', 'Could not queue imports'), message: error instanceof Error ? error.message : String(error) });
    }
  };

  const confidenceBadge = (c: ImportConfidence) => {
    const variant = c === 'exact' ? 'success' : c === 'likely' ? 'accent' : c === 'weak' ? 'warning' : 'muted';
    const label = c === 'exact' ? t('bulkImport.exact', 'exact') : c === 'likely' ? t('bulkImport.likely', 'likely') : c === 'weak' ? t('bulkImport.weak', 'check') : t('bulkImport.none', 'no match');
    return <Badge variant={variant} size="sm">{label}</Badge>;
  };

  return (
    <Modal isOpen onClose={() => !queue.isPending && onClose()} title={t('bulkImport.title', 'Import {{count}} folders', { count: ids.length })} size="4xl">
      <div className="space-y-4">
        <p className="text-sm text-surface-400">
          {t('bulkImport.intro', 'Each folder is matched against the catalogue of the app that owns it. Exact and likely matches are ticked; look at the rest before ticking them. Imports run in the background, one at a time per app.')}
        </p>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          {matching ? (
            <span className="flex items-center gap-1.5 text-surface-400">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-accent-text" />
              {t('bulkImport.matching', 'Matched {{done}} of {{total}}…', { done: matched, total: ids.length })}
            </span>
          ) : (
            <span className="text-surface-400">
              {t('bulkImport.summary', '{{exact}} exact, {{likely}} likely, {{weak}} to check, {{none}} without a match', counts)}
            </span>
          )}
          <span className="ml-auto flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={() => setLevel(['exact'])}>{t('bulkImport.onlyExact', 'Only exact')}</Button>
            <Button variant="ghost" size="sm" onClick={() => setLevel(['exact', 'likely'])}>{t('bulkImport.exactLikely', 'Exact + likely')}</Button>
            <Button variant="ghost" size="sm" onClick={() => setLevel(['exact', 'likely', 'weak'])}>{t('bulkImport.everything', 'Everything matched')}</Button>
            <Button variant="ghost" size="sm" onClick={() => setChecked(new Set())}>{t('bulkImport.nothing', 'None')}</Button>
          </span>
        </div>
        {matchError && <p className="text-sm text-ruby-text">{matchError}</p>}

        <div className="max-h-[50vh] overflow-y-auto rounded-lg border border-surface-700/50">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-surface-900 text-left text-xs uppercase tracking-wider text-surface-500">
              <tr>
                <th className="w-8 px-3 py-2" />
                <th className="px-3 py-2">{t('bulkImport.colFolder', 'Folder')}</th>
                <th className="px-3 py-2">{t('bulkImport.colMatch', 'Will be imported as')}</th>
                <th className="px-3 py-2">{t('bulkImport.colConfidence', 'Match')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-800">
              {suggestions.map((s) => {
                const on = checked.has(s.folderId);
                const disabled = !s.candidate;
                return (
                  <tr key={s.folderId} className={cn(disabled && 'opacity-60', on && 'bg-accent-500/5')} onClick={() => !disabled && toggle(s.folderId)}>
                    <td className="px-3 py-2">
                      <input type="checkbox" checked={on} disabled={disabled} onChange={() => toggle(s.folderId)} onClick={(e) => e.stopPropagation()} className="h-4 w-4 rounded-sm border-surface-600 bg-surface-700 text-accent-500 focus:ring-accent-500" />
                    </td>
                    <td className="max-w-xs px-3 py-2">
                      <p className="truncate text-surface-100" title={s.path}>{s.name}</p>
                      <p className="truncate text-2xs text-surface-500">
                        {s.serviceLabel}
                        {s.sizeBytes !== null && ` · ${formatBytes(s.sizeBytes)}`}
                      </p>
                    </td>
                    <td className="max-w-sm px-3 py-2">
                      {s.candidate ? (
                        <p className="truncate text-surface-100">
                          {s.candidate.title} {s.candidate.year && <span className="text-surface-400">({s.candidate.year})</span>}
                          <span className="ml-1 text-2xs text-surface-500">{s.service === 'radarr' ? 'TMDB' : 'TVDB'} {s.candidate.id}</span>
                        </p>
                      ) : (
                        <p className="text-surface-500">—</p>
                      )}
                      <p className="truncate text-2xs text-surface-500" title={s.reason}>{s.reason}</p>
                    </td>
                    <td className="px-3 py-2">{confidenceBadge(s.confidence)}</td>
                  </tr>
                );
              })}
              {suggestions.length === 0 && matching && (
                <tr>
                  <td colSpan={4} className="px-3 py-8 text-center text-sm text-surface-500">{t('bulkImport.firstChunk', 'Asking Sonarr and Radarr…')}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          {services.has('radarr') && (
            <ProfileSelect label={t('bulkImport.radarrProfile', 'Radarr quality profile')} profiles={radarrProfiles.data ?? []} value={profile.radarr} onChange={(v) => setProfile({ ...profile, radarr: v })} />
          )}
          {services.has('sonarr') && (
            <ProfileSelect label={t('bulkImport.sonarrProfile', 'Sonarr quality profile')} profiles={sonarrProfiles.data ?? []} value={profile.sonarr} onChange={(v) => setProfile({ ...profile, sonarr: v })} />
          )}
          <label className="flex items-center gap-2 pb-2 text-sm text-surface-300">
            <input type="checkbox" checked={monitored} onChange={(e) => setMonitored(e.target.checked)} className="h-4 w-4 rounded-sm border-surface-600 bg-surface-700 text-accent-500 focus:ring-accent-500" />
            {t('importModal.monitored', 'Monitor after import')}
          </label>
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <Button variant="secondary" onClick={onClose} disabled={queue.isPending}>{t('importModal.cancel', 'Cancel')}</Button>
          <Button onClick={() => void submit()} disabled={selected.length === 0 || queue.isPending || matching}>
            {queue.isPending ? t('bulkImport.queueing', 'Queueing…') : t('bulkImport.confirm', 'Queue {{count}} imports', { count: selected.length })}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function ProfileSelect({ label, profiles, value, onChange }: { label: string; profiles: Array<{ id: number; name: string }>; value: number | null; onChange: (v: number) => void }) {
  return (
    <label className="flex-1 text-sm">
      <span className="mb-1 block text-xs font-medium text-surface-400">{label}</span>
      <select
        value={value ?? profiles[0]?.id ?? ''}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full rounded-lg border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-surface-50 focus:outline-hidden focus:ring-2 focus:ring-accent-500/50"
      >
        {profiles.map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>
    </label>
  );
}
