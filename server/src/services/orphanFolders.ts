/**
 * Folders on disk that Sonarr and Radarr are not managing.
 *
 * Each app reports, per root folder, the sub-folders that belong to none of
 * its movies or series ("unmapped folders"): leftovers from a manual move,
 * a failed import, a title removed from the app with "delete files" off, or
 * media copied in by hand. Prunerr lists them from both apps, and offers the
 * two things worth doing with such a folder: import it into the app that
 * owns that root folder (a lookup picks the title, the app then scans the
 * folder in place), or delete it.
 *
 * Sonarr and Radarr have no API to delete an arbitrary folder, so deleting
 * needs Prunerr to see the files itself: a folder mapping says which local
 * path corresponds to a root folder as the app sees it. With a mapping,
 * Prunerr also reports each folder's size and contents.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import settingsRepo from '../db/repositories/settings';
import { logActivity } from '../db/repositories/activity';
import logger from '../utils/logger';
import { getRadarrService, getSonarrService } from './init';
import { ServiceNotConfiguredError, serviceLabel, type DiagnosticsService } from './serviceDiagnostics';
import type { ArrRootFolder } from './arrDiagnostics';
import type { RadarrMovie, SonarrSeries } from './types';
import {
  explainPermissionError,
  fixPermissions,
  getPermissionCapabilities,
  getPermissionSettings,
  inspectPermissions,
  isPermissionError,
  type FixResult,
  type PermissionReport,
} from './permissions';

// ============================================================================
// Settings: folder mappings and the ignore list
// ============================================================================

export const FOLDER_MAPPINGS_SETTING = 'media_folder_mappings';
export const IGNORED_FOLDERS_SETTING = 'orphan_folders_ignored';

export interface FolderMapping {
  /** Path prefix as Sonarr/Radarr see it, e.g. `/movies`. */
  remotePath: string;
  /** The same location as Prunerr sees it, e.g. `/media/movies`. */
  localPath: string;
}

function normalisePath(p: string): string {
  const trimmed = p.trim().replace(/\\/g, '/');
  if (trimmed.length > 1 && trimmed.endsWith('/')) return trimmed.slice(0, -1);
  return trimmed;
}

export function getFolderMappings(): FolderMapping[] {
  const raw = settingsRepo.getJson<unknown>(FOLDER_MAPPINGS_SETTING, []);
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m): m is FolderMapping => !!m && typeof m === 'object' && typeof (m as FolderMapping).remotePath === 'string' && typeof (m as FolderMapping).localPath === 'string')
    .map((m) => ({ remotePath: normalisePath(m.remotePath), localPath: normalisePath(m.localPath) }))
    .filter((m) => m.remotePath.length > 0 && m.localPath.length > 0);
}

export function setFolderMappings(mappings: FolderMapping[]): FolderMapping[] {
  const cleaned = mappings
    .map((m) => ({ remotePath: normalisePath(m.remotePath ?? ''), localPath: normalisePath(m.localPath ?? '') }))
    .filter((m) => m.remotePath.length > 0 && m.localPath.length > 0);
  for (const m of cleaned) {
    if (!path.isAbsolute(m.localPath)) throw new Error(`Local path must be absolute: ${m.localPath}`);
    if (!m.remotePath.startsWith('/') && !/^[A-Za-z]:/.test(m.remotePath)) {
      throw new Error(`Service path must be absolute: ${m.remotePath}`);
    }
  }
  settingsRepo.setJson(FOLDER_MAPPINGS_SETTING, cleaned);
  invalidateCache();
  return cleaned;
}

