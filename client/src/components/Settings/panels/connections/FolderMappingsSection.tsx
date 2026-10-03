import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2, Save } from 'lucide-react';

import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { useToast } from '@/components/common/Toast';
import { useFolderMappings, useFolderPermissions, useOrphanFolders, useSaveFolderMappings, useSavePermissionSettings } from '@/hooks/useApi';
import { Toggle } from '../../components/Toggle';
import type { FolderMapping } from '@/types';

import { PanelSection } from '../../components/PanelSection';
import { SettingsCard } from '../../components/SettingsCard';
import type { PanelProps } from '../../types';

/**
 * Where Prunerr can see the media that Sonarr and Radarr manage. A mapping
 * pairs a root folder as the app sees it with the same location as Prunerr
 * sees it, which is what lets the Folders page measure and delete unmanaged
 * folders instead of only listing them.
 */
export function FolderMappingsSection({ registerSection }: { registerSection: PanelProps['registerSection'] }) {
  const { t } = useTranslation('settings');
  const { addToast } = useToast();
  const saved = useFolderMappings();
  const save = useSaveFolderMappings();
  const listing = useOrphanFolders(true);
  const [rows, setRows] = useState<FolderMapping[]>([]);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (saved.data && !dirty) setRows(saved.data);
  }, [saved.data, dirty]);

  const rootFolders = (listing.data?.services ?? []).flatMap((s) => s.rootFolders.map((r) => ({ ...r, service: s.serviceLabel })));

  const update = (index: number, patch: Partial<FolderMapping>) => {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
    setDirty(true);
  };
  const remove = (index: number) => {
    setRows((prev) => prev.filter((_, i) => i !== index));
    setDirty(true);
  };
  const add = (remotePath = '') => {
    setRows((prev) => [...prev, { remotePath, localPath: '' }]);
    setDirty(true);
  };
  const persist = () => {
    save.mutate(rows, {
      onSuccess: () => {
        setDirty(false);
        addToast({ type: 'success', title: t('mediaFolders.saved', 'Folder mappings saved') });
      },
      onError: (err) => addToast({ type: 'error', title: t('mediaFolders.saveFailed', 'Could not save mappings'), message: err instanceof Error ? err.message : String(err) }),
    });
  };

  return (
    <PanelSection
      id="media-folders"
      register={registerSection}
      title={t('mediaFolders.title', 'Media folders')}
      description={t('mediaFolders.description', 'Lets Prunerr measure and delete unmanaged folders. Pair each root folder as Sonarr/Radarr see it with the path where this container sees the same files.')}
    >
      <SettingsCard>
        <div className="space-y-4">
          <p className="text-sm text-surface-400">
            {t('mediaFolders.help', 'Mount the media share into the Prunerr container (read-write if you want to delete), then map it here. Example: Radarr sees /movies, Prunerr sees /media/movies.')}
          </p>

          {rootFolders.length > 0 && (
            <div className="rounded-lg bg-surface-800/50 p-3 text-xs">
              <p className="mb-1 font-medium text-surface-300">{t('mediaFolders.rootFolders', 'Root folders reported by your apps')}</p>
              <ul className="space-y-1">
                {rootFolders.map((r) => (
                  <li key={`${r.service}:${r.path}`} className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-surface-200">{r.path}</span>
                    <span className="text-surface-500">{r.service}</span>
                    {r.localPath ? (
                      <span className="text-emerald-text">{t('mediaFolders.mappedTo', 'mapped to {{path}}', { path: r.localPath })}</span>
                    ) : (
                      <button type="button" onClick={() => add(r.path)} className="text-accent-text hover:underline">
                        {t('mediaFolders.mapThis', 'map this')}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="space-y-2">
            {rows.length === 0 && <p className="text-sm text-surface-500">{t('mediaFolders.none', 'No mappings yet. Sizes stay unknown and deletion stays off until you add one.')}</p>}
            {rows.map((row, index) => (
              <div key={index} className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <Input
                  placeholder={t('mediaFolders.remotePlaceholder', 'Path as Sonarr/Radarr see it, e.g. /movies')}
                  value={row.remotePath}
                  onChange={(e) => update(index, { remotePath: e.target.value })}
                  className="font-mono text-sm"
                />
                <span className="hidden text-surface-500 sm:inline">→</span>
                <Input
                  placeholder={t('mediaFolders.localPlaceholder', 'Path as Prunerr sees it, e.g. /media/movies')}
                  value={row.localPath}
                  onChange={(e) => update(index, { localPath: e.target.value })}
                  className="font-mono text-sm"
                />
                <Button variant="ghost" size="sm" onClick={() => remove(index)} title={t('mediaFolders.remove', 'Remove mapping')}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => add()}>
              <Plus className="h-4 w-4" />
              <span className="ml-1">{t('mediaFolders.add', 'Add mapping')}</span>
            </Button>
            <Button size="sm" onClick={persist} disabled={!dirty || save.isPending}>
              <Save className="h-4 w-4" />
              <span className="ml-1">{save.isPending ? t('mediaFolders.saving', 'Saving…') : t('mediaFolders.save', 'Save mappings')}</span>
            </Button>
          </div>
        </div>
      </SettingsCard>

      <PermissionsCard />
    </PanelSection>
  );
}

/**
 * The owner and modes Prunerr applies when it repairs a folder, and whether
 * this install is able to. Files written by other users (a DVR as root, a
 * download client as another id) are the usual reason a delete or import
 * fails with "permission denied"; repairing them first makes the end state
 * the same whether the folder is kept or removed.
 */
function PermissionsCard() {
  const { t } = useTranslation('settings');
  const { addToast } = useToast();
  const permissions = useFolderPermissions();
  const save = useSavePermissionSettings();
  const [form, setForm] = useState<{ uid: string; gid: string; dirMode: string; fileMode: string; autoFix: boolean } | null>(null);

  useEffect(() => {
    if (permissions.data && form === null) {
      const s = permissions.data.settings;
      setForm({ uid: String(s.uid), gid: String(s.gid), dirMode: s.dirMode, fileMode: s.fileMode, autoFix: s.autoFix });
    }
  }, [permissions.data, form]);

  const caps = permissions.data?.capabilities;
  const persist = () => {
    if (!form) return;
    save.mutate(
      { uid: Number(form.uid), gid: Number(form.gid), dirMode: form.dirMode, fileMode: form.fileMode, autoFix: form.autoFix },
      {
        onSuccess: () => addToast({ type: 'success', title: t('mediaFolders.permissions.saved', 'Permission settings saved') }),
        onError: (err) => addToast({ type: 'error', title: t('mediaFolders.permissions.saveFailed', 'Could not save'), message: err instanceof Error ? err.message : String(err) }),
      }
    );
  };

  return (
    <SettingsCard>
      <div className="space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-surface-50">{t('mediaFolders.permissions.title', 'Ownership and permissions')}</h3>
          <p className="mt-1 text-sm text-surface-400">
            {t('mediaFolders.permissions.help', 'What Prunerr sets when it repairs a folder: the owner (normally PUID:PGID, the same ids Sonarr and Radarr run as) and the modes. With automatic repair on, a delete or import that would fail on files owned by someone else repairs the folder first and carries on.')}
          </p>
        </div>

        {caps && (
          <p className={caps.canChown ? 'text-xs text-emerald-text' : 'text-xs text-ruby-text'}>
            {caps.canChown
              ? t('mediaFolders.permissions.capable', 'Prunerr runs as {{uid}}:{{gid}} and can change the owner and mode of files it does not own.', { uid: caps.uid, gid: caps.gid })
              : caps.reason}
          </p>
        )}

        {form && (
          <>
            <div className="grid gap-3 sm:grid-cols-4">
              <Input label={t('mediaFolders.permissions.uid', 'Owner uid')} value={form.uid} onChange={(e) => setForm({ ...form, uid: e.target.value })} inputMode="numeric" />
              <Input label={t('mediaFolders.permissions.gid', 'Group gid')} value={form.gid} onChange={(e) => setForm({ ...form, gid: e.target.value })} inputMode="numeric" />
              <Input label={t('mediaFolders.permissions.dirMode', 'Folder mode')} value={form.dirMode} onChange={(e) => setForm({ ...form, dirMode: e.target.value })} className="font-mono" />
              <Input label={t('mediaFolders.permissions.fileMode', 'File mode')} value={form.fileMode} onChange={(e) => setForm({ ...form, fileMode: e.target.value })} className="font-mono" />
            </div>
            <Toggle
              checked={form.autoFix}
              onChange={(checked) => setForm({ ...form, autoFix: checked })}
              label={t('mediaFolders.permissions.autoFix', 'Repair automatically when a delete or import hits a permission error')}
            />
            <Button size="sm" onClick={persist} disabled={save.isPending}>
              <Save className="h-4 w-4" />
              <span className="ml-1">{save.isPending ? t('mediaFolders.saving', 'Saving…') : t('mediaFolders.permissions.save', 'Save permission settings')}</span>
            </Button>
          </>
        )}
      </div>
    </SettingsCard>
  );
}

export default FolderMappingsSection;
