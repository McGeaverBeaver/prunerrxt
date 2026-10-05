import axios, { AxiosError, AxiosInstance } from 'axios';
import type {
  ArchiveStatus,
  ArrLogLevel,
  AuditEntry,
  AuditFilters,
  AuditVerification,
  LoginSession,
  TaskRun,
  TasksStatus,
  AvailabilityCheckResult,
  DeletionSetupResult,
  DiagnosticsService,
  ServiceActivityResult,
  ServiceHealthResult,
  ServiceLogsResult,
  MediaItem,
  LibraryFilters,
  LibraryResponse,
  Rule,
  QueueItem,
  DeletionJob,
  OrphanFolder,
  OrphanFolderListing,
  FolderMapping,
  ContainerMountsResult,
  StackHealthReport,
  LibraryQualityReport,
  WatchPatternsReport,
  PlaybackFrictionReport,
  InsightSnapshot,
  FolderCandidate,
  QualityProfile,
  PermissionSettings,
  PermissionCapabilities,
  PermissionReport,
  PermissionFixResult,
  HistoryFilters,
  HistoryResponse,
  DashboardStats,
  UpcomingDeletion,
  RecommendationsResponse,
  Settings,
  ServiceConnection,
  ApiResponse,
  UnraidStats,
  ActivityFilters,
  ActivityLogEntry,
  ActivityLogResponse,
  SystemHealthResponse,
  ScanCadenceRun,
  StorageSnapshot,
  SonarrSeriesDetailResponse,
  EpisodeDeletionRequest,
  EpisodeDeletionResult,
  FolderJob,
  FolderJobAction,
  FolderJobParams,
  FolderBatchResult,
  FolderBatchSummary,
  ImportSuggestion,
} from '@/types';
import { normalizeActivityEntry } from '@/lib/activityFormatter';