/** The local path for a path as the service sees it, by longest mapping prefix. */
export function toLocalPath(remotePath: string, mappings: FolderMapping[] = getFolderMappings()): string | null {
  const target = normalisePath(remotePath);
  let best: FolderMapping | null = null;
  for (const m of mappings) {
    if (target === m.remotePath || target.startsWith(`${m.remotePath}/`)) {
      if (!best || m.remotePath.length > best.remotePath.length) best = m;
    }
  }
  if (!best) return null;
  const rest = target.slice(best.remotePath.length);
  return path.posix.join(best.localPath, rest.replace(/^\//, ''));
}

function getIgnored(): Set<string> {
  const raw = settingsRepo.getJson<unknown>(IGNORED_FOLDERS_SETTING, []);
  return new Set(Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []);
}

function setIgnored(set: Set<string>): void {
  settingsRepo.setJson(IGNORED_FOLDERS_SETTING, [...set].sort());
}

// ============================================================================
// Shapes
// ============================================================================

export type OrphanService = DiagnosticsService;

export interface OrphanFolder {
  /** Stable id: `${service}:${path}`, URL-safe. */
  id: string;
  service: OrphanService;
  serviceLabel: 'Sonarr' | 'Radarr';
  rootFolder: string;
  name: string;
  /** As the service sees it. */
  path: string;
  /** As Prunerr sees it, when a mapping covers it. */
  localPath: string | null;
  sizeBytes: number | null;
  fileCount: number | null;
  /** A few of the video files inside, relative to the folder. */
  videoFiles: string[];
  modifiedAt: string | null;
  ignored: boolean;
  /** Whether Prunerr can delete it (mapped and present locally). */
  canDelete: boolean;
  /** Entries whose owner or mode differ from the configured ones; null when unmapped. */
  permissionIssues: number | null;
  /** Whether Prunerr can create and remove entries in the folder as it is now. */
  writable: boolean | null;
  /** Title and year parsed from the folder name, and an id tag if it carries one. */
  guess: { title: string; year: number | null; tmdbId: number | null; tvdbId: number | null; imdbId: string | null };
}

export interface OrphanServiceState {
  service: OrphanService;
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
  /** Folders whose size is unknown because no mapping covers them. */
  unsized: number;
  scannedAt: string;
}

export interface FolderCandidate {
  /** tmdbId for movies, tvdbId for series. */
  id: number;
  title: string;
  year: number | null;
  overview: string | null;
  posterUrl: string | null;
  /** Already in the app (so importing would collide). */
  inLibrary: boolean;
  existingId: number | null;
}

export interface QualityProfile {
  id: number;
  name: string;
}

// ============================================================================
// Ids and parsing
// ============================================================================

export function folderId(service: OrphanService, folderPath: string): string {
  return Buffer.from(`${service}:${folderPath}`, 'utf8').toString('base64url');
}

export function parseFolderId(id: string): { service: OrphanService; path: string } | null {
  let decoded: string;
  try {
    decoded = Buffer.from(id, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const sep = decoded.indexOf(':');
  if (sep <= 0) return null;
  const service = decoded.slice(0, sep);
  const folderPath = decoded.slice(sep + 1);
  if ((service !== 'sonarr' && service !== 'radarr') || !folderPath) return null;
  return { service, path: folderPath };
}

/**
 * `Deepwater Horizon (2016) [imdb-tt1860357]` → title, year and any id tag
 * that Radarr/Sonarr naming schemes put in folder names.
 */
export function parseFolderName(name: string): OrphanFolder['guess'] {
  let work = name.trim();
  const tmdb = work.match(/\{?\[?tmdb(?:id)?[-=: ]?(\d+)\]?\}?/i);
  const tvdb = work.match(/\{?\[?tvdb(?:id)?[-=: ]?(\d+)\]?\}?/i);
  const imdb = work.match(/\{?\[?imdb(?:id)?[-=: ]?(tt\d+)\]?\}?/i);
  work = work.replace(/[[{][^\]}]*[\]}]/g, ' ');
  const yearMatch = work.match(/\((\d{4})\)/) ?? work.match(/(?:^|[\s.])((?:19|20)\d{2})(?=[\s.]|$)/);
  const year = yearMatch ? parseInt(yearMatch[1]!, 10) : null;
  let title = yearMatch ? work.slice(0, yearMatch.index) : work;
  title = title.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').replace(/[\s\-–—]+$/, '').trim();
  if (!title) title = name.trim();
  return {
    title,
    year,
    tmdbId: tmdb ? parseInt(tmdb[1]!, 10) : null,
    tvdbId: tvdb ? parseInt(tvdb[1]!, 10) : null,
    imdbId: imdb ? imdb[1]! : null,
  };
}

// ============================================================================
// Local inspection
// ============================================================================

const VIDEO_EXTENSIONS = new Set(['.mkv', '.mp4', '.avi', '.m4v', '.mov', '.wmv', '.ts', '.m2ts', '.webm', '.iso', '.mpg', '.mpeg']);
const MAX_ENTRIES = 25_000;

interface LocalSummary {
  sizeBytes: number;
  fileCount: number;
  videoFiles: string[];
  modifiedAt: string | null;
  permissionIssues: number;
  writable: boolean;
}

async function summariseLocal(localPath: string): Promise<LocalSummary | null> {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(localPath);
  } catch {
    return null;
  }
  if (!stat.isDirectory()) return null;

  let sizeBytes = 0;
  let fileCount = 0;
  let newest = stat.mtimeMs;
  const videoFiles: string[] = [];
  let entries = 0;

  const walk = async (dir: string): Promise<void> => {
    let list: import('node:fs').Dirent[];
    try {
      list = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of list) {
      if (++entries > MAX_ENTRIES) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        try {
          const s = await fs.stat(full);
          sizeBytes += s.size;
          fileCount += 1;
          if (s.mtimeMs > newest) newest = s.mtimeMs;
          if (VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) && videoFiles.length < 5) {
            videoFiles.push(path.relative(localPath, full));
          }
        } catch {
          /* unreadable file; skip */
        }
      }
    }
  };
  await walk(localPath);
  let permissionIssues = 0;
  let writable = true;
  try {
    const report = await inspectPermissions(localPath);
    permissionIssues = report.wrongOwner + report.wrongMode;
    writable = report.writable;
  } catch {
    /* leave at defaults */
  }
  return { sizeBytes, fileCount, videoFiles, modifiedAt: new Date(newest).toISOString(), permissionIssues, writable };
}

