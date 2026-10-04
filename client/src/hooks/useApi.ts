import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  dashboardApi,
  libraryApi,
  rulesApi,
  queueApi,
  historyApi,
  settingsApi,
  unraidApi,
  activityApi,
  healthApi,
  scanApi,
  webhooksApi,
  authSettingsApi,
  mcpApi,
  foldersApi,
  insightsApi,
} from '@/services/api';
import { mediaServerName } from '@/lib/mediaServer';
import type {
  EpisodeDeletionRequest,
  LibraryFilters,
  HistoryFilters,
  ActivityFilters,
  Rule,
  Settings,
  ServiceConnection,
  FolderMapping,
  PermissionSettings,
  FolderJobAction,
  FolderJobParams,
} from '@/types';

// Query Keys
export const queryKeys = {
  stats: ['stats'] as const,
  storageHistory: (days: number) => ['stats', 'storage-history', days] as const,
  recentActivity: ['activity', 'recent'] as const,
  upcomingDeletions: ['queue', 'upcoming'] as const,
  recommendations: (limit: number, unwatchedDays: number) => ['recommendations', limit, unwatchedDays] as const,
  library: (filters: LibraryFilters) => ['library', filters] as const,
  libraryItem: (id: string) => ['library', id] as const,
  sonarrDetail: (id: string) => ['library', id, 'sonarr'] as const,
  rules: ['rules'] as const,
  rule: (id: string) => ['rules', id] as const,
  queue: ['queue'] as const,
  history: (filters: HistoryFilters) => ['history', filters] as const,
  activityLog: (filters: ActivityFilters) => ['activity', 'log', filters] as const,
  settings: ['settings'] as const,
  unraidStats: ['unraid', 'stats'] as const,
  healthStatus: ['health', 'status'] as const,
  scanCadence: (days: number) => ['scan', 'cadence', days] as const,
  folders: (includeIgnored: boolean) => ['folders', includeIgnored] as const,
  folderMappings: ['folders', 'mappings'] as const,
  folderMounts: ['folders', 'mounts'] as const,
  insightsStack: ['insights', 'stack'] as const,
  insightsLibrary: ['insights', 'library'] as const,
  insightsWatching: ['insights', 'watching'] as const,
  insightsPlayback: ['insights', 'playback'] as const,
  insightsHistory: (days: number) => ['insights', 'history', days] as const,
  folderCandidates: (id: string, term?: string) => ['folders', 'candidates', id, term ?? ''] as const,
  qualityProfiles: (service: string) => ['folders', 'profiles', service] as const,
  folderPermissions: ['folders', 'permissions'] as const,
};

// Dashboard Hooks
export function useStats() {
  return useQuery({
    queryKey: queryKeys.stats,
    queryFn: dashboardApi.getStats,
  });
}

export function useRecentActivity() {
  return useQuery({
    queryKey: queryKeys.recentActivity,
    queryFn: dashboardApi.getRecentActivity,
    refetchInterval: 60000, // Refresh every 60 seconds
  });
}

export function useUpcomingDeletions() {
  return useQuery({
    queryKey: queryKeys.upcomingDeletions,
    queryFn: dashboardApi.getUpcomingDeletions,
  });
}

export function useStorageHistory(days = 30) {
  return useQuery({
    queryKey: queryKeys.storageHistory(days),
    queryFn: () => dashboardApi.getStorageHistory(days),
  });
}

export function useRecommendations(limit = 10, unwatchedDays = 90) {
  return useQuery({
    queryKey: queryKeys.recommendations(limit, unwatchedDays),
    queryFn: () => dashboardApi.getRecommendations(limit, unwatchedDays),
  });
}

// Library Hooks
export function useLibrary(filters: LibraryFilters) {
  return useQuery({
    queryKey: queryKeys.library(filters),
    queryFn: () => libraryApi.getItems(filters),
    placeholderData: (previousData) => previousData, // Keep showing old data while fetching
  });
}

export function useLibraryItem(id: string) {
  return useQuery({
    queryKey: queryKeys.libraryItem(id),
    queryFn: () => libraryApi.getItem(id),
    enabled: !!id,
  });
}