// Create axios instance
const api: AxiosInstance = axios.create({
  baseURL: '/api',
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Extended error response type
interface ApiErrorResponse {
  error?: string;
  details?: string;
  success?: boolean;
  code?: string;
}

/** Fired on `window` when the server says the session is gone; the auth context listens. */
export const UNAUTHENTICATED_EVENT = 'prunerr:unauthenticated';

// Response interceptor for error handling
api.interceptors.response.use(
  (response) => response,
  (error: AxiosError<ApiErrorResponse>) => {
    const errorData = error.response?.data;
    const message = errorData?.error || error.message || 'An error occurred';
    const details = errorData?.details;

    // A lost or expired login: tell the app so it can show the login page
    // instead of a wall of failed requests.
    if (error.response?.status === 401 && errorData?.code === 'AUTH_REQUIRED') {
      window.dispatchEvent(new Event(UNAUTHENTICATED_EVENT));
    }

    // Create a detailed error message
    const fullMessage = details ? `${message}\n\n${details}` : message;
    console.error('API Error:', fullMessage);

    return Promise.reject(new Error(fullMessage));
  }
);

// Dashboard APIs
export const dashboardApi = {
  getStats: async (): Promise<DashboardStats> => {
    const { data } = await api.get<ApiResponse<DashboardStats>>('/stats');
    return data.data!;
  },

  getRecentActivity: async (): Promise<ActivityLogEntry[]> => {
    const { data } = await api.get<ApiResponse<ActivityLogEntry[]>>('/activity/recent?excludeEventTypes=scan');
    return (data.data || []).map(normalizeActivityEntry);
  },

  getUpcomingDeletions: async (): Promise<UpcomingDeletion[]> => {
    const { data } = await api.get<ApiResponse<UpcomingDeletion[]>>('/queue/upcoming');
    return data.data || [];
  },

  getStorageHistory: async (days = 30): Promise<StorageSnapshot[]> => {
    const { data } = await api.get<ApiResponse<StorageSnapshot[]>>(`/stats/storage-history?days=${days}`);
    return data.data || [];
  },

  getRecommendations: async (limit = 10, unwatchedDays = 90): Promise<RecommendationsResponse> => {
    const params = new URLSearchParams();
    params.append('limit', String(limit));
    params.append('unwatchedDays', String(unwatchedDays));
    const { data } = await api.get<ApiResponse<RecommendationsResponse>>(`/stats/recommendations?${params}`);
    return data.data!;
  },
};

// Library APIs
export const libraryApi = {
  getItems: async (filters: LibraryFilters): Promise<LibraryResponse> => {
    const params = new URLSearchParams();
    if (filters.search) params.append('search', filters.search);
    // Map client type 'tv' to server type 'show'
    if (filters.type) params.append('type', filters.type === 'tv' ? 'show' : filters.type);
    if (filters.status) params.append('status', filters.status);
    params.append('page', String(filters.page));
    params.append('limit', String(filters.limit));
    params.append('sortBy', filters.sortBy);
    params.append('sortOrder', filters.sortOrder);

    const { data } = await api.get<ApiResponse<LibraryResponse>>(`/library?${params}`);
    return data.data!;
  },

  getItem: async (id: string): Promise<MediaItem> => {
    const { data } = await api.get<ApiResponse<MediaItem>>(`/library/${id}`);
    return data.data!;
  },

  getSonarrDetail: async (id: string): Promise<SonarrSeriesDetailResponse> => {
    const { data } = await api.get<ApiResponse<SonarrSeriesDetailResponse>>(`/library/${id}/sonarr`);
    return data.data!;
  },

  deleteSonarrEpisodes: async (
    id: string,
    request: EpisodeDeletionRequest
  ): Promise<EpisodeDeletionResult> => {
    const { data } = await api.post<ApiResponse<EpisodeDeletionResult>>(
      `/library/${id}/sonarr/deletions`,
      request
    );
    return data.data!;
  },

  cancelSonarrEpisodeDeletions: async (
    id: string,
    episodeIds: number[]
  ): Promise<{ cancelled: number }> => {
    const { data } = await api.post<ApiResponse<{ cancelled: number }>>(
      `/library/${id}/sonarr/deletions/cancel`,
      { episodeIds }
    );
    return data.data!;
  },

  syncLibrary: async (): Promise<void> => {
    await api.post('/library/sync');
  },

  getSyncStatus: async (): Promise<{ inProgress: boolean }> => {
    const { data } = await api.get<ApiResponse<{ inProgress: boolean }>>('/library/sync/status');
    return data.data!;
  },

  markForDeletion: async (
    id: string,
    options?: {
      gracePeriodDays?: number;
      deletionAction?: string;
      resetOverseerr?: boolean;
    }
  ): Promise<void> => {
    await api.post(`/library/${id}/mark-deletion`, options || {});
  },

  protectItem: async (id: string): Promise<void> => {
    await api.post(`/library/${id}/protect`);
  },

  unprotectItem: async (id: string): Promise<void> => {
    await api.delete(`/library/${id}/protect`);
  },

  /** Archive: keep the item for good (protect it, leave the queue). */
  archiveItem: async (id: string, reason?: string): Promise<void> => {
    await api.post(`/library/${id}/archive`, reason ? { reason } : {});
  },

  /** Archive: ask Radarr/Sonarr whether the item could be downloaded again. Slow (runs the search). */
  checkAvailability: async (id: string): Promise<AvailabilityCheckResult & { message?: string }> => {
    const { data } = await api.post<ApiResponse<AvailabilityCheckResult>>(`/library/${id}/availability`, undefined, { timeout: 180_000 });
    return { ...data.data!, message: data.message };
  },

  bulkMarkForDeletion: async (
    ids: number[],
    options?: {
      gracePeriodDays?: number;
      deletionAction?: string;
      resetOverseerr?: boolean;
    }
  ): Promise<BulkActionResult> => {
    const { data } = await api.post<ApiResponse<BulkActionResult>>('/library/bulk/mark-deletion', {
      ids,
      ...options,
    });
    return data.data!;
  },

  bulkProtect: async (ids: number[], reason?: string): Promise<BulkActionResult> => {
    const { data } = await api.post<ApiResponse<BulkActionResult>>('/library/bulk/protect', {
      ids,
      reason,
    });
    return data.data!;
  },

  // List Plex libraries (used by the rule builder's library targeting and
  // the settings exclusion config). Throws if Plex is not configured.
  getPlexLibraries: async (): Promise<PlexLibrarySummary[]> => {
    const { data } = await api.get<ApiResponse<PlexLibrarySummary[]>>('/library/plex-libraries');
    return data.data || [];
  },
};

// Bulk action result type
export interface BulkActionResult {
  success: Array<{ id: number; title: string }>;
  failed: Array<{ id: number; error: string }>;
  skipped: Array<{ id: number; title: string; reason: string }>;
}

// Rule preview types
export interface RulePreviewResult {
  // v2 preview fields (canonical)
  totalMatches?: number;
  wouldQueue?: number;
  wouldSkipProtected?: number;
  /** Matches already sitting in the deletion queue — not new work. */
  alreadyPending?: number;
  storageFreedGB?: number;
  samples?: Array<{
    id: number;
    title: string;
    size: number;
    rating: number | null;
    posterUrl?: string | null;
    isProtected?: boolean;
    reason?: string;
  }>;
  sampleTotal?: number;
  // legacy shape retained for template preview callers
  matchCount?: number;
  totalSize?: number;
  totalSizeFormatted?: string;
  sampleItems?: Array<{
    id: number;
    title: string;
    type: string;
    size: number;
    posterUrl?: string;
    lastWatched?: string;
    playCount: number;
    addedAt?: string;
  }>;
  breakdown?: {
    movies: number;
    shows: number;
  };
}

export interface RulePreviewV2Body {
  version: 2;
  root: import('@/types').ConditionNode;
  mediaType?: 'all' | 'movie' | 'show' | 'tv';
  /** Restrict the preview to these Plex library keys. Empty/omitted = all. */
  libraryKeys?: string[];
  /** Page through the matched samples, largest first. */
  sampleOffset?: number;
  sampleLimit?: number;
  /** Leave protected items out of the samples (counts are unaffected). */
  includeProtectedSamples?: boolean;
}

export interface PlexLibrarySummary {
  key: string;
  title: string;
  type: string;
  excluded: boolean;
}

export interface RuleSuggestion {
  id: string;
  name: string;
  description: string;
  icon: string;
  matchCount: number;
  totalSize: number;
  totalSizeFormatted: string;
  conditions: Array<{ field: string; operator: string; value: string | number | boolean }>;
  mediaType: 'all' | 'movie' | 'show';
}

export interface RuleSuggestionsResponse {
  suggestions: RuleSuggestion[];
  libraryStats: {
    totalItems: number;
    movies: number;
    shows: number;
    totalSize: number;
  };
}

// Rules APIs
export const rulesApi = {
  getAll: async (): Promise<Rule[]> => {
    const { data } = await api.get<ApiResponse<Rule[]>>('/rules');
    return data.data || [];
  },

  getById: async (id: string): Promise<Rule> => {
    const { data } = await api.get<ApiResponse<Rule>>(`/rules/${id}`);
    return data.data!;
  },

  create: async (rule: Omit<Rule, 'id' | 'createdAt' | 'updatedAt'>): Promise<Rule> => {
    const { data } = await api.post<ApiResponse<Rule>>('/rules', rule);
    return data.data!;
  },

  update: async (id: string, rule: Partial<Rule>): Promise<Rule> => {
    const { data } = await api.put<ApiResponse<Rule>>(`/rules/${id}`, rule);
    return data.data!;
  },

  delete: async (id: string): Promise<void> => {
    await api.delete(`/rules/${id}`);
  },

  toggle: async (id: string, enabled: boolean): Promise<void> => {
    await api.patch(`/rules/${id}/toggle`, { enabled });
  },

  runRule: async (id: string): Promise<{ matched: number; processed: number }> => {
    const { data } = await api.post<ApiResponse<{ summary: { matched: number; processed: number } }>>(`/rules/${id}/run`);
    return {
      matched: data.data!.summary.matched,
      processed: data.data!.summary.processed,
    };
  },

  // Preview which items would match a rule before saving (v1 flat)
  preview: async (
    conditions: Array<{ field: string; operator: string; value: string | number | boolean }>,
    mediaType?: 'all' | 'movie' | 'show'
  ): Promise<RulePreviewResult> => {
    const { data } = await api.post<ApiResponse<RulePreviewResult>>('/rules/preview', {
      conditions,
      mediaType,
    });
    return data.data!;
  },

  // Preview a v2 condition tree
  previewV2: async (body: RulePreviewV2Body): Promise<RulePreviewResult> => {
    const { data } = await api.post<ApiResponse<RulePreviewResult>>('/rules/preview', body);
    return data.data!;
  },

  // Get smart rule suggestions based on library analysis
  getSuggestions: async (): Promise<RuleSuggestionsResponse> => {
    const { data } = await api.get<ApiResponse<RuleSuggestionsResponse>>('/rules/suggestions');
    return data.data!;
  },
};

// Collection + User APIs (used by rule builder)
export interface CollectionSummary {
  id: number;
  tmdbId: number;
  title: string;
  overview?: string;
  itemCount: number;
  isProtected: boolean;
  protectionReason?: string | null;
  posterUrl?: string | null;
}

export interface CollectionDetail extends CollectionSummary {
  protectedAt?: string | null;
  lastSyncedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface CollectionItem {
  id: number;
  title: string;
  type: 'movie' | 'tv';
  year?: number;
  size: number;
  posterUrl?: string;
  status: string;
  isProtected: boolean;
  radarrId?: number;
  tmdbId?: number;
  imdbId?: string;
}

export interface PlexUserSummary {
  id: number;
  username: string;
  isOwner: boolean;
  thumbUrl: string | null;
}

export const collectionsApi = {
  list: async (): Promise<CollectionSummary[]> => {
    const { data } = await api.get<ApiResponse<CollectionSummary[]>>('/collections');
    return data.data || [];
  },

  getById: async (id: number): Promise<CollectionDetail> => {
    const { data } = await api.get<ApiResponse<CollectionDetail>>(`/collections/${id}`);
    if (!data.data) throw new Error(`Collection ${id} not found`);
    return data.data;
  },

  getItems: async (id: number): Promise<CollectionItem[]> => {
    const { data } = await api.get<ApiResponse<CollectionItem[]>>(`/collections/${id}/items`);
    return data.data || [];
  },

  sync: async (): Promise<{ collectionsSynced: number; itemsMatched: number; message: string }> => {
    const { data } = await api.post<ApiResponse<{ collectionsSynced: number; itemsMatched: number }> & { message?: string }>('/collections/sync');
    return {
      collectionsSynced: data.data?.collectionsSynced ?? 0,
      itemsMatched: data.data?.itemsMatched ?? 0,
      message: data.message || `Synced ${data.data?.collectionsSynced ?? 0} collections`,
    };
  },

  setProtection: async (id: number, isProtected: boolean, reason?: string): Promise<CollectionDetail> => {
    const { data } = await api.patch<ApiResponse<CollectionDetail>>(`/collections/${id}/protection`, {
      isProtected,
      reason,
    });
    if (!data.data) throw new Error(`Failed to update protection for collection ${id}`);
    return data.data;
  },

  queueForDeletion: async (id: number, options: {
    deletionAction: string;
    gracePeriodDays?: number;
    resetOverseerr?: boolean;
  }): Promise<{ queued: number; skipped: number; skippedReasons: Record<string, number>; totalSize: number }> => {
    const { data } = await api.post<ApiResponse<{ queued: number; skipped: number; skippedReasons: Record<string, number>; totalSize: number }>>(`/collections/${id}/queue`, options);
    if (!data.data) throw new Error(`Failed to queue collection ${id} for deletion`);
    return data.data;
  },
};

export const usersApi = {
  list: async (): Promise<PlexUserSummary[]> => {
    const { data } = await api.get<ApiResponse<PlexUserSummary[]>>('/users');
    return data.data || [];
  },

  sync: async (): Promise<{ synced: number }> => {
    const { data } = await api.post<ApiResponse<{ synced: number }>>('/users/sync');
    const users = data.data as unknown as Array<unknown> | { synced: number } | undefined;
    // The endpoint returns the user array directly; normalize to { synced: count }
    if (Array.isArray(users)) {
      return { synced: users.length };
    }
    return { synced: 0 };
  },
};

export const requestersApi = {
  list: async (): Promise<string[]> => {
    const { data } = await api.get<ApiResponse<string[]>>('/media/requesters');
    return data.data || [];
  },
};

// Queue APIs
export const queueApi = {
  getAll: async (): Promise<QueueItem[]> => {
    const { data } = await api.get<ApiResponse<QueueItem[]>>('/queue');
    return data.data || [];
  },

  remove: async (id: string): Promise<void> => {
    await api.delete(`/queue/${id}`);
  },

  /**
   * Run the queue. Real runs queue background jobs and answer 202 at once;
   * follow them through deletionJobsApi / the DeletionJobs context.
   */
  process: async (force = false): Promise<QueueProcessResult> => {
    const { data } = await api.post<ApiResponse<QueueProcessResult>>(`/queue/process${force ? '?force=true' : ''}`);
    return { ...data.data!, message: data.message };
  },

  /** Queue one item for deletion now; answers with the background job. */
  deleteNow: async (id: string): Promise<{ job: DeletionJob; alreadyQueued: boolean; message?: string }> => {
    const { data } = await api.post<ApiResponse<{ job: DeletionJob; alreadyQueued: boolean }>>(`/queue/${id}/delete-now`);
    return { ...data.data!, message: data.message };
  },

  /** Archive: ask Radarr/Sonarr again whether the item could be downloaded again. Slow (runs the search). */
  checkAvailability: async (id: string): Promise<AvailabilityCheckResult & { message?: string }> => {
    const { data } = await api.post<ApiResponse<AvailabilityCheckResult>>(`/queue/${id}/availability`, undefined, { timeout: 180_000 });
    return { ...data.data!, message: data.message };
  },

  /** Archive: is the checker paused, and how many queued items still lack a verdict? */
  archiveStatus: async (): Promise<ArchiveStatus> => {
    const { data } = await api.get<ApiResponse<ArchiveStatus>>('/queue/archive-status');
    return data.data ?? { enabled: true, paused: [], unchecked: 0, lastPassAt: null };
  },

  /** Archive: keep the item for good (protect it, leave the queue). */
  archive: async (id: string, reason?: string): Promise<void> => {
    await api.post(`/queue/${id}/archive`, reason ? { reason } : {});
  },

  /** Archive: lift the hold on an at-risk item so it goes when its grace period ends. */
  deleteAnyway: async (id: string): Promise<void> => {
    await api.post(`/queue/${id}/delete-anyway`);
  },

  /** Archive: protect every queued movie and show whose verdict is at risk, taking them out of the queue. */
  protectAtRisk: async (): Promise<ProtectAtRiskResult> => {
    const { data } = await api.post<ApiResponse<ProtectAtRiskResult>>('/queue/protect-at-risk');
    return { ...data.data!, message: data.message };
  },
};

export interface ProtectAtRiskResult {
  considered: number;
  archived: Array<{ id: number; title: string }>;
  skipped: Array<{ id: number; title: string; reason: string }>;
  failed: Array<{ id: number; error: string }>;
  message?: string;
}

export interface QueueProcessResult {
  batchId: string;
  queued: DeletionJob[];
  alreadyQueued: number;
  skipped: Array<{ queueId: string; error: string }>;
  background: boolean;
  message?: string;
}

// Unmanaged folders
export const foldersApi = {
  list: async (options: { refresh?: boolean; includeIgnored?: boolean } = {}): Promise<OrphanFolderListing> => {
    const params = new URLSearchParams();
    if (options.refresh) params.set('refresh', 'true');
    if (options.includeIgnored) params.set('includeIgnored', 'true');
    const { data } = await api.get<ApiResponse<OrphanFolderListing>>(`/folders${params.size ? `?${params}` : ''}`);
    return data.data!;
  },
  mappings: async (): Promise<FolderMapping[]> => {
    const { data } = await api.get<ApiResponse<FolderMapping[]>>('/folders/mappings');
    return data.data ?? [];
  },
  saveMappings: async (mappings: FolderMapping[]): Promise<FolderMapping[]> => {
    const { data } = await api.put<ApiResponse<FolderMapping[]>>('/folders/mappings', { mappings });
    return data.data ?? [];
  },
  mounts: async (): Promise<ContainerMountsResult> => {
    const { data } = await api.get<ApiResponse<ContainerMountsResult>>('/folders/mounts');
    return data.data ?? { supported: false, mounts: [] };
  },
  profiles: async (service: 'sonarr' | 'radarr'): Promise<QualityProfile[]> => {
    const { data } = await api.get<ApiResponse<QualityProfile[]>>(`/folders/profiles/${service}`);
    return data.data ?? [];
  },
  candidates: async (id: string, term?: string): Promise<{ folder: OrphanFolder; term: string; candidates: FolderCandidate[] }> => {
    const { data } = await api.get<ApiResponse<{ folder: OrphanFolder; term: string; candidates: FolderCandidate[] }>>(
      `/folders/${encodeURIComponent(id)}/candidates${term ? `?term=${encodeURIComponent(term)}` : ''}`
    );
    return data.data!;
  },
  importFolder: async (
    id: string,
    body: { candidateId: number; qualityProfileId?: number; monitored?: boolean }
  ): Promise<{ folder: OrphanFolder; addedId: number; title: string; year: number | null; message?: string }> => {
    const { data } = await api.post<ApiResponse<{ folder: OrphanFolder; addedId: number; title: string; year: number | null }>>(`/folders/${encodeURIComponent(id)}/import`, body);
    return { ...data.data!, message: data.message };
  },
  remove: async (id: string): Promise<{ folder: OrphanFolder; sizeBytes: number; fileCount: number }> => {
    const { data } = await api.delete<ApiResponse<{ folder: OrphanFolder; sizeBytes: number; fileCount: number }>>(`/folders/${encodeURIComponent(id)}`);
    return data.data!;
  },
  setIgnored: async (id: string, ignored: boolean): Promise<OrphanFolder> => {
    const { data } = await api.post<ApiResponse<OrphanFolder>>(`/folders/${encodeURIComponent(id)}/ignore`, { ignored });
    return data.data!;
  },
  permissions: async (): Promise<{ capabilities: PermissionCapabilities; settings: PermissionSettings }> => {
    const { data } = await api.get<ApiResponse<{ capabilities: PermissionCapabilities; settings: PermissionSettings }>>('/folders/permissions');
    return data.data!;
  },
  savePermissionSettings: async (patch: Partial<PermissionSettings>): Promise<{ capabilities: PermissionCapabilities; settings: PermissionSettings }> => {
    const { data } = await api.put<ApiResponse<{ capabilities: PermissionCapabilities; settings: PermissionSettings }>>('/folders/permission-settings', patch);
    return data.data!;
  },
  inspectPermissions: async (id: string): Promise<{ folder: OrphanFolder; report: PermissionReport }> => {
    const { data } = await api.get<ApiResponse<{ folder: OrphanFolder; report: PermissionReport }>>(`/folders/${encodeURIComponent(id)}/permissions`);
    return data.data!;
  },
  fixPermissions: async (id: string): Promise<{ folder: OrphanFolder; result: PermissionFixResult; message?: string }> => {
    const { data } = await api.post<ApiResponse<{ folder: OrphanFolder; result: PermissionFixResult }>>(`/folders/${encodeURIComponent(id)}/permissions/fix`);
    return { ...data.data!, message: data.message };
  },

  // Bulk: background jobs for the slow actions, one call for the ignore list
  setManyIgnored: async (ids: string[], ignored: boolean): Promise<{ folders: OrphanFolder[]; missing: string[]; message?: string }> => {
    const { data } = await api.post<ApiResponse<{ folders: OrphanFolder[]; missing: string[] }>>('/folders/ignore', { ids, ignored });
    return { ...data.data!, message: data.message };
  },
  importPreview: async (ids: string[]): Promise<ImportSuggestion[]> => {
    const { data } = await api.post<ApiResponse<ImportSuggestion[]>>('/folders/import-preview', { ids });
    return data.data ?? [];
  },
  queueJobs: async (body: { action: FolderJobAction; folders: Array<{ id: string; params?: FolderJobParams }>; params?: FolderJobParams }): Promise<FolderBatchResult> => {
    const { data } = await api.post<ApiResponse<FolderBatchResult>>('/folders/jobs', body);
    return { ...data.data!, message: data.message };
  },
  jobs: async (): Promise<{ active: FolderJob[]; recent: FolderJob[]; batches: FolderBatchSummary[] }> => {
    const { data } = await api.get<ApiResponse<{ active: FolderJob[]; recent: FolderJob[]; batches: FolderBatchSummary[] }>>('/folders/jobs');
    return data.data!;
  },
  cancelJob: async (id: number): Promise<FolderJob> => {
    const { data } = await api.post<ApiResponse<FolderJob>>(`/folders/jobs/${id}/cancel`);
    return data.data!;
  },
  retryJob: async (id: number): Promise<FolderJob> => {
    const { data } = await api.post<ApiResponse<FolderJob>>(`/folders/jobs/${id}/retry`);
    return data.data!;
  },
  cancelBatch: async (batchId: string): Promise<{ cancelled: number }> => {
    const { data } = await api.post<ApiResponse<{ cancelled: number }>>(`/folders/jobs/batch/${encodeURIComponent(batchId)}/cancel`);
    return data.data!;
  },
  clearFinishedJobs: async (): Promise<{ removed: number }> => {
    const { data } = await api.delete<ApiResponse<{ removed: number }>>('/folders/jobs/finished');
    return data.data!;
  },
};

// Background deletion jobs
export const deletionJobsApi = {
  list: async (): Promise<{ active: DeletionJob[]; recent: DeletionJob[] }> => {
    const { data } = await api.get<ApiResponse<{ active: DeletionJob[]; recent: DeletionJob[] }>>('/deletion-jobs');
    return data.data ?? { active: [], recent: [] };
  },
  cancel: async (id: number): Promise<DeletionJob> => {
    const { data } = await api.post<ApiResponse<DeletionJob>>(`/deletion-jobs/${id}/cancel`);
    return data.data!;
  },
  retry: async (id: number): Promise<DeletionJob> => {
    const { data } = await api.post<ApiResponse<DeletionJob>>(`/deletion-jobs/${id}/retry`);
    return data.data!;
  },
  clearFinished: async (): Promise<void> => {
    await api.delete('/deletion-jobs/finished');
  },
};

// History APIs
export const historyApi = {
  getAll: async (filters: HistoryFilters): Promise<HistoryResponse> => {
    const params = new URLSearchParams();
    if (filters.search) params.append('search', filters.search);
    params.append('page', String(filters.page));
    params.append('limit', String(filters.limit));
    params.append('dateRange', filters.dateRange);

    const { data } = await api.get<ApiResponse<HistoryResponse>>(`/history?${params}`);
    return data.data!;
  },

  exportCsv: async (): Promise<Blob> => {
    const { data } = await api.get('/history/export', {
      responseType: 'blob',
    });
    return data;
  },
};

// Unraid APIs
export const unraidApi = {
  getStats: async (): Promise<UnraidStats> => {
    const { data } = await api.get<ApiResponse<UnraidStats>>('/unraid/stats');
    return data.data!;
  },
};

// Activity APIs
export const activityApi = {
  getItemActivity: async (itemId: string): Promise<ActivityLogEntry[]> => {
    const { data } = await api.get<ApiResponse<ActivityLogEntry[]>>(`/activity/item/${itemId}`);
    return (data.data || []).map(normalizeActivityEntry);
  },

  getLog: async (filters: ActivityFilters): Promise<ActivityLogResponse> => {
    const params = new URLSearchParams();
    params.append('page', String(filters.page));
    params.append('limit', String(filters.limit));
    params.append('dateRange', filters.dateRange);
    if (filters.search) params.append('search', filters.search);
    if (filters.eventTypes?.length) params.append('eventTypes', filters.eventTypes.join(','));
    if (filters.actorTypes?.length) params.append('actorTypes', filters.actorTypes.join(','));

    const { data } = await api.get<ApiResponse<ActivityLogResponse>>(`/activity?${params}`);
    const result = data.data!;
    return { ...result, items: result.items.map(normalizeActivityEntry) };
  },
};

// Health APIs
export const healthApi = {
  getStatus: async (): Promise<SystemHealthResponse> => {
    const { data } = await api.get<ApiResponse<SystemHealthResponse>>('/health/status');
    return data.data!;
  },
};

// Scan APIs
export const scanApi = {
  getCadence: async (days = 14): Promise<ScanCadenceRun[]> => {
    const { data } = await api.get<ApiResponse<ScanCadenceRun[]>>(`/scan/cadence?days=${days}`);
    return data.data ?? [];
  },

  trigger: async (): Promise<void> => {
    await api.post('/scan/trigger');
  },

  getStatus: async (): Promise<{ isRunning: boolean }> => {
    const { data } = await api.get<ApiResponse<{ isRunning: boolean }>>('/scan/status');
    return data.data ?? { isRunning: false };
  },
};

// API Key types
export type ApiKeyUseOutcome = 'ok' | 'invalid' | 'disabled';
export type ApiKeyUseSource = 'api' | 'mcp';

export interface ApiKeyUsageEntry {
  id: number;
  usedAt: string;
  outcome: ApiKeyUseOutcome;
  source: ApiKeyUseSource;
  method: string;
  path: string;
  ip: string | null;
  userAgent: string | null;
}

export interface ApiKeyUsageClient {
  userAgent: string | null;
  ip: string | null;
  requests: number;
  lastUsedAt: string;
}

export interface ApiKeyUsageSummary {
  lastUsedAt: string | null;
  totalRequests: number;
  requestsLast24h: number;
  requestsLast7d: number;
  refusedLast24h: number;
  lastRefusedAt: string | null;
  clients: ApiKeyUsageClient[];
  recent: ApiKeyUsageEntry[];
  retentionDays: number;
}

export interface ApiKeyInfo {
  apiKey: string;
  /** False: every request that presents the key is refused (REST and MCP). */
  enabled: boolean;
  /** The key comes from PRUNERR_API_KEY, so regenerating has no effect. */
  fromEnv: boolean;
  usage: ApiKeyUsageSummary;
}

// API Key APIs
export const apiKeyApi = {
  get: async (): Promise<ApiKeyInfo> => {
    const { data } = await api.get<ApiResponse<ApiKeyInfo>>('/settings/api-key');
    if (!data.data) throw new Error('Failed to get API key');
    return data.data;
  },

  setEnabled: async (enabled: boolean): Promise<ApiKeyInfo> => {
    const { data } = await api.put<ApiResponse<ApiKeyInfo>>('/settings/api-key', { enabled });
    if (!data.data) throw new Error('Failed to update API key access');
    return data.data;
  },

  clearUsage: async (): Promise<ApiKeyInfo> => {
    const { data } = await api.delete<ApiResponse<ApiKeyInfo>>('/settings/api-key/usage');
    if (!data.data) throw new Error('Failed to clear API key usage');
    return data.data;
  },

  regenerate: async (): Promise<ApiKeyInfo> => {
    const { data } = await api.post<ApiResponse<ApiKeyInfo>>('/settings/api-key/regenerate');
    if (!data.data) throw new Error('Failed to regenerate API key');
    return data.data;
  },
};

// Settings APIs
// Tasks page
export const tasksApi = {
  status: async (): Promise<TasksStatus> => {
    const { data } = await api.get<ApiResponse<TasksStatus>>('/tasks');
    return data.data!;
  },
  run: async (name: string): Promise<{ success: boolean; message?: string | null }> => {
    const { data } = await api.post<ApiResponse<TaskRun> & { message?: string | null }>(`/tasks/${encodeURIComponent(name)}/run`, undefined, { timeout: 600_000 });
    return { success: data.success, message: data.message };
  },
};

// Audit log (read-only)
export const auditApi = {
  list: async (filters: AuditFilters = {}): Promise<{ entries: AuditEntry[]; total: number }> => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (v !== undefined && v !== '' && v !== null) params.set(k, String(v));
    const { data } = await api.get<ApiResponse<AuditEntry[]> & { total?: number }>(`/audit${params.size ? `?${params}` : ''}`);
    return { entries: data.data ?? [], total: data.total ?? 0 };
  },
  verify: async (): Promise<AuditVerification> => {
    const { data } = await api.get<ApiResponse<AuditVerification>>('/audit/verify');
    return data.data!;
  },
  exportUrl: '/api/audit/export',
};

// Login sessions
export const sessionsApi = {
  list: async (): Promise<LoginSession[]> => {
    const { data } = await api.get<ApiResponse<LoginSession[]>>('/auth/sessions');
    return data.data ?? [];
  },
  revoke: async (id: string): Promise<void> => {
    await api.delete(`/auth/sessions/${encodeURIComponent(id)}`);
  },
};

// Sonarr/Radarr diagnostics, read through their own APIs
export const diagnosticsApi = {
  logs: async (service: DiagnosticsService, options: { level?: ArrLogLevel; limit?: number; search?: string } = {}): Promise<ServiceLogsResult> => {
    const params = new URLSearchParams();
    if (options.level) params.set('level', options.level);
    if (options.limit) params.set('limit', String(options.limit));
    if (options.search) params.set('search', options.search);
    const { data } = await api.get<ApiResponse<ServiceLogsResult>>(`/diagnostics/${service}/logs${params.size ? `?${params}` : ''}`);
    return data.data!;
  },
  health: async (service: DiagnosticsService): Promise<ServiceHealthResult> => {
    const { data } = await api.get<ApiResponse<ServiceHealthResult>>(`/diagnostics/${service}/health`);
    return data.data!;
  },
  activity: async (service: DiagnosticsService): Promise<ServiceActivityResult> => {
    const { data } = await api.get<ApiResponse<ServiceActivityResult>>(`/diagnostics/${service}/activity`);
    return data.data!;
  },
  deletionSetup: async (service: DiagnosticsService): Promise<DeletionSetupResult> => {
    const { data } = await api.get<ApiResponse<DeletionSetupResult>>(`/diagnostics/${service}/deletion-setup`);
    return data.data!;
  },
};

export const settingsApi = {
  get: async (): Promise<Settings> => {
    const { data } = await api.get<ApiResponse<Settings>>('/settings');
    return data.data!;
  },

  save: async (settings: Settings): Promise<Settings> => {
    const { data } = await api.put<ApiResponse<Settings>>('/settings', settings);
    return data.data!;
  },

  testConnection: async (
    service: string,
    config: ServiceConnection
  ): Promise<{ success: boolean; message: string }> => {
    const { data } = await api.post<ApiResponse<{ success: boolean; message: string }>>(
      `/settings/test/${service}`,
      config
    );
    return data.data!;
  },
};

// Webhook APIs
export const webhooksApi = {
  test: async (body: { url: string; secret?: string; event?: string }): Promise<{ status?: number }> => {
    const { data } = await api.post<ApiResponse<{ status?: number }> & { message?: string }>(
      '/webhooks/test',
      body
    );
    return data.data ?? {};
  },
};

// ============================================================================
// Login
// ============================================================================

export type AuthRole = 'admin' | 'operator' | 'viewer';

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  role: AuthRole;
  provider: 'oidc' | 'local';
  groups: string[];
  sessionExpiresAt: string;
}

export interface AuthMethods {
  oidc: { enabled: boolean; providerName: string | null; autoLogin: boolean };
  local: { enabled: boolean };
}

export interface AuthState {
  enabled: boolean;
  methods: AuthMethods;
  roles: Record<AuthRole, string>;
  mcpEnabled: boolean;
  user: AuthUser | null;
}

export const authApi = {
  me: async (): Promise<AuthState> => {
    const { data } = await api.get<ApiResponse<AuthState>>('/auth/me');
    if (!data.data) throw new Error('Failed to load login state');
    return data.data;
  },

  loginLocal: async (username: string, password: string): Promise<AuthUser> => {
    const { data } = await api.post<ApiResponse<{ user: AuthUser }>>('/auth/login/local', { username, password });
    if (!data.data) throw new Error('Login failed');
    return data.data.user;
  },

  logout: async (): Promise<void> => {
    await api.post('/auth/logout');
  },
};

/** Read-only view of how login is configured (it comes from the environment). */
export interface AuthSettingsInfo {
  enabled: boolean;
  sessionTtlHours: number;
  activeSessions: number;
  warnings: string[];
  roles: Record<AuthRole, string>;
  local: { enabled: false } | { enabled: true; username: string; role: AuthRole; usesHash: boolean };
  oidc:
    | { enabled: false }
    | {
        enabled: true;
        providerName: string;
        issuer: string;
        clientId: string;
        redirectUri: string | null;
        scopes: string[];
        groupsClaim: string;
        adminGroups: string[];
        operatorGroups: string[];
        viewerGroups: string[];
        defaultRole: AuthRole | 'none';
        autoLogin: boolean;
        provider: { issuer: string; discovery: string; reachable: boolean; error?: string };
      };
}

export const authSettingsApi = {
  get: async (): Promise<AuthSettingsInfo> => {
    const { data } = await api.get<ApiResponse<AuthSettingsInfo>>('/settings/auth');
    if (!data.data) throw new Error('Failed to load login configuration');
    return data.data;
  },
};

// ============================================================================
// MCP connector
// ============================================================================

export type McpToolGroup =
  | 'overview'
  | 'library'
  | 'actions'
  | 'queue'
  | 'rules'
  | 'collections'
  | 'scans'
  | 'history'
  | 'folders'
  | 'system';

export interface McpToolInfo {
  name: string;
  title: string;
  description: string;
  group: McpToolGroup;
  readOnly: boolean;
  destructive: boolean;
  requiresImmediateDeletion: boolean;
}

export interface McpInfo {
  enabled: boolean;
  disabledReason: 'auth_disabled' | 'env' | 'setting' | null;
  enabledByEnv: boolean;
  enabledBySetting: boolean;
  authEnabled: boolean;
  allowImmediateDeletion: boolean;
  endpoint: string;
  activeSessions: number;
  tools: McpToolInfo[];
  resources: string[];
  prompts: string[];
}

export interface McpGrant {
  pairId: string;
  clientId: string;
  clientName: string | null;
  userKey: string;
  username: string;
  role: 'admin' | 'operator' | 'viewer';
  scope: string;
  grantedAt: string;
  lastUsedAt: string | null;
  accessExpiresAt: string | null;
  refreshExpiresAt: string;
  /** A session opened with this grant is live right now. */
  live: boolean;
}

export interface McpLiveSession {
  sessionId: string;
  kind: 'apiKey' | 'oauth';
  clientId: string;
  username: string;
  pairId: string | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
}

export interface McpConnections {
  grants: McpGrant[];
  sessions: McpLiveSession[];
  apiKey: { lastUsedAt: string | null; clients: Array<{ userAgent: string | null; ip: string | null; requests: number; lastUsedAt: string }> };
}

export const mcpApi = {
  connections: async (): Promise<McpConnections> => {
    const { data } = await api.get<ApiResponse<McpConnections>>('/settings/mcp/connections');
    if (!data.data) throw new Error(data.error || 'Failed to load MCP connections');
    return data.data;
  },

  /** Revoke one OAuth grant: the client is signed out and must ask for permission again. */
  revokeConnection: async (pairId: string): Promise<{ sessionsClosed: number; message?: string }> => {
    const { data } = await api.delete<ApiResponse<{ sessionsClosed: number }>>(`/settings/mcp/connections/${encodeURIComponent(pairId)}`);
    return { sessionsClosed: data.data?.sessionsClosed ?? 0, message: data.message };
  },

  /** Forget a registered client entirely: every grant it holds, and its registration. */
  forgetClient: async (clientId: string): Promise<{ grantsRevoked: number; sessionsClosed: number; message?: string }> => {
    const { data } = await api.delete<ApiResponse<{ grantsRevoked: number; sessionsClosed: number }>>(`/settings/mcp/clients/${encodeURIComponent(clientId)}`);
    return { grantsRevoked: data.data?.grantsRevoked ?? 0, sessionsClosed: data.data?.sessionsClosed ?? 0, message: data.message };
  },

  get: async (): Promise<McpInfo> => {
    const { data } = await api.get<ApiResponse<McpInfo>>('/settings/mcp');
    if (!data.data) throw new Error('Failed to load MCP connector state');
    return data.data;
  },

  update: async (body: { enabled?: boolean; allowImmediateDeletion?: boolean }): Promise<McpInfo> => {
    const { data } = await api.put<ApiResponse<McpInfo>>('/settings/mcp', body);
    if (!data.data) throw new Error('Failed to update MCP connector');
    return data.data;
  },
};

export default api;

// Insights
export const insightsApi = {
  stack: async (refresh = false): Promise<StackHealthReport> => {
    const { data } = await api.get<ApiResponse<StackHealthReport>>(`/insights/stack${refresh ? '?refresh=true' : ''}`);
    if (!data.data) throw new Error(data.error || 'Failed to load stack health');
    return data.data;
  },
  acknowledge: async (id: string): Promise<StackHealthReport> => {
    const { data } = await api.post<ApiResponse<StackHealthReport>>('/insights/stack/acknowledge', { id });
    if (!data.data) throw new Error(data.error || 'Failed to acknowledge');
    return data.data;
  },
  unacknowledge: async (id: string): Promise<StackHealthReport> => {
    const { data } = await api.delete<ApiResponse<StackHealthReport>>(`/insights/stack/acknowledge/${encodeURIComponent(id)}`);
    if (!data.data) throw new Error(data.error || 'Failed to unacknowledge');
    return data.data;
  },
  library: async (refresh = false): Promise<LibraryQualityReport> => {
    const { data } = await api.get<ApiResponse<LibraryQualityReport>>(`/insights/library${refresh ? '?refresh=true' : ''}`);
    if (!data.data) throw new Error(data.error || 'Failed to load library quality');
    return data.data;
  },
  watching: async (refresh = false): Promise<WatchPatternsReport> => {
    const { data } = await api.get<ApiResponse<WatchPatternsReport>>(`/insights/watching${refresh ? '?refresh=true' : ''}`);
    if (!data.data) throw new Error(data.error || 'Failed to load watch patterns');
    return data.data;
  },
  playback: async (refresh = false): Promise<PlaybackFrictionReport> => {
    const { data } = await api.get<ApiResponse<PlaybackFrictionReport>>(`/insights/playback${refresh ? '?refresh=true' : ''}`);
    if (!data.data) throw new Error(data.error || 'Failed to load playback friction');
    return data.data;
  },
  history: async (days = 90): Promise<InsightSnapshot[]> => {
    const { data } = await api.get<ApiResponse<{ days: number; rows: InsightSnapshot[] }>>(`/insights/history?days=${days}`);
    return data.data?.rows ?? [];
  },
};