// ============================================================================
// Listing
// ============================================================================

const CACHE_TTL_MS = 60_000;
let cache: { at: number; listing: OrphanFolderListing } | null = null;

export function invalidateCache(): void {
  cache = null;
}

async function rootFoldersFor(service: OrphanService): Promise<ArrRootFolder[]> {
  const instance = service === 'sonarr' ? getSonarrService() : getRadarrService();
  if (!instance) throw new ServiceNotConfiguredError(service);
  return instance.getRootFolders();
}

interface UnmappedFolderResource {
  name?: string;
  path?: string;
  relativePath?: string;
}

export async function listOrphanFolders(options: { includeIgnored?: boolean; refresh?: boolean } = {}): Promise<OrphanFolderListing> {
  if (!options.refresh && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return filterIgnored(cache.listing, options.includeIgnored === true);
  }

  const mappings = getFolderMappings();
  const ignored = getIgnored();
  const services: OrphanServiceState[] = [];
  const folders: OrphanFolder[] = [];

  for (const service of ['radarr', 'sonarr'] as const) {
    const label = serviceLabel(service);
    const configured = service === 'sonarr' ? Boolean(getSonarrService()) : Boolean(getRadarrService());
    if (!configured) {
      services.push({ service, serviceLabel: label, configured: false, rootFolders: [], error: null });
      continue;
    }
    try {
      const roots = await rootFoldersFor(service);
      const rootStates: OrphanServiceState['rootFolders'] = [];
      for (const root of roots) {
        const unmapped = (Array.isArray(root.unmappedFolders) ? root.unmappedFolders : []) as UnmappedFolderResource[];
        rootStates.push({ path: root.path, accessible: root.accessible, localPath: toLocalPath(root.path, mappings), unmapped: unmapped.length });
        for (const entry of unmapped) {
          const remotePath = normalisePath(entry.path || path.posix.join(root.path, entry.relativePath || entry.name || ''));
          const name = entry.name || entry.relativePath || path.posix.basename(remotePath);
          if (!name) continue;
          const localPath = toLocalPath(remotePath, mappings);
          const summary = localPath ? await summariseLocal(localPath) : null;
          folders.push({
            id: folderId(service, remotePath),
            service,
            serviceLabel: label,
            rootFolder: root.path,
            name,
            path: remotePath,
            localPath,
            sizeBytes: summary?.sizeBytes ?? null,
            fileCount: summary?.fileCount ?? null,
            videoFiles: summary?.videoFiles ?? [],
            modifiedAt: summary?.modifiedAt ?? null,
            ignored: ignored.has(`${service}:${remotePath}`),
            canDelete: summary !== null,
            permissionIssues: summary?.permissionIssues ?? null,
            writable: summary?.writable ?? null,
            guess: parseFolderName(name),
          });
        }
      }
      services.push({ service, serviceLabel: label, configured: true, rootFolders: rootStates, error: null });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`Could not list unmapped folders from ${label}: ${message}`);
      services.push({ service, serviceLabel: label, configured: true, rootFolders: [], error: message });
    }
  }

  folders.sort((a, b) => (b.sizeBytes ?? -1) - (a.sizeBytes ?? -1) || a.name.localeCompare(b.name));
  const listing: OrphanFolderListing = {
    folders,
    services,
    mappings,
    totalSizeBytes: folders.reduce((sum, f) => sum + (f.sizeBytes ?? 0), 0),
    unsized: folders.filter((f) => f.sizeBytes === null).length,
    scannedAt: new Date().toISOString(),
  };
  cache = { at: Date.now(), listing };
  return filterIgnored(listing, options.includeIgnored === true);
}

