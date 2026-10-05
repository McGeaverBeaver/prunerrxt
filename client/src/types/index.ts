import type { SupportedLanguage } from '@/i18n/languages';

// Media Types
export type MediaType = 'movie' | 'tv';
export type MediaStatus = 'active' | 'queued' | 'protected' | 'deleted';

export interface MediaItem {
  id: string;
  title: string;
  type: MediaType;
  year?: number;
  size: number;
  posterUrl?: string;
  watched: boolean;
  lastWatched?: string;
  addedAt: string;
  status: MediaStatus;
  isProtected: boolean;
  /** Collection info if protection is derived from a protected collection. */
  protectedByCollection?: { id: number; title: string } | null;
  /** Why the item itself is protected (null when only a collection protects it). */
  protectionReason?: string | null;
  protectedAt?: string | null;
  /** Set while Archive keeps the item because it could not be downloaded again. */
  archivedAt?: string | null;
  availability?: AvailabilityReport | null;
  plexId?: string;
  sonarrId?: number;
  radarrId?: number;
  /** TVDB ID for TV shows */
  tvdbId?: number;
  /** TMDB ID for movies and shows */
  tmdbId?: number;
  /** IMDB ID (e.g., tt1234567) */
  imdbId?: string;
  playCount?: number;
  watchedBy?: string[];
  resolution?: string;
  codec?: string;
  /** Someone started it, has not finished, and played it within the in-progress window. */
  inProgress?: boolean;
  /** 0..1 share watched; null when unknown. */
  watchCompletion?: number | null;
  watchState?: WatchState | null;
}

/** Per-viewer watch state computed at sync; see docs/watch-state.md. */
export interface WatchState {
  startedBy: string[];
  completedBy: string[];
  inProgressUsers: string[];
  lastPlayedByUser: Record<string, string>;
  episodesWatched: number;
  episodesTotal: number | null;
  completion: number | null;
  computedAt: string;
}

// Library
export interface LibraryFilters {
  search?: string;
  page: number;
  limit: number;
  type?: MediaType;
  status?: 'watched' | 'unwatched' | 'queued' | 'deleted' | 'in_progress' | 'protected' | 'archived';
  sortBy: string;
  sortOrder: 'asc' | 'desc';
}

export interface LibraryResponse {
  items: MediaItem[];
  total: number;
  page: number;
  totalPages: number;
}

// Deletion Actions
export type DeletionAction =
  | 'unmonitor_only'
  | 'delete_files_only'
  | 'unmonitor_and_delete'
  | 'full_removal';

// Localised labels/descriptions for these actions live in
// `client/src/lib/deletionActions.ts` (they're translated UI strings, not data).

// Rules
export type ConditionType =
  | 'unwatched_days'
  | 'last_watched_days'
  | 'size_greater'
  | 'added_before';

export type RuleType = 'age' | 'watch_status' | 'size' | 'quality' | 'custom';
export type RuleAction = 'flag' | 'delete' | 'notify';

export interface RuleCondition {
  type?: ConditionType;
  field?: string;  // New format uses field instead of type
  operator?: string;
  value: string | number | boolean | string[] | number[];
  params?: Record<string, unknown>;
}

// v2 nested condition tree types (mirrors server/src/rules/types.ts)
export type GroupLogic = 'AND' | 'OR' | 'NOT';

export interface ConditionLeaf {
  kind: 'condition';
  field: string;
  operator: string;
  value: unknown;
  params?: Record<string, unknown>;
  /** Client-only: stable id for React keys. Stripped before sending to server. */
  _uiId?: string;
}

export interface ConditionGroupNode {
  kind: 'group';
  logic: GroupLogic;
  children: ConditionNode[];
  /** Client-only: stable id for React keys. Stripped before sending to server. */
  _uiId?: string;
}

export type ConditionNode = ConditionLeaf | ConditionGroupNode;

export interface RuleConditionsV2 {
  version: 2;
  root: ConditionNode;
}

export interface Rule {
  id: string;
  name: string;
  type: RuleType;
  action: RuleAction;
  enabled: boolean;
  mediaType: 'all' | MediaType;
  /** Plex library section keys the rule targets. Empty/undefined = all libraries. */
  libraryKeys?: string[];
  /** v1 legacy flat array OR v2 tree. Server returns `conditionsV2` for tree form. */
  conditions: RuleCondition[] | RuleConditionsV2;
  /** v2 tree form populated by server on read. */
  conditionsV2?: RuleConditionsV2;
  gracePeriodDays: number;
  deletionAction?: DeletionAction;
  resetOverseerr?: boolean;
  priority?: number;
  createdAt: string;
  updatedAt: string;
}