/**
 * Live Sonarr season/episode breakdown for a show. Hits Sonarr on every fetch,
 * so it is only enabled on the detail view of a TV item and refreshes on a
 * slow cadence to keep download progress moving without hammering Sonarr.
 */
export function useSonarrDetail(id: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.sonarrDetail(id),
    queryFn: () => libraryApi.getSonarrDetail(id),
    enabled: !!id && enabled,
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: false,
  });
}

/**
 * Queue or immediately delete episodes/seasons of a show. Touches the Sonarr
 * panel, the deletion queue and library totals, so all three are invalidated.
 */
export function useDeleteSonarrEpisodes(id: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (request: EpisodeDeletionRequest) => libraryApi.deleteSonarrEpisodes(id, request),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.sonarrDetail(id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.libraryItem(id) });
      queryClient.invalidateQueries({ queryKey: ['library'] });
      queryClient.invalidateQueries({ queryKey: queryKeys.queue });
      queryClient.invalidateQueries({ queryKey: queryKeys.stats });
      queryClient.invalidateQueries({ queryKey: ['activity', 'item', id] });
    },
  });
}

export function useCancelSonarrEpisodeDeletions(id: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (episodeIds: number[]) => libraryApi.cancelSonarrEpisodeDeletions(id, episodeIds),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.sonarrDetail(id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.queue });
      queryClient.invalidateQueries({ queryKey: ['activity', 'item', id] });
    },
  });
}

export function useSyncLibrary() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: libraryApi.syncLibrary,
    onSuccess: () => {
      // Invalidate immediately - the status polling will handle refetching when sync completes
      queryClient.invalidateQueries({ queryKey: ['library'] });
      queryClient.invalidateQueries({ queryKey: queryKeys.stats });
    },
  });
}

export function useSyncStatus(enabled: boolean) {
  return useQuery({
    queryKey: ['library', 'sync', 'status'],
    queryFn: libraryApi.getSyncStatus,
    enabled,
    refetchInterval: enabled ? 2000 : false, // Poll every 2 seconds when enabled
  });
}

export function useMarkForDeletion() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      id,
      options,
    }: {
      id: string;
      options?: {
        gracePeriodDays?: number;
        deletionAction?: string;
        resetOverseerr?: boolean;
      };
    }) => libraryApi.markForDeletion(id, options),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['library'] });
      queryClient.invalidateQueries({ queryKey: queryKeys.queue });
      queryClient.invalidateQueries({ queryKey: queryKeys.stats });
    },
  });
}

export function useProtectItem() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: libraryApi.protectItem,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['library'] });
    },
  });
}

export function useUnprotectItem() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: libraryApi.unprotectItem,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['library'] });
    },
  });
}

export function useBulkMarkForDeletion() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      ids,
      options,
    }: {
      ids: number[];
      options?: {
        gracePeriodDays?: number;
        deletionAction?: string;
        resetOverseerr?: boolean;
      };
    }) => libraryApi.bulkMarkForDeletion(ids, options),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['library'] });
      queryClient.invalidateQueries({ queryKey: queryKeys.queue });
      queryClient.invalidateQueries({ queryKey: queryKeys.stats });
    },
  });
}

export function useBulkProtect() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ ids, reason }: { ids: number[]; reason?: string }) =>
      libraryApi.bulkProtect(ids, reason),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['library'] });
    },
  });
}

// Rules Hooks
export function useRules() {
  return useQuery({
    queryKey: queryKeys.rules,
    queryFn: rulesApi.getAll,
  });
}

export function useRule(id: string) {
  return useQuery({
    queryKey: queryKeys.rule(id),
    queryFn: () => rulesApi.getById(id),
    enabled: !!id,
  });
}

export function useCreateRule() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (rule: Omit<Rule, 'id' | 'createdAt' | 'updatedAt'>) =>
      rulesApi.create(rule),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.rules });
      queryClient.invalidateQueries({ queryKey: queryKeys.stats });
    },
  });
}