function filterIgnored(listing: OrphanFolderListing, includeIgnored: boolean): OrphanFolderListing {
  if (includeIgnored) return listing;
  const folders = listing.folders.filter((f) => !f.ignored);
  return {
    ...listing,
    folders,
    totalSizeBytes: folders.reduce((sum, f) => sum + (f.sizeBytes ?? 0), 0),
    unsized: folders.filter((f) => f.sizeBytes === null).length,
  };
}

export async function getOrphanFolder(id: string): Promise<OrphanFolder | null> {
  const parsed = parseFolderId(id);
  if (!parsed) return null;
  const listing = await listOrphanFolders({ includeIgnored: true });
  return listing.folders.find((f) => f.id === id) ?? null;
}

// ============================================================================
// Lookup and import
// ============================================================================

function posterOf(images: Array<{ coverType?: string; remoteUrl?: string; url?: string }> | undefined): string | null {
  const poster = images?.find((i) => i.coverType === 'poster');
  return poster?.remoteUrl || poster?.url || null;
}

/** Candidates in the owning app's catalogue for a folder, best guess first. */
export async function lookupCandidates(id: string, term?: string): Promise<{ folder: OrphanFolder; term: string; candidates: FolderCandidate[] }> {
  const folder = await getOrphanFolder(id);
  if (!folder) throw new Error('Folder not found (it may have been imported or removed; refresh the list)');
  const { guess } = folder;
  let query = term?.trim();
  if (!query) {
    if (folder.service === 'radarr' && guess.tmdbId) query = `tmdb:${guess.tmdbId}`;
    else if (folder.service === 'sonarr' && guess.tvdbId) query = `tvdb:${guess.tvdbId}`;
    else if (guess.imdbId) query = `imdb:${guess.imdbId}`;
    else query = guess.year ? `${guess.title} ${guess.year}` : guess.title;
  }

  if (folder.service === 'radarr') {
    const radarr = getRadarrService();
    if (!radarr) throw new ServiceNotConfiguredError('radarr');
    const results = await radarr.lookupMovies(query);
    return {
      folder,
      term: query,
      candidates: results.slice(0, 10).map((m) => ({
        id: m.tmdbId,
        title: m.title,
        year: m.year || null,
        overview: m.overview ?? null,
        posterUrl: posterOf(m.images),
        inLibrary: Boolean(m.id && m.id > 0),
        existingId: m.id && m.id > 0 ? m.id : null,
      })),
    };
  }

  const sonarr = getSonarrService();
  if (!sonarr) throw new ServiceNotConfiguredError('sonarr');
  const results = await sonarr.lookupSeries(query);
  return {
    folder,
    term: query,
    candidates: results.slice(0, 10).map((s) => ({
      id: s.tvdbId,
      title: s.title,
      year: s.year || null,
      overview: s.overview ?? null,
      posterUrl: posterOf(s.images),
      inLibrary: Boolean(s.id && s.id > 0),
      existingId: s.id && s.id > 0 ? s.id : null,
    })),
  };
}

