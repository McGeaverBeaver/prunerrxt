import { useCallback, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Trans, useTranslation } from 'react-i18next';
import { Check, Copy, Download, Eye, EyeOff, KeyRound, RefreshCw, Upload } from 'lucide-react';

import { apiKeyApi, type ApiKeyInfo } from '@/services/api';
import { useImportSettings, useVersion } from '@/hooks/useApi';
import { useToast } from '@/components/common/Toast';
import { ConfirmModal, Modal } from '@/components/common/Modal';
import { Button } from '@/components/common/Button';
import { cn } from '@/lib/utils';

import { PanelSection } from '../components/PanelSection';
import { SettingsCard } from '../components/SettingsCard';
import { SettingsEmptyState } from '../components/SettingsEmptyState';
import type { PanelProps } from '../types';
import { Toggle } from '../components/Toggle';
import { McpSection } from './system/McpSection';
import { LoginSection } from './system/LoginSection';
import { SessionsSection } from './system/SessionsSection';
import { ApiKeyUsage } from './system/ApiKeyUsage';

/** How often the usage history refreshes while the panel is open. */
const API_KEY_USAGE_REFRESH_MS = 30_000;
const API_KEY_QUERY_KEY = ['settings', 'api-key'] as const;

const MASKED_KEY = '•'.repeat(32);

/** Small outline action, sized to clear the 44px hit target on touch. */
function ActionButton({
  onClick,
  disabled,
  tone = 'default',
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  tone?: 'default' | 'destructive';
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-[10px] border px-3',
        'text-[11.5px] font-semibold transition-colors',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60',
        'disabled:cursor-not-allowed disabled:opacity-50',
        tone === 'destructive'
          ? 'border-ruby-500/30 bg-ruby-500/[0.14] text-ruby-text hover:bg-ruby-500/20'
          : 'border-surface-600/80 text-surface-200 hover:bg-surface-700/60 hover:text-surface-50'
      )}
    >
      {children}
    </button>
  );
}

/**
 * System — the API key and backup/restore, plus the version footer.
 *
 * Both sub-sections talk to their own endpoints and act immediately (a
 * regenerated key or an imported file is not something you stage), so neither
 * touches the draft or the dirty count.
 */