export function useUpdateRule() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, ...rule }: { id: string } & Partial<Rule>) =>
      rulesApi.update(id, rule),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.rules });
    },
  });
}

export function useDeleteRule() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: rulesApi.delete,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.rules });
      queryClient.invalidateQueries({ queryKey: queryKeys.stats });
    },
  });
}

export function useToggleRule() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ ruleId, enabled }: { ruleId: string; enabled: boolean }) =>
      rulesApi.toggle(ruleId, enabled),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.rules });
    },
  });
}

export function useRunRule() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (ruleId: string) => rulesApi.runRule(ruleId),
    onSuccess: () => {
      // Invalidate library and queue data since items may have been added to queue
      queryClient.invalidateQueries({ queryKey: ['library'] });
      queryClient.invalidateQueries({ queryKey: queryKeys.queue });
      queryClient.invalidateQueries({ queryKey: queryKeys.stats });
    },
  });
}

// Archive hooks: the re-acquisition verdict, archiving and lifting a hold all
// change both the queue and the library item, so every one invalidates both.
function useArchiveMutation<TArgs, TResult>(fn: (args: TArgs) => Promise<TResult>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.queue });
      queryClient.invalidateQueries({ queryKey: ['library'] });
      queryClient.invalidateQueries({ queryKey: queryKeys.stats });
    },
  });
}

export function useCheckQueueAvailability() {
  return useArchiveMutation((id: string) => queueApi.checkAvailability(id));
}

export function useArchiveQueueItem() {
  return useArchiveMutation((id: string) => queueApi.archive(id));
}

export function useDeleteAnyway() {
  return useArchiveMutation((id: string) => queueApi.deleteAnyway(id));
}

export function useArchiveItem() {
  return useArchiveMutation((id: string) => libraryApi.archiveItem(id));
}

export function useCheckItemAvailability() {
  return useArchiveMutation((id: string) => libraryApi.checkAvailability(id));
}

// Queue Hooks
export function useDeletionQueue() {
  return useQuery({
    queryKey: queryKeys.queue,
    queryFn: queueApi.getAll,
  });
}

export function useRemoveFromQueue() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: queueApi.remove,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.queue });
      queryClient.invalidateQueries({ queryKey: ['library'] });
      queryClient.invalidateQueries({ queryKey: queryKeys.stats });
    },
  });
}

export function useProcessQueue() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (force?: boolean) => queueApi.process(force),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.queue });
      queryClient.invalidateQueries({ queryKey: ['library'] });
      queryClient.invalidateQueries({ queryKey: ['history'] });
      queryClient.invalidateQueries({ queryKey: queryKeys.stats });
    },
  });
}

export function useDeleteNow() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: queueApi.deleteNow,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.queue });
      queryClient.invalidateQueries({ queryKey: ['library'] });
      queryClient.invalidateQueries({ queryKey: ['history'] });
      queryClient.invalidateQueries({ queryKey: queryKeys.stats });
    },
  });
}

// History Hooks
export function useDeletionHistory(filters: HistoryFilters) {
  return useQuery({
    queryKey: queryKeys.history(filters),
    queryFn: () => historyApi.getAll(filters),
  });
}

// Activity Log Hooks
export function useActivityLog(filters: ActivityFilters) {
  return useQuery({
    queryKey: queryKeys.activityLog(filters),
    queryFn: () => activityApi.getLog(filters),
  });
}

export function useItemActivity(itemId: string) {
  return useQuery({
    queryKey: ['activity', 'item', itemId] as const,
    queryFn: () => activityApi.getItemActivity(itemId),
    enabled: !!itemId,
  });
}

// Settings Hooks
export function useSettings() {
  return useQuery({
    queryKey: queryKeys.settings,
    queryFn: settingsApi.get,
  });
}

/** Display name of the configured media server (Plex, Jellyfin or Emby). */
export function useMediaServerName(): string {
  const { data: settings } = useSettings();
  return mediaServerName(settings?.mediaServerType);
}

export function useSaveSettings() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (settings: Settings) => settingsApi.save(settings),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.settings });
    },
  });
}