export async function getQualityProfiles(service: OrphanService): Promise<QualityProfile[]> {
  if (service === 'radarr') {
    const radarr = getRadarrService();
    if (!radarr) throw new ServiceNotConfiguredError('radarr');
    return radarr.getQualityProfileList();
  }
  const sonarr = getSonarrService();
  if (!sonarr) throw new ServiceNotConfiguredError('sonarr');
  return sonarr.getQualityProfileList();
}

export interface ImportFolderOptions {
  /** tmdbId (Radarr) or tvdbId (Sonarr) chosen from lookupCandidates. */
  candidateId: number;
  qualityProfileId?: number;
  monitored?: boolean;
  actorName: string;
}

export interface ImportFolderResult {
  folder: OrphanFolder;
  service: OrphanService;
  /** The app's id for the new movie/series. */
  addedId: number;
  title: string;
  year: number | null;
}

/**
 * Add the title to the owning app with the folder as its path. The app scans
 * the folder straight away and takes over the files; nothing is moved.
 */
export async function importFolder(id: string, options: ImportFolderOptions): Promise<ImportFolderResult> {
  const folder = await getOrphanFolder(id);
  if (!folder) throw new Error('Folder not found (it may have been imported or removed; refresh the list)');

  const profiles = await getQualityProfiles(folder.service);
  const profileId = options.qualityProfileId ?? profiles[0]?.id;
  if (!profileId) throw new Error(`${folder.serviceLabel} has no quality profile to assign`);
  if (!profiles.some((p) => p.id === profileId)) throw new Error(`Quality profile ${profileId} does not exist in ${folder.serviceLabel}`);
  const monitored = options.monitored ?? true;

  // The app will want to rename and move files in this folder. If Prunerr can
  // see that it is owned by someone else, put it right first (same owner the
  // apps run as) so the import does not stall on a permission error there.
  let permissionsFixed: FixResult | null = null;
  if (folder.localPath && folder.permissionIssues && folder.permissionIssues > 0 && getPermissionSettings().autoFix && getPermissionCapabilities().canChown) {
    try {
      permissionsFixed = await repairMappedFolder(folder, options.actorName, 'before import');
    } catch (error) {
      logger.warn(`Could not repair permissions on ${folder.localPath} before import: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let result: ImportFolderResult;
  if (folder.service === 'radarr') {
    const radarr = getRadarrService();
    if (!radarr) throw new ServiceNotConfiguredError('radarr');
    const [match] = await radarr.lookupMovies(`tmdb:${options.candidateId}`);
    if (!match || match.tmdbId !== options.candidateId) throw new Error(`Radarr could not find TMDB id ${options.candidateId}`);
    if (match.id && match.id > 0) throw new Error(`"${match.title}" is already in Radarr (id ${match.id}); it owns a different folder. Remove or merge it there first.`);
    const added = await radarr.addMovie({
      ...match,
      qualityProfileId: profileId,
      rootFolderPath: folder.rootFolder,
      path: folder.path,
      monitored,
      minimumAvailability: match.minimumAvailability || 'released',
      addOptions: { searchForMovie: false, monitor: monitored ? 'movieOnly' : 'none' },
    } as unknown as RadarrMovie);
    result = { folder, service: 'radarr', addedId: added.id, title: added.title, year: added.year || null };
  } else {
    const sonarr = getSonarrService();
    if (!sonarr) throw new ServiceNotConfiguredError('sonarr');
    const [match] = await sonarr.lookupSeries(`tvdb:${options.candidateId}`);
    if (!match || match.tvdbId !== options.candidateId) throw new Error(`Sonarr could not find TVDB id ${options.candidateId}`);
    if (match.id && match.id > 0) throw new Error(`"${match.title}" is already in Sonarr (id ${match.id}); it owns a different folder. Remove or merge it there first.`);
    const languageProfiles = await sonarr.getLanguageProfiles();
    const added = await sonarr.addSeries({
      ...match,
      qualityProfileId: profileId,
      ...(languageProfiles[0] ? { languageProfileId: languageProfiles[0].id } : {}),
      rootFolderPath: folder.rootFolder,
      path: folder.path,
      monitored,
      seasonFolder: true,
      addOptions: { searchForMissingEpisodes: false, monitor: monitored ? 'all' : 'none' },
    } as unknown as SonarrSeries);
    result = { folder, service: 'sonarr', addedId: added.id, title: added.title, year: added.year || null };
  }

  logger.info(`Imported orphan folder ${folder.path} into ${folder.serviceLabel} as "${result.title}" (id ${result.addedId})`);
  try {
    logActivity({
      eventType: 'manual_action',
      action: 'folder_imported',
      actorType: 'user',
      actorName: options.actorName,
      targetType: 'folder',
      targetId: null,
      targetTitle: folder.name,
      metadata: JSON.stringify({ service: folder.serviceLabel, path: folder.path, title: result.title, year: result.year, addedId: result.addedId, sizeBytes: folder.sizeBytes, permissionsFixed: permissionsFixed?.changed ?? 0 }),
    });
  } catch (activityError) {
    logger.warn('Failed to log folder import activity:', activityError);
  }
  invalidateCache();
  return result;
}

// ============================================================================
// Delete and ignore
// ============================================================================

export interface DeleteFolderResult {
  folder: OrphanFolder;
  localPath: string;
  sizeBytes: number;
  fileCount: number;
}

/**
 * Remove the folder from disk. Only a mapped folder can go, and only when its
 * resolved location sits strictly inside the mapping's local path: a mapping
 * can never make Prunerr delete a root folder, a parent, or anything a
 * symlink points at outside the media tree.
 */
/**
 * The real path of a mapped folder, proven to sit strictly inside its
 * mapping's local path. Every operation that touches the disk goes through
 * this: a mapping can never reach a root folder, a parent, or a symlink
 * target outside the media tree.
 */
async function resolveInsideMapping(folder: OrphanFolder): Promise<string> {
  if (!folder.localPath) {
    throw new Error(`No folder mapping covers ${folder.path}. Add one in Settings (Connections, Media folders) so Prunerr can see the files.`);
  }
  const mappings = getFolderMappings();
  const mapping = mappings.find((m) => folder.localPath === m.localPath || folder.localPath!.startsWith(`${m.localPath}/`));
  if (!mapping) throw new Error('The folder is outside every mapped path');

  let real: string;
  let realBase: string;
  try {
    real = await fs.realpath(folder.localPath);
    realBase = await fs.realpath(mapping.localPath);
  } catch {
    throw new Error(`${folder.localPath} does not exist on Prunerr's side; check the mapping`);
  }
  if (real === realBase || !real.startsWith(`${realBase}${path.sep}`)) {
    throw new Error('Refusing to touch it: the folder resolves outside its mapped media path');
  }
  return real;
}

/** Fix owner and modes under a mapped folder, with an activity entry. */
async function repairMappedFolder(folder: OrphanFolder, actorName: string, why: string): Promise<FixResult> {
  const real = await resolveInsideMapping(folder);
  const settings = getPermissionSettings();
  const result = await fixPermissions(real, settings);
  try {
    logActivity({
      eventType: 'manual_action',
      action: 'folder_permissions_fixed',
      actorType: 'user',
      actorName,
      targetType: 'folder',
      targetId: null,
      targetTitle: folder.name,
      metadata: JSON.stringify({
        service: folder.serviceLabel,
        path: folder.path,
        localPath: real,
        owner: `${settings.uid}:${settings.gid}`,
        dirMode: settings.dirMode,
        fileMode: settings.fileMode,
        changed: result.changed,
        failed: result.failed.length,
        why,
      }),
    });
  } catch (activityError) {
    logger.warn('Failed to log permission repair activity:', activityError);
  }
  invalidateCache();
  return result;
}

export async function inspectFolderPermissions(id: string): Promise<{ folder: OrphanFolder; report: PermissionReport }> {
  const folder = await getOrphanFolder(id);
  if (!folder) throw new Error('Folder not found (it may have been imported or removed; refresh the list)');
  const real = await resolveInsideMapping(folder);
  return { folder, report: await inspectPermissions(real) };
}

export async function fixFolderPermissions(id: string, options: { actorName: string }): Promise<{ folder: OrphanFolder; result: FixResult }> {
  const folder = await getOrphanFolder(id);
  if (!folder) throw new Error('Folder not found (it may have been imported or removed; refresh the list)');
  const result = await repairMappedFolder(folder, options.actorName, 'requested');
  return { folder, result };
}

export async function deleteFolder(id: string, options: { actorName: string }): Promise<DeleteFolderResult> {
  const folder = await getOrphanFolder(id);
  if (!folder) throw new Error('Folder not found (it may have been imported or removed; refresh the list)');
  const real = await resolveInsideMapping(folder);

  // Make sure it is still unmanaged right now, not from a cached listing.
  const fresh = await listOrphanFolders({ includeIgnored: true, refresh: true });
  if (!fresh.folders.some((f) => f.id === id)) {
    throw new Error(`${folder.serviceLabel} now manages ${folder.path}; not deleting a managed folder`);
  }

  const summary = (await summariseLocal(real)) ?? { sizeBytes: 0, fileCount: 0, videoFiles: [], modifiedAt: null, permissionIssues: 0, writable: true };
  try {
    await fs.rm(real, { recursive: true, force: false });
  } catch (error) {
    if (!isPermissionError(error)) throw error;
    // Files owned by someone else. Put the folder right and try once more,
    // when allowed; otherwise explain exactly what is in the way.
    const settings = getPermissionSettings();
    if (settings.autoFix && getPermissionCapabilities().canChown) {
      logger.info(`Delete of ${real} hit a permission error; repairing ownership and retrying`);
      await repairMappedFolder(folder, options.actorName, 'before delete');
      try {
        await fs.rm(real, { recursive: true, force: false });
      } catch (retryError) {
        throw new Error(await explainPermissionError(retryError, real));
      }
    } else {
      throw new Error(await explainPermissionError(error, real));
    }
  }
  logger.info(`Deleted orphan folder ${folder.path} (${real}): ${summary.fileCount} file(s), ${summary.sizeBytes} bytes`);

  try {
    logActivity({
      eventType: 'manual_action',
      action: 'folder_deleted',
      actorType: 'user',
      actorName: options.actorName,
      targetType: 'folder',
      targetId: null,
      targetTitle: folder.name,
      metadata: JSON.stringify({ service: folder.serviceLabel, path: folder.path, localPath: real, sizeBytes: summary.sizeBytes, fileCount: summary.fileCount }),
    });
  } catch (activityError) {
    logger.warn('Failed to log folder deletion activity:', activityError);
  }
  const ignored = getIgnored();
  if (ignored.delete(`${folder.service}:${folder.path}`)) setIgnored(ignored);
  invalidateCache();
  return { folder, localPath: real, sizeBytes: summary.sizeBytes, fileCount: summary.fileCount };
}

export async function setFolderIgnored(id: string, ignored: boolean, actorName: string): Promise<OrphanFolder> {
  const folder = await getOrphanFolder(id);
  if (!folder) throw new Error('Folder not found');
  const set = getIgnored();
  const key = `${folder.service}:${folder.path}`;
  if (ignored) set.add(key);
  else set.delete(key);
  setIgnored(set);
  try {
    logActivity({
      eventType: 'manual_action',
      action: ignored ? 'folder_ignored' : 'folder_unignored',
      actorType: 'user',
      actorName,
      targetType: 'folder',
      targetId: null,
      targetTitle: folder.name,
      metadata: JSON.stringify({ service: folder.serviceLabel, path: folder.path }),
    });
  } catch (activityError) {
    logger.warn('Failed to log folder ignore activity:', activityError);
  }
  invalidateCache();
  return { ...folder, ignored };
}