export default function SystemPanel({ registerSection }: PanelProps) {
  const { t } = useTranslation('settings');
  const { addToast } = useToast();

  // --- API key --------------------------------------------------------------

  const queryClient = useQueryClient();
  // Polled while the page is in the foreground so the usage history answers
  // "is anything using this key?" by watching the panel.
  const apiKeyQuery = useQuery({
    queryKey: API_KEY_QUERY_KEY,
    queryFn: apiKeyApi.get,
    refetchInterval: API_KEY_USAGE_REFRESH_MS,
    retry: false,
  });
  const apiKeyInfo: ApiKeyInfo | null = apiKeyQuery.data ?? null;
  // 'unavailable' only when the first load fails: a later refresh error keeps what we have.
  const apiKeyStatus: 'loading' | 'ready' | 'unavailable' = apiKeyInfo ? 'ready' : apiKeyQuery.isError ? 'unavailable' : 'loading';
  const setApiKeyInfo = useCallback((info: ApiKeyInfo) => queryClient.setQueryData(API_KEY_QUERY_KEY, info), [queryClient]);
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [apiKeyCopied, setApiKeyCopied] = useState(false);
  const [apiKeyLoading, setApiKeyLoading] = useState(false);
  const [showRegenerateConfirm, setShowRegenerateConfirm] = useState(false);
  const [apiKeyToggling, setApiKeyToggling] = useState(false);

  const handleToggleApiKey = useCallback(
    async (enabled: boolean) => {
      setApiKeyToggling(true);
      try {
        const info = await apiKeyApi.setEnabled(enabled);
        setApiKeyInfo(info);
        addToast({
          type: 'success',
          title: enabled
            ? t('toasts.apiKeyEnabled', 'API key access turned on')
            : t('toasts.apiKeyDisabled', 'API key access turned off'),
          message: enabled
            ? undefined
            : t('toasts.apiKeyDisabledMsg', 'Requests that send the key are refused until you turn it back on.'),
        });
      } catch {
        addToast({ type: 'error', title: t('toasts.apiKeyToggleFailed', 'Could not change API key access') });
      } finally {
        setApiKeyToggling(false);
      }
    },
    [addToast, setApiKeyInfo, t]
  );

  const handleClearApiKeyUsage = useCallback(async () => {
    try {
      const info = await apiKeyApi.clearUsage();
      setApiKeyInfo(info);
    } catch {
      addToast({ type: 'error', title: t('toasts.apiKeyUsageClearFailed', 'Could not clear the usage history') });
    }
  }, [addToast, setApiKeyInfo, t]);

  const handleRegenerateApiKey = useCallback(async () => {
    setApiKeyLoading(true);
    try {
      const result = await apiKeyApi.regenerate();
      setApiKeyInfo(result);
      setShowRegenerateConfirm(false);
      setApiKeyVisible(true);
      addToast({
        type: 'success',
        title: t('toasts.apiKeyRegeneratedTitle', 'API key regenerated'),
        message: t(
          'toasts.apiKeyRegeneratedMsg',
          'Any scripts or integrations using the old key will need to be updated.'
        ),
      });
    } catch {
      addToast({
        type: 'error',
        title: t('toasts.apiKeyRegenerateFailed', 'Failed to regenerate API key'),
      });
    } finally {
      setApiKeyLoading(false);
    }
  }, [addToast, setApiKeyInfo, t]);

  const handleCopyApiKey = useCallback(async () => {
    if (!apiKeyInfo?.apiKey) return;
    try {
      await navigator.clipboard.writeText(apiKeyInfo.apiKey);
      setApiKeyCopied(true);
      setTimeout(() => setApiKeyCopied(false), 2000);
    } catch {
      addToast({ type: 'error', title: t('toasts.copyFailed', 'Failed to copy to clipboard') });
    }
  }, [apiKeyInfo, addToast, t]);

  // --- backup & restore -----------------------------------------------------

  const importMutation = useImportSettings();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [showImportConfirm, setShowImportConfirm] = useState(false);

  const handleExport = useCallback(async () => {
    try {
      const response = await fetch('/api/settings/export');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'prunerr-settings.json';
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
    } catch (error) {
      addToast({
        type: 'error',
        title: t('backup.exportFailed', 'Export failed'),
        message: error instanceof Error ? error.message : undefined,
      });
    }
  }, [addToast, t]);

  const handleFileSelect = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      setImportFile(file);
      setShowImportConfirm(true);
    }
    // Reset the input so the same file can be picked again.
    event.target.value = '';
  }, []);

  const handleImportConfirm = useCallback(async () => {
    if (!importFile) return;
    try {
      const text = await importFile.text();
      const data = JSON.parse(text);
      await importMutation.mutateAsync(data);
      setShowImportConfirm(false);
      setImportFile(null);
    } catch {
      // Surfaced by the error banner below; the modal stays open so the file
      // name is still visible.
    }
  }, [importFile, importMutation]);

  const handleImportCancel = useCallback(() => {
    setShowImportConfirm(false);
    setImportFile(null);
  }, []);

  // --- full database backup & restore ---------------------------------------
  //
  // The settings export above carries only the settings table. This pair moves
  // the whole database: library, rules, queue and history included.

  const backupInputRef = useRef<HTMLInputElement>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [showRestoreConfirm, setShowRestoreConfirm] = useState(false);
  const [restoreBusy, setRestoreBusy] = useState(false);

  const handleDownloadBackup = useCallback(async () => {
    setBackupBusy(true);
    try {
      const response = await fetch('/api/settings/backup');
      if (!response.ok) throw new Error(await response.text());

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `prunerr-backup-${new Date().toISOString().slice(0, 10)}.db`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);

      addToast({
        type: 'success',
        title: t('backup.fullDownloaded', 'Backup downloaded'),
      });
    } catch (error) {
      addToast({
        type: 'error',
        title: t('backup.fullFailed', 'Backup failed'),
        message: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setBackupBusy(false);
    }
  }, [addToast, t]);

  const handleRestoreSelect = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      setRestoreFile(file);
      setShowRestoreConfirm(true);
    }
    event.target.value = '';
  }, []);

  const handleRestoreConfirm = useCallback(async () => {
    if (!restoreFile) return;
    setRestoreBusy(true);
    try {
      const response = await fetch('/api/settings/restore', {
        method: 'POST',
        // Streamed to disk server-side; a library database is far too big to
        // send as JSON or hold in memory.
        headers: { 'Content-Type': 'application/octet-stream' },
        body: restoreFile,
      });
      const result = await response.json();
      if (!response.ok || !result.success) {
        throw new Error(result.error || 'Restore failed');
      }

      setShowRestoreConfirm(false);
      setRestoreFile(null);
      addToast({
        type: 'success',
        title: t('backup.restoreDone', 'Database restored'),
        message: t('backup.restoreDoneHint', 'Reload the page to see the restored data.'),
      });
    } catch (error) {
      addToast({
        type: 'error',
        title: t('backup.restoreFailed', 'Restore failed'),
        message: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setRestoreBusy(false);
    }
  }, [addToast, restoreFile, t]);

  // --- version --------------------------------------------------------------

  const { data: version } = useVersion();

  return (
    <>
      <PanelSection
        id="api-key"
        register={registerSection}
        title={t('nav.sub.apiKey', 'API key')}
        description={t(
          'apiKey.description',
          'Required for external API access (scripts, nzb360, etc.). The web UI does not need it.'
        )}
      >
        <SettingsCard className="flex flex-col gap-3.5 px-[18px] py-4">
          {apiKeyStatus === 'unavailable' ? (
            <SettingsEmptyState
              title={t('apiKey.unavailableTitle', 'No API key yet')}
              body={t(
                'apiKey.unavailableBody',
                'This install has not issued an API key. External access stays disabled until one exists.'
              )}
            />
          ) : (
            <>
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="font-display text-[13.5px] font-semibold text-surface-50 flex items-center gap-2">
                    <KeyRound className="h-4 w-4 text-accent-text" aria-hidden />
                    {t('apiKey.accessTitle', 'External API access')}
                  </p>
                  <p className="mt-0.5 text-[12.5px] leading-relaxed text-surface-400">
                    {t(
                      'apiKey.accessBody',
                      'When off, every request that sends the key is refused, over the REST API and the MCP connector alike. The key is kept, so turning it back on needs no re-pasting. Signed-in users and OAuth clients are unaffected.'
                    )}
                  </p>
                </div>
                <Toggle
                  checked={apiKeyInfo?.enabled ?? true}
                  onChange={(enabled) => void handleToggleApiKey(enabled)}
                  disabled={!apiKeyInfo || apiKeyToggling}
                  label={t('apiKey.accessTitle', 'External API access')}
                />
              </div>

              {apiKeyInfo && !apiKeyInfo.enabled && (
                <p className="rounded-xl border border-surface-700/80 bg-surface-800/50 px-3.5 py-3 text-xs text-surface-400">
                  {t(
                    'apiKey.accessOff',
                    'Key access is off. Scripts, nzb360, Home Assistant and MCP clients that send the key get a 401 until you turn it back on.'
                  )}
                </p>
              )}

              {apiKeyInfo?.fromEnv && (
                <p className="rounded-xl border border-surface-700/80 bg-surface-800/50 px-3.5 py-3 text-xs text-surface-400">
                  {t(
                    'apiKey.fromEnv',
                    'This key is set by the PRUNERR_API_KEY environment variable. Change it there; regenerating here has no effect.'
                  )}
                </p>
              )}

              <p className="font-display text-[13.5px] font-semibold text-surface-50">
                {t('apiKey.yourKey', 'Your API Key')}
              </p>

              {/* basis-full is what stops the key from being squeezed into a
                  sliver beside three buttons on a phone: it takes its own row,
                  and the actions share the one below. */}
              <div className="flex flex-wrap items-center gap-2">
                <code
                  aria-label={t('apiKey.yourKey', 'Your API Key')}
                  className={cn(
                    'min-w-0 basis-full truncate rounded-[11px] border border-surface-600/60',
                    'bg-surface-800/70 px-3 py-3 font-mono text-[12.5px] tracking-[0.04em] text-surface-300',
                    'sm:flex-1 sm:basis-auto'
                  )}
                >
                  {apiKeyVisible && apiKeyInfo ? apiKeyInfo.apiKey : MASKED_KEY}
                </code>

                <ActionButton
                  onClick={() => setApiKeyVisible((visible) => !visible)}
                  disabled={!apiKeyInfo}
                >
                  {apiKeyVisible ? (
                    <EyeOff className="h-3.5 w-3.5" aria-hidden />
                  ) : (
                    <Eye className="h-3.5 w-3.5" aria-hidden />
                  )}
                  {apiKeyVisible ? t('apiKey.hideKey', 'Hide key') : t('apiKey.revealKey', 'Reveal key')}
                </ActionButton>

                <ActionButton onClick={handleCopyApiKey} disabled={!apiKeyInfo}>
                  {apiKeyCopied ? (
                    <Check className="h-3.5 w-3.5 text-emerald-text" aria-hidden />
                  ) : (
                    <Copy className="h-3.5 w-3.5" aria-hidden />
                  )}
                  {t('apiKey.copyToClipboard', 'Copy to clipboard')}
                </ActionButton>

                <ActionButton
                  tone="destructive"
                  onClick={() => setShowRegenerateConfirm(true)}
                  disabled={apiKeyLoading || Boolean(apiKeyInfo?.fromEnv)}
                >
                  <RefreshCw
                    className={cn('h-3.5 w-3.5', apiKeyLoading && 'animate-spin motion-reduce:animate-none')}
                    aria-hidden
                  />
                  {t('apiKey.regenerate', 'Regenerate')}
                </ActionButton>
              </div>

              <p className="text-[11.5px] text-surface-400">
                {t(
                  'apiKey.regenerateHint',
                  'Regenerating the key will invalidate the current one immediately.'
                )}
              </p>

              <div className="flex flex-col gap-2 rounded-xl bg-surface-800/45 px-3.5 py-3">
                <p className="font-display text-[12.5px] font-semibold text-surface-200">
                  {t('apiKey.howToTitle', 'How to use it')}
                </p>
                <p className="text-xs text-surface-300">
                  {/* Child order must stay text → <code> → text: the stored
                      translation addresses the code element as <1>. */}
                  <Trans i18nKey="apiKey.usageBody" ns="settings">
                    Include the key in the <code className="rounded bg-surface-700/50 px-1.5 py-0.5 font-mono text-[11px] text-accent-text">X-Api-Key</code> header when making API requests from external tools, scripts, or apps like nzb360.
                  </Trans>
                </p>
                <code className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg border border-surface-700/50 bg-surface-900/50 px-3 py-2 font-mono text-[11px] text-surface-300">
                  curl -H &quot;X-Api-Key: {'<your-key>'}&quot; http://{'<host>'}:{'{port}'}/api/health
                </code>
              </div>

              {apiKeyInfo?.usage && (
                <ApiKeyUsage
                  usage={apiKeyInfo.usage}
                  refreshing={apiKeyQuery.isFetching}
                  onRefresh={() => void apiKeyQuery.refetch()}
                  onClear={() => void handleClearApiKeyUsage()}
                />
              )}
            </>
          )}
        </SettingsCard>
      </PanelSection>

      <McpSection
        registerSection={registerSection}
        apiKey={apiKeyVisible && apiKeyInfo ? apiKeyInfo.apiKey : null}
        apiKeyEnabled={apiKeyInfo?.enabled ?? true}
      />

      <LoginSection registerSection={registerSection} />
      <SessionsSection registerSection={registerSection} />

      <PanelSection
        id="backup-restore"
        register={registerSection}
        title={t('nav.sub.backupRestore', 'Backup & restore')}
        description={t(
          'backup.description',
          'Take a full backup before upgrading, or restore one you took earlier'
        )}
      >
        {/* Full database backup — the one that actually protects your data. */}
        <SettingsCard className="flex flex-col gap-3.5 px-[18px] py-4">
          {/* Stacked on a phone: side by side, the buttons keep their width and
              the description collapses to one word per line. */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 sm:flex-1">
              <p className="font-display text-[13.5px] font-semibold text-surface-50">
                {t('backup.fullTitle', 'Full backup')}
              </p>
              <p className="mt-0.5 text-[12.5px] leading-relaxed text-surface-400">
                {t(
                  'backup.fullHint',
                  'The entire database — library, rules, queue, history and settings. Restoring replaces everything currently in Prunerr.'
                )}
              </p>
            </div>

            {/* Full width and stacked on a phone: side by side there is not
                enough room for both labels in English, let alone in the longer
                translations, and they wrap inside the buttons. */}
            <div className="flex flex-col gap-2 sm:flex-row sm:shrink-0 sm:items-center">
              <Button
                variant="outline"
                size="sm"
                className="min-h-[44px] w-full sm:w-auto"
                onClick={() => backupInputRef.current?.click()}
              >
                <Upload className="h-4 w-4" aria-hidden />
                {t('backup.restore', 'Restore')}
              </Button>
              <Button
                size="sm"
                className="min-h-[44px] w-full sm:w-auto"
                onClick={handleDownloadBackup}
                isLoading={backupBusy}
              >
                <Download className="h-4 w-4" aria-hidden />
                {t('backup.downloadFull', 'Download backup')}
              </Button>
            </div>
          </div>

          <input
            ref={backupInputRef}
            type="file"
            accept=".db,application/octet-stream"
            onChange={handleRestoreSelect}
            className="hidden"
            aria-hidden
            tabIndex={-1}
          />
        </SettingsCard>

        <SettingsCard className="flex flex-col gap-3.5 px-[18px] py-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 sm:flex-1">
              <p className="font-display text-[13.5px] font-semibold text-surface-50">
                {t('backup.settingsTitle', 'Settings only')}
              </p>
              <p className="mt-0.5 text-[12.5px] leading-relaxed text-surface-400">
                {t(
                  'backup.exportHint',
                  'Connections and preferences as JSON — portable between installs. Does not include your library, rules or history. Contains service credentials, so keep it safe.'
                )}
              </p>
            </div>

            <div className="flex flex-col gap-2 sm:flex-row sm:shrink-0 sm:items-center">
              <Button
                variant="outline"
                size="sm"
                className="min-h-[44px] w-full sm:w-auto"
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload className="h-4 w-4" aria-hidden />
                {t('backup.import', 'Import Settings')}
              </Button>
              <Button
                size="sm"
                className="min-h-[44px] w-full sm:w-auto"
                onClick={handleExport}
              >
                <Download className="h-4 w-4" aria-hidden />
                {t('backup.export', 'Export Settings')}
              </Button>
            </div>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            onChange={handleFileSelect}
            className="hidden"
            aria-hidden
            tabIndex={-1}
          />

          {importMutation.isError && !showImportConfirm && (
            <p className="rounded-xl border border-ruby-500/30 bg-ruby-500/10 px-3.5 py-3 text-xs text-ruby-text">
              {t('backup.importFailed', 'Import failed: {{error}}', {
                error:
                  importMutation.error instanceof Error
                    ? importMutation.error.message
                    : t('backup.invalidFormat', 'Invalid file format'),
              })}
            </p>
          )}

          {importMutation.isSuccess && !showImportConfirm && (
            <p className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-3 text-xs text-emerald-text">
              {t(
                'backup.importSuccess',
                'Settings imported successfully! The page will reload with new values.'
              )}
            </p>
          )}
        </SettingsCard>

        <div className="flex items-center justify-between rounded-[14px] border border-surface-700/80 bg-surface-800/40 px-[18px] py-3.5">
          <span className="text-[12.5px] text-surface-400">{t('system.productName', 'Prunerr')}</span>
          <span className="font-mono text-[12.5px] text-surface-300">
            {version ? `v${version}` : '—'}
          </span>
        </div>
      </PanelSection>

      <ConfirmModal
        isOpen={showRegenerateConfirm}
        onClose={() => setShowRegenerateConfirm(false)}
        onConfirm={handleRegenerateApiKey}
        isLoading={apiKeyLoading}
        variant="danger"
        title={t('apiKey.confirmTitle', 'Regenerate API Key?')}
        message={t(
          'apiKey.confirmBody',
          'This will create a new key and immediately invalidate the old one. Any scripts or integrations using the current key will stop working.'
        )}
        confirmText={
          apiKeyLoading
            ? t('apiKey.regenerating', 'Regenerating...')
            : t('apiKey.confirmRegenerate', 'Confirm Regenerate')
        }
        cancelText={t('common.cancel', 'Cancel')}
      />

      <Modal
        isOpen={showImportConfirm}
        onClose={handleImportCancel}
        size="sm"
        title={t('backup.confirmImportTitle', 'Confirm Import')}
      >
        <div className="space-y-6">
          <p className="leading-relaxed text-surface-300">
            <Trans
              i18nKey="backup.confirmImportBody"
              ns="settings"
              values={{ filename: importFile?.name ?? '' }}
            >
              Importing will overwrite all current settings with the values from <strong>{'{{filename}}'}</strong>. This action cannot be undone.
            </Trans>
          </p>
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button variant="secondary" className="min-h-[44px]" onClick={handleImportCancel}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              className="min-h-[44px]"
              onClick={handleImportConfirm}
              isLoading={importMutation.isPending}
            >
              {importMutation.isPending
                ? t('backup.importing', 'Importing...')
                : t('backup.confirmImport', 'Confirm Import')}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={showRestoreConfirm}
        onClose={() => !restoreBusy && setShowRestoreConfirm(false)}
        size="sm"
        title={t('backup.confirmRestoreTitle', 'Restore this backup?')}
      >
        <div className="space-y-6">
          <p className="leading-relaxed text-surface-300">
            <Trans
              i18nKey="backup.confirmRestoreBody"
              ns="settings"
              values={{ filename: restoreFile?.name ?? '' }}
            >
              Everything currently in Prunerr — library, rules, queue and history — will be replaced by <strong>{'{{filename}}'}</strong>.
            </Trans>
          </p>
          <p className="rounded-xl border border-surface-700/80 bg-surface-800/50 px-3.5 py-3 text-xs text-surface-400">
            {t(
              'backup.confirmRestoreSafety',
              'Your current database is saved alongside it first, so a mistake can be undone from the data folder.'
            )}
          </p>
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button
              variant="secondary"
              className="min-h-[44px]"
              disabled={restoreBusy}
              onClick={() => setShowRestoreConfirm(false)}
            >
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button className="min-h-[44px]" onClick={handleRestoreConfirm} isLoading={restoreBusy}>
              {restoreBusy
                ? t('backup.restoring', 'Restoring…')
                : t('backup.confirmRestore', 'Replace my data')}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