// Queue
export interface QueueItem {
  id: string;
  mediaItemId: string;
  /** 'media' is a whole movie/show; 'episode' is a single queued episode. */
  kind?: 'media' | 'episode';
  title: string;
  type: MediaType;
  size: number;
  posterUrl?: string;
  queuedAt: string;
  deleteAt: string;
  matchedRule?: string;
  ruleId?: string;
  daysRemaining?: number;
  deletionAction: DeletionAction;
  deletionActionLabel: string;
  resetOverseerr: boolean;
  requestedBy?: string;
  tmdbId?: number;
  overseerrResetAt?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  /** Archive: the last re-acquisition check; absent for episodes and unchecked items. */
  availability?: AvailabilityReport;
  /** Archive is holding the item from automatic deletion until someone decides. */
  held?: boolean;
  heldReason?: HoldReason;
  /** Someone chose "delete anyway" on an at-risk item. */
  deleteAnyway?: boolean;
}

// Archive: can a title be downloaded again? (services/availabilityVerdict.ts)
export type AvailabilityVerdict = 'replaceable' | 'at_risk' | 'unknown';
export type AvailabilityReason =
  | 'no_releases'
  | 'downgrade'
  | 'smaller'
  | 'low_seeders'
  | 'missing_seasons'
  | 'not_linked'
  | 'indexers_down'
  | 'no_indexers'
  | 'no_service'
  | 'search_failed';
export type HoldReason = 'at_risk' | 'unknown' | 'unchecked';

/** Archive's checker is paused for one app: indexers down, rate limited, unreachable or failing. */
export interface ArchivePause {
  service: 'radarr' | 'sonarr';
  reason: 'indexers_down' | 'rate_limited' | 'search_failed' | 'unreachable';
  detail: string;
  since: string;
  until: string;
  failures: number;
}

export interface ArchiveStatus {
  enabled: boolean;
  paused: ArchivePause[];
  unchecked: number;
  lastPassAt: string | null;
}

export interface AvailabilityReport {
  verdict: AvailabilityVerdict;
  reasons: AvailabilityReason[];
  checkedAt: string;
  service: 'radarr' | 'sonarr' | null;
  releases: number;
  usenet: number;
  torrents: number;
  maxSeeders: number | null;
  best: { title: string; indexer: string; protocol: string; sizeBytes: number; resolution: number | null; qualityName: string; ageDays: number } | null;
  current: { sizeBytes: number | null; resolution: number | null; qualityName: string | null };
  indexers: { total: number; failing: number } | null;
  seasons?: { checked: number; withReleases: number };
  error?: string;
}

export interface AvailabilityCheckResult {
  report: AvailabilityReport;
  archived: boolean;
  hold: { held: boolean; reason: HoldReason | null };
}

export type ArchiveMode = 'ask' | 'archive' | 'delete';

export interface ArchiveSettings {
  enabled?: boolean;
  mode?: ArchiveMode;
  minSeeders?: number;
  recheckDays?: number;
}

// Unmanaged folders (GET /api/folders)
export interface FolderMapping {
  remotePath: string;
  localPath: string;
}

/** A volume mounted into the Prunerr container, as GET /api/folders/mounts reports it. */
export interface ContainerMount {
  mountPoint: string;
  fsType: string;
  source: string;
  readOnly: boolean;
  /** Directories under the mount point, up to two levels deep, as absolute paths. */
  subfolders: string[];
  /** The listing stopped at the cap; deeper paths must be typed. */
  truncated: boolean;
}

export interface ContainerMountsResult {
  /** False when the server cannot read a mount table (not Linux). */
  supported: boolean;
  mounts: ContainerMount[];
}

export interface OrphanFolder {
  id: string;
  service: 'sonarr' | 'radarr';
  serviceLabel: 'Sonarr' | 'Radarr';
  rootFolder: string;
  name: string;
  path: string;
  localPath: string | null;
  sizeBytes: number | null;
  fileCount: number | null;
  videoFiles: string[];
  modifiedAt: string | null;
  ignored: boolean;
  canDelete: boolean;
  /** Entries whose owner or mode differ from the configured ones; null when unmapped. */
  permissionIssues: number | null;
  /** Whether Prunerr can create and remove entries in the folder right now. */
  writable: boolean | null;
  guess: { title: string; year: number | null; tmdbId: number | null; tvdbId: number | null; imdbId: string | null };
}