export function useTestWebhook() {
  return useMutation({
    mutationFn: (body: { url: string; secret?: string; event?: string }) => webhooksApi.test(body),
  });
}

export function useTestConnection() {
  return useMutation({
    mutationFn: ({
      service,
      config,
    }: {
      service: string;
      config: ServiceConnection;
    }) => settingsApi.testConnection(service, config),
  });
}

export function useImportSettings() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: { version: number; exportedAt: string; settings: Record<string, string> }) => {
      const response = await fetch('/api/settings/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to import settings');
      }
      return response.json();
    },
    onSuccess: () => {
      // Invalidate settings to reload with new values
      queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });
}

// Unraid Hooks
export function useUnraidStats() {
  return useQuery({
    queryKey: queryKeys.unraidStats,
    queryFn: unraidApi.getStats,
    refetchInterval: 60000, // Refresh every minute
    retry: false, // Don't retry if Unraid isn't configured
  });
}

// Health Hooks
export function useHealthStatus() {
  return useQuery({
    queryKey: queryKeys.healthStatus,
    queryFn: healthApi.getStatus,
    refetchInterval: 120000, // Poll every 2 minutes
    refetchIntervalInBackground: false, // Stop polling when tab not visible
    staleTime: 60000, // Consider stale after 60 seconds
    retry: 1, // Only retry once on failure
  });
}

// Scan cadence (Schedule card ribbon)
export function useScanCadence(days = 14) {
  return useQuery({
    queryKey: queryKeys.scanCadence(days),
    queryFn: () => scanApi.getCadence(days),
    refetchInterval: 120000, // Keep in step with the health-status poll
    refetchIntervalInBackground: false,
    staleTime: 60000,
    retry: 1,
  });
}

// Poll scan status — only while `enabled` (i.e. a scan we kicked off is running)
export function useScanStatus(enabled: boolean) {
  return useQuery({
    queryKey: ['scan', 'status'] as const,
    queryFn: scanApi.getStatus,
    enabled,
    refetchInterval: enabled ? 2000 : false,
  });
}

// Trigger a manual scan (POST /api/scan/trigger)
export function useTriggerScan() {
  return useMutation({
    mutationFn: scanApi.trigger,
  });
}

export function useVersion() {
  return useQuery({
    queryKey: ['version'],
    queryFn: async () => {
      const response = await fetch('/api/health/version');
      const data = await response.json();
      return data.version as string;
    },
    staleTime: Infinity, // Version doesn't change during runtime
    retry: false,
  });
}

// Login configuration (read-only; Settings → System)
export function useAuthSettings(enabled = true) {
  return useQuery({
    queryKey: ['settings', 'auth'],
    queryFn: authSettingsApi.get,
    enabled,
    staleTime: 1000 * 60,
  });
}

// MCP connector (Settings → System)
export function useMcpInfo(enabled = true) {
  return useQuery({
    queryKey: ['settings', 'mcp'],
    queryFn: mcpApi.get,
    enabled,
    staleTime: 1000 * 30,
  });
}

export function useUpdateMcp() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { enabled?: boolean; allowImmediateDeletion?: boolean }) => mcpApi.update(body),
    onSuccess: (info) => {
      queryClient.setQueryData(['settings', 'mcp'], info);
    },
  });
}

// Unmanaged folders
export function useOrphanFolders(includeIgnored = false) {
  return useQuery({
    queryKey: queryKeys.folders(includeIgnored),
    // A manual refetch (the Refresh button) asks the apps again; the first
    // load may use the server's one-minute cache.
    queryFn: ({ meta }) => foldersApi.list({ includeIgnored, refresh: meta?.['refresh'] === true }),
    staleTime: 30_000,
  });
}

export function useFolderMappings() {
  return useQuery({ queryKey: queryKeys.folderMappings, queryFn: foldersApi.mappings });
}

// ---------------------------------------------------------------------------
// Insights
// ---------------------------------------------------------------------------

