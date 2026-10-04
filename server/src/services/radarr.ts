import axios, { AxiosInstance, AxiosError } from 'axios';
import logger from '../utils/logger';
import type { RadarrMovie, RadarrMovieFile, RadarrCollectionResource, ArrRelease, ArrIndexer, ArrIndexerStatus } from './types';
import collectionsRepo from '../db/repositories/collections';
import { getDatabase } from '../db/index';
import {
  ARR_REQUEST_TIMEOUT_MS,
  ARR_SEARCH_TIMEOUT_MS,
  summariseIndexerHealth,
  type IndexerHealth,
  isNotFound,
  isTimeout,
  resolveArrTiming,
  waitUntilGone,
  type ArrTimingOptions,
  type FileDeletionProgress,
} from './arrHttp';
import {
  fetchCommands,
  fetchHealth,
  fetchLogs,
  fetchMediaManagementConfig,
  fetchRootFolders,
  fetchSystemStatus,
  recentDeleteFailure,
  type ArrCommand,
  type ArrHealthItem,
  type ArrLogRecord,
  type ArrMediaManagementConfig,
  type ArrRootFolder,
  type ArrSystemStatus,
  type FetchLogsOptions,
} from './arrDiagnostics';

export type { FileDeletionProgress } from './arrHttp';

/** Did the movie's file go, or was there nothing (left) to delete? */
export interface MovieFileDeletionResult {
  outcome: 'deleted' | 'no_file' | 'not_found';
  fileName?: string;
  fileSize?: number;
}

export class RadarrService {
  private client: AxiosInstance;
  private timing: Required<ArrTimingOptions>;