export type FolderJobAction = 'delete' | 'import' | 'fix_permissions';
export type FolderJobStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export interface FolderJobParams {
  candidateId?: number;
  qualityProfileId?: number;
  monitored?: boolean;
}

/** One folder's share of a bulk delete, import or permission fix. */
export interface FolderJob {
  id: number;
  batchId: string;
  folderId: string;
  service: 'sonarr' | 'radarr';
  serviceLabel: 'Sonarr' | 'Radarr';
  name: string;
  path: string;
  sizeBytes: number | null;
  action: FolderJobAction;
  params: FolderJobParams;
  requestedBy: string;
  status: FolderJobStatus;
  message: string | null;
  error: string | null;
  result: Record<string, unknown> | null;
  attempts: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

export interface FolderBatchSummary {
  batchId: string;
  action: FolderJobAction;
  requestedBy: string;
  total: number;
  pending: number;
  running: number;
  done: number;
  failed: number;
  cancelled: number;
  freedBytes: number;
  createdAt: string;
  finishedAt: string | null;
}

export interface FolderBatchResult {
  batchId: string;
  queued: FolderJob[];
  alreadyQueued: number;
  skipped: Array<{ id: string; error: string }>;
  message?: string;
}

export type ImportConfidence = 'exact' | 'likely' | 'weak' | 'none';

/** The server's best guess at what a folder is, for the bulk import review. */
export interface ImportSuggestion {
  folderId: string;
  name: string;
  path: string;
  service: 'sonarr' | 'radarr';
  serviceLabel: 'Sonarr' | 'Radarr';
  sizeBytes: number | null;
  term: string;
  candidate: FolderCandidate | null;
  confidence: ImportConfidence;
  reason: string;
}

export interface PermissionSettings {
  uid: number;
  gid: number;
  dirMode: string;
  fileMode: string;
  autoFix: boolean;
}

export interface PermissionCapabilities {
  uid: number;
  gid: number;
  canChown: boolean;
  canChmod: boolean;
  reason: string | null;
}

export interface PermissionReport {
  path: string;
  checked: number;
  wrongOwner: number;
  wrongMode: number;
  unreadable: number;
  writable: boolean;
  examples: Array<{ path: string; uid: number; gid: number; mode: string; kind: 'dir' | 'file' }>;
  needsFix: boolean;
}

export interface PermissionFixResult {
  path: string;
  changed: number;
  unchanged: number;
  failed: Array<{ path: string; error: string }>;
}

export interface OrphanServiceState {
  service: 'sonarr' | 'radarr';
  serviceLabel: 'Sonarr' | 'Radarr';
  configured: boolean;
  rootFolders: Array<{ path: string; accessible: boolean; localPath: string | null; unmapped: number }>;
  error: string | null;
}

export interface OrphanFolderListing {
  folders: OrphanFolder[];
  services: OrphanServiceState[];
  mappings: FolderMapping[];
  totalSizeBytes: number;
  unsized: number;
  scannedAt: string;
}

export interface FolderCandidate {
  id: number;
  title: string;
  year: number | null;
  overview: string | null;
  posterUrl: string | null;
  inLibrary: boolean;
  existingId: number | null;
}

export interface QualityProfile {
  id: number;
  name: string;
}

// Background deletion jobs (GET /api/deletion-jobs)
export type DeletionJobStatus = 'pending' | 'running' | 'verifying' | 'done' | 'reconciled' | 'failed' | 'cancelled';

export interface DeletionJob {
  id: number;
  queueId: string;
  kind: 'media' | 'episode';
  mediaItemId: number;
  title: string;
  type: string;
  service: 'Sonarr' | 'Radarr' | null;
  size: number;
  deletionAction: string;
  resetOverseerr: boolean;
  ruleId: number | null;
  batchId: string | null;
  requestedBy: string;
  status: DeletionJobStatus;
  stage: string | null;
  step: string | null;
  message: string | null;
  stepStartedAt: string | null;
  attempts: number;
  error: string | null;
  upstreamStatus: number | null;
  failedStep: string | null;
  failedService: string | null;
  fileSizeFreed: number | null;
  overseerrReset: boolean | null;
  stepDurationsMs: Record<string, number>;
  /** Lines from Sonarr/Radarr's own log explaining a failure. */
  upstreamLog?: string[];
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

// History
export interface HistoryItem {
  id: string;
  /** Media item this entry was deleted from; null when the row was pruned. */
  mediaId?: number | null;
  title: string;
  type: MediaType;
  year?: number;
  size: number;
  deletedAt: string;
  deletionReason: 'rule' | 'manual';
  matchedRule?: string;
  ruleId?: string;
  deletionAction?: DeletionAction;
  overseerrReset?: boolean;
  tmdbId?: number;
}

export interface HistoryFilters {
  search?: string;
  page: number;
  limit: number;
  dateRange: 'all' | '7d' | '30d' | '90d';
}

export interface HistoryResponse {
  items: HistoryItem[];
  total: number;
  stats: {
    totalDeleted: number;
    totalSpaceReclaimed: number;
  };
}

// Stats
/** One volume disk pressure watches: a typed path read in this container, or a volume Sonarr/Radarr reported. */
export interface MonitoredVolume {
  path: string;
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  key: string;
  source?: 'statfs' | 'sonarr' | 'radarr';
  reportedBy?: string[];
  targetBytes: number;
  criticalBytes: number;
  severity: 'ok' | 'soft' | 'critical';
}

export interface DashboardStats {
  disks?: MonitoredVolume[];
  totalStorage: number;
  usedStorage: number;
  reclaimableSpace: number;
  movieCount: number;
  tvShowCount: number;
  tvEpisodeCount: number;
  unwatchedMovies: number;
  unwatchedShows: number;
  itemsMarkedForDeletion: number;
  scannedToday: number;
  scanTrend: number;
  reclaimedThisWeek: number;
  reclaimedTrend: number;
  activeRules: number;
  collectionCount: number;
  protectedCollections: number;