/** Stack health: the server caches it for a minute, so polling here is cheap. */
export function useStackHealth() {
  return useQuery({
    queryKey: queryKeys.insightsStack,
    queryFn: () => insightsApi.stack(),
    refetchInterval: 120000,
    refetchIntervalInBackground: false,
    staleTime: 60000,
    retry: 1,
  });
}

/** Acknowledge (or un-acknowledge) one stack-health finding; the server answers with the updated report. */
export function useAcknowledgeStackItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, undo }: { id: string; undo?: boolean }) => (undo ? insightsApi.unacknowledge(id) : insightsApi.acknowledge(id)),
    onSuccess: (report) => {
      queryClient.setQueryData(queryKeys.insightsStack, report);
    },
  });
}

export function useLibraryQuality() {
  return useQuery({
    queryKey: queryKeys.insightsLibrary,
    queryFn: () => insightsApi.library(),
    staleTime: 5 * 60000,
    retry: 1,
  });
}

export function useWatchPatterns() {
  return useQuery({
    queryKey: queryKeys.insightsWatching,
    queryFn: () => insightsApi.watching(),
    staleTime: 5 * 60000,
    retry: 1,
  });
}

export function usePlaybackFriction() {
  return useQuery({
    queryKey: queryKeys.insightsPlayback,
    queryFn: () => insightsApi.playback(),
    staleTime: 5 * 60000,
    retry: 1,
  });
}

export function useInsightHistory(days = 90) {
  return useQuery({ queryKey: queryKeys.insightsHistory(days), queryFn: () => insightsApi.history(days), staleTime: 10 * 60000, retry: 1 });
}

/** The volumes mounted into the container; changes only when the container is recreated. */
export function useContainerMounts() {
  return useQuery({ queryKey: queryKeys.folderMounts, queryFn: foldersApi.mounts, staleTime: 5 * 60 * 1000 });
}

export function useSaveFolderMappings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (mappings: FolderMapping[]) => foldersApi.saveMappings(mappings),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['folders'] });
    },
  });
}

export function useFolderCandidates(id: string, term?: string) {
  return useQuery({
    queryKey: queryKeys.folderCandidates(id, term),
    queryFn: () => foldersApi.candidates(id, term),
    staleTime: 60_000,
  });
}

export function useQualityProfiles(service: 'sonarr' | 'radarr') {
  return useQuery({ queryKey: queryKeys.qualityProfiles(service), queryFn: () => foldersApi.profiles(service), staleTime: 5 * 60_000 });
}

export function useImportFolder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; candidateId: number; qualityProfileId?: number; monitored?: boolean }) => foldersApi.importFolder(id, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['folders'] });
      queryClient.invalidateQueries({ queryKey: ['activity'] });
    },
  });
}

export function useDeleteFolder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => foldersApi.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['folders'] });
      queryClient.invalidateQueries({ queryKey: ['activity'] });
      queryClient.invalidateQueries({ queryKey: queryKeys.stats });
    },
  });
}

export function useIgnoreFolder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ignored }: { id: string; ignored: boolean }) => foldersApi.setIgnored(id, ignored),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['folders'] });
    },
  });
}

export function useFolderPermissions() {
  return useQuery({ queryKey: queryKeys.folderPermissions, queryFn: foldersApi.permissions, staleTime: 60_000 });
}

export function useSavePermissionSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<PermissionSettings>) => foldersApi.savePermissionSettings(patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['folders'] });
    },
  });
}

export function useBulkIgnoreFolders() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ ids, ignored }: { ids: string[]; ignored: boolean }) => foldersApi.setManyIgnored(ids, ignored),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['folders'] });
      queryClient.invalidateQueries({ queryKey: ['activity'] });
    },
  });
}

export function useQueueFolderJobs() {
  return useMutation({
    mutationFn: (body: { action: FolderJobAction; folders: Array<{ id: string; params?: FolderJobParams }>; params?: FolderJobParams }) => foldersApi.queueJobs(body),
  });
}

export function useFixFolderPermissions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => foldersApi.fixPermissions(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['folders'] });
      queryClient.invalidateQueries({ queryKey: ['activity'] });
    },
  });
}