  constructor(url: string, apiKey: string, timing?: ArrTimingOptions) {
    const baseUrl = url.replace(/\/$/, ''); // Remove trailing slash
    this.timing = resolveArrTiming(timing);

    this.client = axios.create({
      baseURL: `${baseUrl}/api/v3`,
      headers: {
        'X-Api-Key': apiKey,
        'Content-Type': 'application/json',
      },
      timeout: ARR_REQUEST_TIMEOUT_MS,
    });

    // Add response interceptor for rate limiting
    this.client.interceptors.response.use(
      (response) => response,
      async (error: AxiosError) => {
        if (error.response?.status === 429) {
          const retryAfter = parseInt(error.response.headers['retry-after'] as string) || 5;
          logger.warn(`Radarr rate limited, retrying after ${retryAfter}s`);
          await this.delay(retryAfter * 1000);
          return this.client.request(error.config!);
        }
        throw error;
      }
    );
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Test connection to Radarr
   */
  async testConnection(): Promise<boolean> {
    try {
      const response = await this.client.get('/system/status');
      const isValid = !!response.data.version;

      if (isValid) {
        logger.info('Radarr connection test successful', { version: response.data.version });
      }

      return isValid;
    } catch (error) {
      const axiosError = error as AxiosError;
      logger.error('Radarr connection test failed', {
        status: axiosError.response?.status,
        message: axiosError.message,
      });
      return false;
    }
  }

  /**
   * Get all movies
   */
  async getMovies(): Promise<RadarrMovie[]> {
    try {
      const response = await this.client.get<RadarrMovie[]>('/movie');
      logger.info(`Retrieved ${response.data.length} movies from Radarr`);
      return response.data;
    } catch (error) {
      const axiosError = error as AxiosError;
      logger.error('Failed to get movies from Radarr', {
        status: axiosError.response?.status,
        message: axiosError.message,
      });
      throw error;
    }
  }

  /**
   * Interactive search for a movie: what every enabled indexer can offer right
   * now. Radarr queries the indexers synchronously, so this can take a minute;
   * the request gets its own, longer timeout.
   */
  async getReleases(movieId: number): Promise<ArrRelease[]> {
    const response = await this.client.get<ArrRelease[]>('/release', {
      params: { movieId },
      timeout: ARR_SEARCH_TIMEOUT_MS,
    });
    return Array.isArray(response.data) ? response.data : [];
  }

  /** Enabled indexers, and which of them Radarr is currently backing off from. */
  async getIndexerHealth(): Promise<IndexerHealth> {
    const [indexers, statuses] = await Promise.all([
      this.client.get<ArrIndexer[]>('/indexer'),
      this.client.get<ArrIndexerStatus[]>('/indexerstatus'),
    ]);
    return summariseIndexerHealth(indexers.data, statuses.data);
  }

  /**
   * Get a specific movie by ID
   */
  async getMovieById(id: number): Promise<RadarrMovie> {
    try {
      const response = await this.client.get<RadarrMovie>(`/movie/${id}`);
      return response.data;
    } catch (error) {
      const axiosError = error as AxiosError;
      logger.error(`Failed to get movie ${id} from Radarr`, {
        status: axiosError.response?.status,
        message: axiosError.message,
      });
      throw error;
    }
  }

  /**
   * Look a movie up, answering null when Radarr no longer has it. The plain
   * getMovieById treats a 404 as an error; for deletions it is an answer.
   */
  async findMovieById(id: number): Promise<RadarrMovie | null> {
    try {
      const response = await this.client.get<RadarrMovie>(`/movie/${id}`);
      return response.data;
    } catch (error) {
      if (isNotFound(error)) {
        logger.info(`Movie ${id} is not in Radarr (already removed)`);
        return null;
      }
      throw error;
    }
  }

  /** Whether Radarr still has a movie file with this id. */
  private async movieFileExists(fileId: number): Promise<boolean> {
    try {
      await this.client.get(`/moviefile/${fileId}`);
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  /**
   * Delete a movie. Resolves to 'not_found' when Radarr had already let it go.
   *
   * With deleteFiles this is the same call Radarr's own UI makes and it can
   * run long for a big file, so it gets the delete timeout and, if even that
   * is exceeded, Radarr is asked whether the movie is gone before the call is
   * declared a failure.
   */
  async deleteMovie(id: number, deleteFiles: boolean = false): Promise<'deleted' | 'not_found'> {
    const started = new Date();
    try {
      await this.client.delete(`/movie/${id}`, {
        params: {
          deleteFiles,
          addImportExclusion: false,
        },
        timeout: this.timing.deleteTimeoutMs,
      });
      logger.info(`Deleted movie ${id} from Radarr`, { deleteFiles });
      return 'deleted';
    } catch (error) {
      if (isNotFound(error)) {
        logger.info(`Movie ${id} not found in Radarr (already deleted)`);
        return 'not_found';
      }
      if (isTimeout(error)) {
        logger.warn(`Radarr did not answer the delete of movie ${id} within ${this.timing.deleteTimeoutMs}ms; checking whether it finished`);
        const outcome = await waitUntilGone(
          async () => (await this.findMovieById(id)) === null,
          this.timing,
          () => recentDeleteFailure(this.client, started)
        );
        if (outcome.status === 'gone') {
          logger.info(`Radarr finished removing movie ${id} after the request timed out`);
          return 'deleted';
        }
        if (outcome.status === 'failed') {
          throw new Error(`Radarr could not remove movie ${id}. Its log says: ${outcome.reason}`);
        }
        throw new Error(
          `Radarr did not finish removing movie ${id} within ${Math.round((this.timing.deleteTimeoutMs + this.timing.verifyWindowMs) / 1000)}s; it may still be working on it`
        );
      }
      const axiosError = error as AxiosError;
      logger.error(`Failed to delete movie ${id} from Radarr`, {
        status: axiosError.response?.status,
        message: axiosError.message,
      });
      throw error;
    }
  }

  /**
   * Remove a movie completely (alias for deleteMovie with deleteFiles=true)
   */
  async removeMovie(id: number, deleteFiles: boolean = true): Promise<'deleted' | 'not_found'> {
    return this.deleteMovie(id, deleteFiles);
  }

  /**
   * Unmonitor a movie. Resolves to 'not_found' when Radarr no longer has it,
   * so callers can stop there instead of failing on the follow-up calls.
   */
  async unmonitorMovie(id: number): Promise<'unmonitored' | 'not_found'> {
    const movie = await this.findMovieById(id);
    if (!movie) return 'not_found';
    if (!movie.monitored) {
      // A retry after an earlier attempt got this far: nothing to do.
      logger.info(`Movie ${id} is already unmonitored in Radarr`);
      return 'unmonitored';
    }

    // The bulk editor endpoint is what Radarr's own UI uses to toggle
    // monitoring. It changes just that flag, instead of a full PUT of the
    // movie object, which Radarr re-validates (path, root folder, files) and
    // which has been seen to take it the better part of a minute.
    const started = Date.now();
    try {
      await this.client.put(
        '/movie/editor',
        { movieIds: [id], monitored: false },
        { timeout: this.timing.deleteTimeoutMs }
      );
      logger.info(`Unmonitored movie ${id} in Radarr in ${Date.now() - started}ms`);
      return 'unmonitored';
    } catch (error) {
      if (isNotFound(error)) {
        logger.info(`Movie ${id} disappeared from Radarr while unmonitoring it`);
        return 'not_found';
      }
      if (isTimeout(error)) {
        logger.warn(`Radarr did not answer the unmonitor of movie ${id} within ${this.timing.deleteTimeoutMs}ms; checking whether it applied`);
        const done = await waitUntilGone(async () => {
          const current = await this.findMovieById(id);
          return current === null || !current.monitored;
        }, this.timing);
        if (done.status === 'gone') return 'unmonitored';
        throw new Error(`Radarr did not finish unmonitoring movie ${id} within ${Math.round((this.timing.deleteTimeoutMs + this.timing.verifyWindowMs) / 1000)}s`);
      }
      const axiosError = error as AxiosError;
      logger.error(`Failed to unmonitor movie ${id} in Radarr`, {
        status: axiosError.response?.status,
        message: axiosError.message,
      });
      throw error;
    }
  }

  /**
   * Get movie files for a movie
   */
  async getMovieFiles(movieId: number): Promise<RadarrMovieFile[]> {
    try {
      // Radarr stores movie file info directly on the movie object
      const movie = await this.getMovieById(movieId);

      if (movie.movieFile) {
        return [movie.movieFile];
      }

      return [];
    } catch (error) {
      const axiosError = error as AxiosError;
      logger.error(`Failed to get movie files for movie ${movieId}`, {
        status: axiosError.response?.status,
        message: axiosError.message,
      });
      throw error;
    }
  }

  /**
   * Delete a movie file by file ID.
   *
   * Radarr deletes the file synchronously inside this request, and a large
   * file on a network share can take it longer than any sensible HTTP timeout.
   * When the request times out, the file is polled until it is gone (or the
   * verification window runs out) rather than reporting a failure for a delete
   * that is still in progress. `onVerifying` fires when that wait begins.
   */
  async deleteMovieFile(id: number, onVerifying?: () => void, fileName?: string): Promise<void> {
    const started = new Date();
    try {
      await this.client.delete(`/moviefile/${id}`, { timeout: this.timing.deleteTimeoutMs });
      logger.info(`Deleted movie file ${id} from Radarr`);
    } catch (error) {
      if (isNotFound(error)) {
        logger.info(`Movie file ${id} not found in Radarr (already deleted)`);
        return;
      }
      if (isTimeout(error)) {
        logger.warn(`Radarr did not answer the delete of movie file ${id} within ${this.timing.deleteTimeoutMs}ms; waiting for it to finish`);
        onVerifying?.();
        const outcome = await waitUntilGone(
          async () => !(await this.movieFileExists(id)),
          this.timing,
          () => recentDeleteFailure(this.client, started, fileName)
        );
        if (outcome.status === 'gone') {
          logger.info(`Radarr finished deleting movie file ${id} after the request timed out`);
          return;
        }
        if (outcome.status === 'failed') {
          throw new Error(`Radarr could not delete movie file ${id}. Its log says: ${outcome.reason}`);
        }
        throw new Error(
          `Radarr did not finish deleting movie file ${id} within ${Math.round((this.timing.deleteTimeoutMs + this.timing.verifyWindowMs) / 1000)}s; it may still be working on it. Raise ARR_DELETE_TIMEOUT_MS if your storage is slow.`
        );
      }
      const axiosError = error as AxiosError;
      logger.error(`Failed to delete movie file ${id} from Radarr`, {
        status: axiosError.response?.status,
        message: axiosError.message,
      });
      throw error;
    }
  }

  /**
   * Delete the movie's file while keeping the movie in Radarr.
   *
   * Resolves rather than throws for the two "nothing to do" cases: the movie
   * has no file, or Radarr no longer has the movie at all.
   */
  async deleteMovieFilesByMovieId(
    movieId: number,
    onProgress?: (progress: FileDeletionProgress) => void
  ): Promise<MovieFileDeletionResult> {
    const movie = await this.findMovieById(movieId);
    if (!movie) return { outcome: 'not_found' };

    if (!movie.movieFile) {
      logger.info(`No movie file found for movie ${movieId}`);
      return { outcome: 'no_file' };
    }

    const file = movie.movieFile;
    const fileName = file.relativePath || file.path || `Movie file ${file.id}`;

    onProgress?.({ current: 1, total: 1, fileName, status: 'deleting' });

    try {
      await this.deleteMovieFile(
        file.id,
        () => onProgress?.({ current: 1, total: 1, fileName, status: 'verifying' }),
        fileName
      );
    } catch (error) {
      onProgress?.({ current: 1, total: 1, fileName, status: 'failed' });
      throw error;
    }

    logger.info(`Deleted movie file for movie ${movieId} (file ID: ${file.id})`);
    onProgress?.({ current: 1, total: 1, fileName, status: 'deleted' });

    return { outcome: 'deleted', fileName, fileSize: file.size };
  }

  /**
   * Search for a movie by TMDB ID
   */
  async getMovieByTmdbId(tmdbId: number): Promise<RadarrMovie | null> {
    try {
      const response = await this.client.get<RadarrMovie[]>('/movie', {
        params: { tmdbId },
      });

      if (response.data.length > 0) {
        return response.data[0] ?? null;
      }

      return null;
    } catch (error) {
      logger.error(`Failed to find movie by TMDB ID ${tmdbId}`, {
        message: (error as Error).message,
      });
      return null;
    }
  }

  /**
   * Search for a movie by IMDB ID
   */
  async getMovieByImdbId(imdbId: string): Promise<RadarrMovie | null> {
    try {
      const allMovies = await this.getMovies();
      return allMovies.find((m) => m.imdbId === imdbId) || null;
    } catch (error) {
      logger.error(`Failed to find movie by IMDB ID ${imdbId}`, {
        message: (error as Error).message,
      });
      return null;
    }
  }

  /**
   * Refresh movie metadata
   */
  async refreshMovie(movieId: number): Promise<void> {
    try {
      await this.client.post('/command', {
        name: 'RefreshMovie',
        movieIds: [movieId],
      });
      logger.info(`Triggered refresh for movie ${movieId} in Radarr`);
    } catch (error) {
      const axiosError = error as AxiosError;
      logger.error(`Failed to refresh movie ${movieId} in Radarr`, {
        status: axiosError.response?.status,
        message: axiosError.message,
      });
      throw error;
    }
  }

  /**
   * Get disk space information
   */
  async getDiskSpace(): Promise<Array<{ path: string; freeSpace: number; totalSpace: number }>> {
    try {
      const response = await this.client.get('/diskspace');
      return response.data;
    } catch (error) {
      const axiosError = error as AxiosError;
      logger.error('Failed to get disk space from Radarr', {
        status: axiosError.response?.status,
        message: axiosError.message,
      });
      throw error;
    }
  }

  /**
   * Get all collections from Radarr
   */
  async getCollections(): Promise<RadarrCollectionResource[]> {
    try {
      const response = await this.client.get<RadarrCollectionResource[]>('/collection');
      logger.info(`Retrieved ${response.data.length} collections from Radarr`);
      return response.data;
    } catch (error) {
      const axiosError = error as AxiosError;
      logger.error('Failed to get collections from Radarr', {
        status: axiosError.response?.status,
        message: axiosError.message,
      });
      throw error;
    }
  }

  /**
   * Sync Radarr collections into the local database.
   * Upserts collection rows, then replaces membership by matching
   * Radarr movies to local media_items via tmdb_id (then radarr_id fallback).
   */
  async syncCollections(): Promise<{ collectionsSynced: number; itemsMatched: number }> {
    const collections = await this.getCollections();

    const db = getDatabase();
    const findByTmdbIdStmt = db.prepare<[number], { id: number }>(
      "SELECT id FROM media_items WHERE tmdb_id = ? AND type = 'movie' LIMIT 1"
    );

    let itemsMatched = 0;

    for (const col of collections) {
      const posterImage = col.images?.find((img) => img.coverType === 'poster');
      const posterUrl = posterImage?.remoteUrl ?? posterImage?.url ?? null;

      // Only count existing movies toward item_count (movies actually in Radarr)
      const existingMovies = (col.movies ?? []).filter((m) => m.isExisting);

      const stored = collectionsRepo.upsert({
        tmdb_id: col.tmdbId,
        title: col.title,
        overview: col.overview ?? null,
        poster_url: posterUrl,
        item_count: existingMovies.length,
      });

      // Resolve collection movies to local media_item ids by tmdb_id
      const mediaItemIds: number[] = [];
      for (const m of existingMovies) {
        const row = findByTmdbIdStmt.get(m.tmdbId);
        if (row) mediaItemIds.push(row.id);
      }

      collectionsRepo.setMembership(stored.id, mediaItemIds);
      itemsMatched += mediaItemIds.length;
    }

    logger.info('Collections sync completed', {
      collectionsSynced: collections.length,
      itemsMatched,
    });

    return { collectionsSynced: collections.length, itemsMatched };
  }

  /**
   * Get all tags and return a map of ID to label
   */
  async getTags(): Promise<Map<number, string>> {
    try {
      const response = await this.client.get<Array<{ id: number; label: string }>>('/tag');
      const tagMap = new Map<number, string>();
      for (const tag of response.data) {
        tagMap.set(tag.id, tag.label);
      }
      logger.info(`Retrieved ${tagMap.size} tags from Radarr`);
      return tagMap;
    } catch (error) {
      const axiosError = error as AxiosError;
      logger.error('Failed to get tags from Radarr', {
        status: axiosError.response?.status,
        message: axiosError.message,
      });
      throw error;
    }
  }

  /**
   * Get movie by file path
   */
  async getMovieByPath(filePath: string): Promise<RadarrMovie | null> {
    try {
      const allMovies = await this.getMovies();
      return allMovies.find((m) => filePath.startsWith(m.path)) || null;
    } catch (error) {
      logger.error(`Failed to find movie by path ${filePath}`, {
        message: (error as Error).message,
      });
      return null;
    }
  }

  // ==========================================================================
  // Catalogue lookup and adding (for importing unmanaged folders)
  // ==========================================================================

  /** Search Radarr's catalogue; `tmdb:123` and `imdb:tt123` look up by id. */
  async lookupMovies(term: string): Promise<RadarrMovie[]> {
    const response = await this.client.get<RadarrMovie[]>('/movie/lookup', { params: { term } });
    return Array.isArray(response.data) ? response.data : [];
  }

  /** Quality profiles as a list, for pickers. */
  async getQualityProfileList(): Promise<Array<{ id: number; name: string }>> {
    const response = await this.client.get<Array<{ id: number; name: string }>>('/qualityprofile');
    return (Array.isArray(response.data) ? response.data : []).map((p) => ({ id: p.id, name: p.name }));
  }

  /**
   * Add a movie. Pass a lookup result with qualityProfileId, rootFolderPath
   * and path filled in; with `path` pointing at an existing folder Radarr
   * scans it on add and imports what it finds.
   */
  async addMovie(movie: RadarrMovie): Promise<RadarrMovie> {
    try {
      const response = await this.client.post<RadarrMovie>('/movie', movie);
      logger.info(`Added movie "${movie.title}" to Radarr at ${movie.path}`);
      return response.data;
    } catch (error) {
      const axiosError = error as AxiosError<unknown>;
      const detail = Array.isArray(axiosError.response?.data)
        ? (axiosError.response!.data as Array<{ errorMessage?: string }>).map((e) => e.errorMessage).filter(Boolean).join('; ')
        : '';
      throw new Error(`Radarr refused to add "${movie.title}"${axiosError.response?.status ? ` (HTTP ${axiosError.response.status})` : ''}${detail ? `: ${detail}` : `: ${axiosError.message}`}`);
    }
  }

  // ==========================================================================
  // Diagnostics (read-only)
  // ==========================================================================

  /** The underlying HTTP client, for the shared diagnostics helpers. */
  get httpClient(): AxiosInstance {
    return this.client;
  }

  getLogs(options?: FetchLogsOptions): Promise<ArrLogRecord[]> {
    return fetchLogs(this.client, options);
  }

  getHealth(): Promise<ArrHealthItem[]> {
    return fetchHealth(this.client);
  }

  getSystemStatus(): Promise<ArrSystemStatus> {
    return fetchSystemStatus(this.client);
  }

  getCommands(): Promise<ArrCommand[]> {
    return fetchCommands(this.client);
  }

  getRootFolders(): Promise<ArrRootFolder[]> {
    return fetchRootFolders(this.client);
  }

  getMediaManagementConfig(): Promise<ArrMediaManagementConfig> {
    return fetchMediaManagementConfig(this.client);
  }
}

export default RadarrService;