  // Disk-pressure / real free space (best-effort; null when unreadable)
  diskPressureEnabled?: boolean;
  diskObserveOnly?: boolean;
  diskFreeBytes?: number | null;
  diskTotalBytes?: number | null;
  diskUsedBytes?: number | null;
  diskTargetBytes?: number | null;
  diskCriticalBytes?: number | null;
  diskPressureSeverity?: 'ok' | 'soft' | 'critical' | null;
}

export interface UpcomingDeletion {
  id: string;
  /** Library item behind this queue entry — an episode entry points at its show. */
  mediaItemId?: string;
  title: string;
  type: MediaType;
  size: number;
  deleteAt: string;
  daysRemaining?: number;
  /** Archive is holding it for a decision; it will not go when the date passes. */
  held?: boolean;
  heldReason?: HoldReason;
}

// Sonarr/Radarr diagnostics (GET /api/diagnostics/:service/*)
export type DiagnosticsService = 'sonarr' | 'radarr';
export type ArrLogLevel = 'info' | 'warn' | 'error';

export interface ArrLogRecord {
  id: number;
  time: string;
  level: string;
  logger: string;
  message: string;
  exception?: string;
  exceptionType?: string;
}

export interface ServiceLogsResult {
  service: DiagnosticsService;
  level: ArrLogLevel;
  records: ArrLogRecord[];
  lines: string[];
}

export interface ServiceHealthResult {
  service: DiagnosticsService;
  version: string | null;
  startTime: string | null;
  health: Array<{ source: string; type: string; message: string; wikiUrl?: string }>;
}

export interface ArrCommand {
  id: number;
  name: string;
  commandName?: string;
  status: string;
  queued?: string;
  started?: string;
  ended?: string;
  duration?: string;
  message?: string;
  trigger?: string;
}

export interface ServiceActivityResult {
  service: DiagnosticsService;
  running: ArrCommand[];
  queued: ArrCommand[];
  recent: ArrCommand[];
}

export interface DeletionSetupResult {
  service: DiagnosticsService;
  recycleBin: string | null;
  recycleBinCleanupDays: number | null;
  rootFolders: Array<{ id: number; path: string; accessible: boolean; freeSpace?: number; sameMountAsRecycleBin: boolean | null }>;
  warnings: string[];
}

export interface Recommendation {
  id: string;
  title: string;
  type: MediaType;
  size: number;
  posterUrl?: string;
  lastWatched?: string;
  daysSinceWatched?: number;
  neverWatched: boolean;
  addedAt: string;
  playCount: number;
  reason: string;
}

export interface RecommendationsResponse {
  items: Recommendation[];
  total: number;
  totalReclaimableSpace: number;
  criteria: {
    unwatchedDays: number;
  };
}

// Collections
export interface Collection {
  id: number;
  tmdbId: number;
  title: string;
  overview?: string;
  itemCount: number;
  isProtected: boolean;
  protectionReason?: string | null;
  posterUrl?: string | null;
  protectedAt?: string | null;
  lastSyncedAt?: string | null;
}

// Storage Snapshots
export interface StorageSnapshot {
  totalSize: number;
  movieSize: number;
  showSize: number;
  itemCount: number;
  movieCount: number;
  showCount: number;
  spaceReclaimed: number;
  capturedAt: string;
}

// Settings
export interface ServiceConnection {
  url?: string;
  apiKey?: string;
  token?: string;
  enabled?: boolean;
}

export interface NotificationSettings {
  discordEnabled: boolean;
  discordWebhook?: string;
  scanNotify?: 'always' | 'flagged_only' | 'never';
  notifyOnQueue?: boolean;
  notifyBeforeDeletion?: boolean;
  notifyOnDeletion?: boolean;
  // Language for outgoing notification text (Discord). Persisted as
  // `notifications_language` and read server-side at send time.
  language?: SupportedLanguage;
}

export interface ScheduleSettings {
  enabled: boolean;
  interval: 'hourly' | 'daily' | 'weekly';
  time: string;
  dayOfWeek?: number;  // 0-6, Sunday=0, only used when interval='weekly'
  autoProcess: boolean;
  historyLookbackDays?: number;
}

export interface PlexSyncSettings {
  enabled: boolean;
  interval: 'hourly' | 'daily' | 'weekly';
  time: string;
  dayOfWeek?: number;  // 0-6, Sunday=0, only used when interval='weekly'
}

export interface DisplaySettings {
  dateFormat: 'relative' | 'absolute' | 'iso';
  timeFormat: '12h' | '24h';
  fileSizeUnit: 'auto' | 'MB' | 'GB' | 'TB';
  language: SupportedLanguage;
}

/** Which media server backend Prunerr reads the library from. */
export type MediaServerType = 'plex' | 'jellyfin' | 'emby';

export interface Settings {
  /** Defaults to 'plex' when the server has never been told otherwise. */
  mediaServerType?: MediaServerType;
  services: {
    plex?: ServiceConnection;
    /** Shared by Jellyfin and Emby; mediaServerType says which is in use. */
    jellyfin?: ServiceConnection;
    tautulli?: ServiceConnection;
    tracearr?: ServiceConnection;
    sonarr?: ServiceConnection;
    radarr?: ServiceConnection;
    overseerr?: ServiceConnection;
    unraid?: ServiceConnection;
  };
  notifications?: NotificationSettings;
  schedule?: ScheduleSettings;
  plexSync?: PlexSyncSettings;
  display?: DisplaySettings;
  watchHistory?: { provider?: string; lookback_days?: string };
  exclusionPatterns?: Array<{ field: string; operator: string; value: string }>;
  excludedLibraryKeys?: string[];
  webhooks?: WebhookTarget[];
  diskPressure?: DiskPressureSettings;
  archive?: ArchiveSettings;
}

// Events a webhook target / notification can opt into. Mirrors the server
// NotificationEvent union.
export type NotificationEventName =
  | 'ITEMS_MARKED'
  | 'DELETION_IMMINENT'
  | 'DELETION_COMPLETE'
  | 'SCAN_COMPLETE'
  | 'SCAN_ERROR'
  | 'DELETION_ERROR'
  | 'DISK_PRESSURE_TRIGGERED';

export interface WebhookTarget {
  id: string;
  name?: string;
  url: string;
  events: NotificationEventName[];
  enabled: boolean;
  secret?: string;
}

export interface DiskPressureSettings {
  enabled?: boolean;
  observeOnly?: boolean;
  paths?: string[];
  /** Also watch the volumes Sonarr and Radarr report (default on). */
  includeArrVolumes?: boolean;
  targetMode?: 'percent' | 'absolute';
  targetValue?: number;
  criticalValue?: number;
  bufferGb?: number;
  softGraceDays?: number;
  criticalGraceDays?: number;
  criticalAutoProcess?: boolean;
  deletionAction?: string;
  maxItemsPerRun?: number;
  maxGbPerRun?: number;
  intervalMinutes?: number;
  unwatchedDays?: number;
}

// Unraid Types
export interface UnraidDisk {
  name: string;
  device: string;
  size: number;
  used: number;
  free: number;
  usedPercent: number;
  temp?: number;
  status: 'active' | 'standby' | 'error' | 'unknown';
  type: 'data' | 'parity' | 'cache';
  filesystem?: string;
}

export interface UnraidStats {
  configured: boolean;
  arrayState: 'Started' | 'Stopped' | 'Syncing' | 'Unknown';
  totalCapacity: number;
  usedCapacity: number;
  freeCapacity: number;
  usedPercent: number;
  disks: UnraidDisk[];
  lastUpdated: string;
  trend?: number[];
  growthPerMonth?: number;
  forecastFullMonths?: number;
  health?: {
    parityValid: boolean;
    lastParityCheck?: string;
    smartWarnings?: number;
    spinDownEligible?: number;
  };
}

// API Response Types
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

// Activity Log Types
export interface ActivityLogEntry {
  id: number;
  eventType: 'scan' | 'deletion' | 'rule_match' | 'protection' | 'manual_action' | 'error';
  action: string;
  actorType: 'scheduler' | 'user' | 'rule';
  actorId: string | null;
  actorName: string | null;
  targetType: string | null;
  targetId: number | null;
  targetTitle: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface ActivityFilters {
  page: number;
  limit: number;
  dateRange: '24h' | '7d' | '30d' | 'all';
  eventTypes?: string[];
  actorTypes?: string[];
  search?: string;
}

export interface ActivityLogResponse {
  items: ActivityLogEntry[];
  total: number;
  page: number;
  limit: number;
}

// Health Status Types
export interface ServiceHealthStatus {
  service: string;
  configured: boolean;
  connected: boolean;
  responseTimeMs?: number;
  error?: string;
  lastChecked: string;
}

export interface SchedulerStatus {
  isRunning: boolean;
  lastScan: string | null;
  nextRun: string | null;
  scanSchedule: string;
  lastSync: string | null;           // last successful Plex sync
  lastSyncAt: string | null;         // last sync attempt finish (success OR failure)
  lastSyncSuccess: boolean | null;
  nextSync: string | null;
  syncSchedule: string;
}

export interface SystemHealthResponse {
  services: ServiceHealthStatus[];
  scheduler: SchedulerStatus;
  overall: 'healthy' | 'degraded' | 'unhealthy';
}

/** One day in the Schedule card's cadence ribbon (GET /api/scan/cadence). */
export interface ScanCadenceRun {
  date: string;                       // ISO timestamp (real event, or noon filler)
  status: 'ok' | 'skipped' | 'failed';
  files: number;                      // items pruned that day
  gb: number;                         // storage reclaimed, GB
  dur: number;                        // scan duration, seconds (0 if no scan ran)
  flagged: number;                    // items the day's scan flagged (pruning may lag)
  timed: boolean;                     // whether `date` reflects a real timestamp
}

// Sonarr Series Detail Types (GET /api/library/:id/sonarr)
export type SonarrEpisodeState =
  | 'downloaded'
  | 'downloading'
  | 'missing'
  | 'unaired'
  | 'unmonitored';

export interface SonarrEpisodeFileSummary {
  id: number;
  size: number;
  relativePath?: string;
  path?: string;
  dateAdded?: string;
  quality?: string;
  qualityRevision?: 'PROPER' | 'REPACK';
  qualityCutoffNotMet: boolean;
  releaseGroup?: string;
  sceneName?: string;
  languages?: string[];
  resolution?: string;
  videoCodec?: string;
  videoBitrate?: number;
  audioCodec?: string;
  audioChannels?: number;
  subtitles?: string[];
  runTime?: string;
}

export interface SonarrEpisodeDownload {
  status: string;
  state?: string;
  progress: number;
  size: number;
  sizeleft: number;
  estimatedCompletionTime?: string;
  errorMessage?: string;
  title?: string;
}

/** A queued deletion for one episode. */
export interface SonarrEpisodeQueued {
  id: number;
  action: string;
  markedAt: string;
  deleteAfter: string;
}

export interface SonarrEpisodeSummary {
  id: number;
  seasonNumber: number;
  episodeNumber: number;
  title: string;
  airDateUtc?: string;
  monitored: boolean;
  hasFile: boolean;
  state: SonarrEpisodeState;
  file?: SonarrEpisodeFileSummary;
  download?: SonarrEpisodeDownload;
  queued?: SonarrEpisodeQueued;
}

export interface SonarrSeasonSummary {
  seasonNumber: number;
  monitored: boolean;
  episodeCount: number;
  airedCount: number;
  episodeFileCount: number;
  sizeOnDisk: number;
  missingCount: number;
  downloadingCount: number;
  cutoffUnmetCount: number;
  queuedCount: number;
  percentComplete: number;
  episodes: SonarrEpisodeSummary[];
}

export interface SonarrSeriesSummary {
  id: number;
  title: string;
  status: string;
  ended: boolean;
  monitored: boolean;
  seriesType: string;
  network?: string;
  path?: string;
  rootFolderPath?: string;
  qualityProfileId?: number;
  qualityProfileName?: string;
  runtime?: number;
  certification?: string;
  genres: string[];
  tags: string[];
  added?: string;
  previousAiring?: string;
  nextAiring?: string;
  airTime?: string;
}

export interface SonarrSeriesTotals {
  seasonCount: number;
  episodeCount: number;
  airedCount: number;
  episodeFileCount: number;
  sizeOnDisk: number;
  missingCount: number;
  downloadingCount: number;
  cutoffUnmetCount: number;
  queuedCount: number;
  percentComplete: number;
}

/**
 * `configured` is false when no Sonarr connection is set up; `linked` is false
 * when Sonarr is connected but this item has no matching series.
 */
export interface SonarrSeriesDetailResponse {
  configured: boolean;
  linked: boolean;
  fetchedAt?: string;
  series?: SonarrSeriesSummary;
  totals?: SonarrSeriesTotals;
  seasons?: SonarrSeasonSummary[];
  /** Recent Sonarr history for the series, newest first. */
  history?: SonarrHistoryEvent[];
}

export type SonarrHistoryEventType = 'grabbed' | 'imported' | 'upgraded' | 'deleted' | 'failed';

export interface SonarrHistoryEvent {
  id: number;
  episodeId: number;
  seasonNumber: number;
  episodeNumber: number;
  episodeTitle: string;
  eventType: SonarrHistoryEventType;
  date: string;
  quality?: string;
  sourceTitle?: string;
}

/** Deletion actions that apply to a single episode (no full series removal). */
export type EpisodeDeletionAction = 'unmonitor_only' | 'delete_files_only' | 'unmonitor_and_delete';

export interface EpisodeDeletionRequest {
  episodeIds?: number[];
  seasonNumbers?: number[];
  deletionAction: EpisodeDeletionAction;
  gracePeriodDays: number;
  /** 'now' bypasses the grace period and deletes straight away. */
  mode: 'queue' | 'now';
}

export interface EpisodeDeletionResult {
  queued: number;
  alreadyQueued: number;
  deleted: number;
  failed: number;
  freedBytes: number;
  errors?: Array<{ title: string; error?: string }>;
}

// ============================================================================
// Insights
// ============================================================================

export type InsightSeverity = 'ok' | 'info' | 'warning' | 'critical';
export type InsightSource = 'prunerr' | 'mediaServer' | 'sonarr' | 'radarr' | 'tautulli' | 'tracearr' | 'overseerr' | 'unraid';

export interface InsightItem {
  id: string;
  severity: InsightSeverity;
  source: InsightSource;
  title: string;
  detail?: string;
  href?: string;
  external?: boolean;
  acknowledged?: { at: string };
}

export interface InsightCounts {
  critical: number;
  warning: number;
  info: number;
  ok: number;
}

export interface ArrHealthItem {
  source: string;
  type: string;
  message: string;
  wikiUrl?: string;
}

export interface ArrQueueStatus {
  totalCount: number;
  count: number;
  unknownCount: number;
  errors: boolean;
  warnings: boolean;
  unknownErrors: boolean;
  unknownWarnings: boolean;
}

export interface StackServiceReport {
  service: 'sonarr' | 'radarr';
  label: 'Sonarr' | 'Radarr';
  reachable: boolean;
  version: string | null;
  health: ArrHealthItem[];
  queue: ArrQueueStatus | null;
  rootFolders: Array<{ path: string; accessible: boolean; freeSpace: number | null }>;
}

export interface StackHealthReport {
  checkedAt: string;
  overall: InsightSeverity;
  counts: InsightCounts;
  items: InsightItem[];
  connections: ServiceHealthStatus[];
  arr: StackServiceReport[];
  acknowledgedCount: number;
}

export type ResolutionBucket = '4K' | '1440p' | '1080p' | '720p' | 'SD' | 'Unknown';

export interface ShareBucket {
  label: string;
  count: number;
  bytes: number;
  countShare: number;
  bytesShare: number;
}

export interface LowQualityItem {
  id: number;
  title: string;
  type: 'movie' | 'show';
  year: number | null;
  resolution: ResolutionBucket;
  codec: string | null;
  sizeBytes: number;
  playCount: number;
  lastWatchedAt: string | null;
  addedAt: string | null;
}

export interface CutoffReport {
  service: 'sonarr' | 'radarr';
  label: 'Sonarr' | 'Radarr';
  belowCutoff: number | null;
  unit: 'movies' | 'episodes';
}

export interface LibraryQualityReport {
  checkedAt: string;
  overall: InsightSeverity;
  counts: InsightCounts;
  items: InsightItem[];
  totals: { items: number; movies: number; shows: number; bytes: number };
  byResolution: ShareBucket[];
  byCodec: ShareBucket[];
  hdr: { count: number; share: number; byFormat: Array<{ label: string; count: number }> };
  bitrateByResolution: Array<{ label: string; avgKbps: number; samples: number }>;
  cutoff: CutoffReport[];
  lowQualityUnwatched: LowQualityItem[];
  lowQualityUnwatchedBytes: number;
  lowQualityUnwatchedCount: number;
}

export type SessionProvider = 'tautulli' | 'tracearr' | 'mediaServer' | 'none';

export interface WeekPoint {
  weekStart: string;
  plays: number;
  users: number;
  movies: number;
  episodes: number;
}

export interface ViewerStat {
  user: string;
  plays: number;
  lastSeen: string;
  share: number;
}

export interface QuietItem {
  id: number;
  title: string;
  type: 'movie' | 'show';
  year: number | null;
  sizeBytes: number;
  playCount: number;
  lastWatchedAt: string | null;
  addedAt: string | null;
}

export interface WatchPatternsReport {
  checkedAt: string;
  overall: InsightSeverity;
  counts: InsightCounts;
  items: InsightItem[];
  provider: SessionProvider;
  note: string | null;
  windowDays: number;
  weekly: WeekPoint[];
  last30: { plays: number; users: number; movies: number; episodes: number; hoursWatched: number | null };
  previous30: { plays: number; users: number };
  knownUsers: number;
  viewers: ViewerStat[];
  topShows: Array<{ title: string; plays: number; users: number }>;
  topMovies: Array<{ title: string; plays: number; users: number }>;
  library: {
    items: number;
    bytes: number;
    neverPlayed: { count: number; bytes: number };
    neverPlayedOld: { count: number; bytes: number };
    playedLast90: { count: number };
    quietOverYear: { count: number; bytes: number };
  };
  quietLargest: QuietItem[];
}

export interface DecisionShare {
  directPlay: number;
  directStream: number;
  transcode: number;
  total: number;
}

export interface ClientFriction {
  client: string;
  platform: string;
  plays: number;
  transcodes: number;
  transcodeRate: number;
  codecs: string[];
}

export interface TitleFriction {
  title: string;
  mediaType: 'movie' | 'episode' | 'other';
  plays: number;
  transcodes: number;
  transcodeRate: number;
  codec: string | null;
  resolution: string | null;
  mediaItemId: number | null;
}

export interface AbandonedPlay {
  title: string;
  user: string;
  client: string;
  stoppedAt: string;
  percentComplete: number;
  transcode: boolean;
}

export interface PlaybackFrictionReport {
  checkedAt: string;
  overall: InsightSeverity;
  counts: InsightCounts;
  items: InsightItem[];
  provider: SessionProvider;
  available: boolean;
  note: string | null;
  windowDays: number;
  decisions: DecisionShare;
  clients: ClientFriction[];
  titles: TitleFriction[];
  abandoned: { count: number; rate: number; recent: AbandonedPlay[] };
  retried: number;
}

export interface InsightSnapshot {
  capturedAt: string;
  stackCritical: number;
  stackWarning: number;
  libraryItems: number;
  libraryBytes: number;
  sdCount: number;
  lowQualityUnwatchedBytes: number;
  neverPlayedCount: number;
  neverPlayedBytes: number;
  quietYearBytes: number;
  plays30: number;
  viewers30: number;
  transcodeRate30: number | null;
}
