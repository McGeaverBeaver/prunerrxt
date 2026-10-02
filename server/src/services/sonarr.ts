import axios, { AxiosInstance, AxiosError } from 'axios';
import logger from '../utils/logger';
import type {
  SonarrSeries,
  SonarrEpisode,
  SonarrEpisodeFile,
  SonarrQualityProfile,
  SonarrQueueRecord,
  SonarrHistoryRecord,
} from './types';
import {
  ARR_REQUEST_TIMEOUT_MS,
  isNotFound,
  isTimeout,
  resolveArrTiming,
  waitUntilGone,
  type ArrTimingOptions,
} from './arrHttp';
import type { FileDeletionProgress } from './arrHttp';

/** How a whole-series file deletion went. */
export interface SeriesFileDeletionResult {
  outcome: 'deleted' | 'no_files' | 'not_found';
  deleted: number;
  failed: number;
  /** Bytes Sonarr reported for the files that were deleted. */
  freedBytes: number;
  /** Messages for the files that could not be deleted, for the error report. */
  errors: string[];
}

export class SonarrService {
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
          logger.warn(`Sonarr rate limited, retrying after ${retryAfter}s`);
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
   * Test connection to Sonarr
   */
  async testConnection(): Promise<boolean> {
    try {
      const response = await this.client.get('/system/status');
      const isValid = !!response.data.version;

      if (isValid) {
        logger.info('Sonarr connection test successful', { version: response.data.version });
      }

      return isValid;
    } catch (error) {
      const axiosError = error as AxiosError;
      logger.error('Sonarr connection test failed', {
        status: axiosError.response?.status,
        message: axiosError.message,
      });
      return false;
    }
  }

  /**
   * Get all series
   */
  async getSeries(): Promise<SonarrSeries[]> {
    try {
      const response = await this.client.get<SonarrSeries[]>('/series');
      logger.info(`Retrieved ${response.data.length} series from Sonarr`);
      return response.data;
    } catch (error) {
      const axiosError = error as AxiosError;
      logger.error('Failed to get series from Sonarr', {
        status: axiosError.response?.status,
        message: axiosError.message,
      });
      throw error;
    }
  }

  /**
   * Look a series up, answering null when Sonarr no longer has it. The plain
   * getSeriesById treats a 404 as an error; for deletions it is an answer.
   */
  async findSeriesById(id: number): Promise<SonarrSeries | null> {
    try {
      const response = await this.client.get<SonarrSeries>(`/series/${id}`);
      return response.data;
    } catch (error) {
      if (isNotFound(error)) {
        logger.info(`Series ${id} is not in Sonarr (already removed)`);
        return null;
      }
      throw error;
    }
  }

  /** Whether Sonarr still has an episode file with this id. */
  private async episodeFileExists(fileId: number): Promise<boolean> {
    try {
      await this.client.get(`/episodefile/${fileId}`);
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  /**
   * Get a specific series by ID
   */
  async getSeriesById(id: number): Promise<SonarrSeries> {
    try {
      const response = await this.client.get<SonarrSeries>(`/series/${id}`);
      return response.data;
    } catch (error) {
      const axiosError = error as AxiosError;
      logger.error(`Failed to get series ${id} from Sonarr`, {
        status: axiosError.response?.status,
        message: axiosError.message,
      });
      throw error;
    }
  }

  /**
   * Get all episodes for a series
   */
  async getEpisodes(seriesId: number): Promise<SonarrEpisode[]> {
    try {
      const response = await this.client.get<SonarrEpisode[]>('/episode', {
        params: { seriesId },
      });
      logger.debug(`Retrieved ${response.data.length} episodes for series ${seriesId}`);
      return response.data;
    } catch (error) {
      const axiosError = error as AxiosError;
      logger.error(`Failed to get episodes for series ${seriesId}`, {
        status: axiosError.response?.status,
        message: axiosError.message,
      });
      throw error;
    }
  }

  /**
   * Get episode files for a series
   */
  async getEpisodeFiles(seriesId: number): Promise<SonarrEpisodeFile[]> {
    try {
      const response = await this.client.get<SonarrEpisodeFile[]>('/episodefile', {
        params: { seriesId },
      });
      logger.debug(`Retrieved ${response.data.length} episode files for series ${seriesId}`);
      return response.data;
    } catch (error) {
      const axiosError = error as AxiosError;
      logger.error(`Failed to get episode files for series ${seriesId}`, {
        status: axiosError.response?.status,
        message: axiosError.message,
      });
      throw error;
    }
  }

  /**
   * Delete a series. Resolves to 'not_found' when Sonarr had already let it go.
   *
   * With deleteFiles Sonarr removes every file inside this one request, which
   * can outlast any sensible HTTP timeout, so the call gets the delete timeout
   * and is verified against Sonarr if even that is exceeded.
   */
  async deleteSeries(id: number, deleteFiles: boolean = false): Promise<'deleted' | 'not_found'> {
    try {
      await this.client.delete(`/series/${id}`, {
        params: { deleteFiles },
        timeout: this.timing.deleteTimeoutMs,
      });
      logger.info(`Deleted series ${id} from Sonarr`, { deleteFiles });
      return 'deleted';
    } catch (error) {
      if (isNotFound(error)) {
        logger.info(`Series ${id} not found in Sonarr (already deleted)`);
        return 'not_found';
      }
      if (isTimeout(error)) {
        logger.warn(`Sonarr did not answer the delete of series ${id} within ${this.timing.deleteTimeoutMs}ms; checking whether it finished`);
        const gone = await waitUntilGone(async () => (await this.findSeriesById(id)) === null, this.timing);
        if (gone) {
          logger.info(`Sonarr finished removing series ${id} after the request timed out`);
          return 'deleted';
        }
        throw new Error(
          `Sonarr did not finish removing series ${id} within ${Math.round((this.timing.deleteTimeoutMs + this.timing.verifyWindowMs) / 1000)}s; it may still be working on it`
        );
      }
      const axiosError = error as AxiosError;
      logger.error(`Failed to delete series ${id} from Sonarr`, {
        status: axiosError.response?.status,
        message: axiosError.message,
      });
      throw error;
    }
  }

  /**
   * Remove a series completely (alias for deleteSeries with deleteFiles=true)
   */
  async removeSeries(id: number, deleteFiles: boolean = true): Promise<'deleted' | 'not_found'> {
    return this.deleteSeries(id, deleteFiles);
  }

  /**
   * Delete an episode file.
   *
   * Sonarr deletes the file inside this request. When that outlasts the delete
   * timeout the file is polled until it is gone (or the verification window
   * runs out) instead of failing a delete that is still in progress.
   * `onVerifying` fires when that wait begins.
   */
  async deleteEpisodeFile(id: number, onVerifying?: () => void): Promise<void> {
    try {
      await this.client.delete(`/episodefile/${id}`, { timeout: this.timing.deleteTimeoutMs });
      logger.info(`Deleted episode file ${id} from Sonarr`);
    } catch (error) {
      if (isNotFound(error)) {
        logger.info(`Episode file ${id} not found in Sonarr (already deleted)`);
        return;
      }
      if (isTimeout(error)) {
        logger.warn(`Sonarr did not answer the delete of episode file ${id} within ${this.timing.deleteTimeoutMs}ms; waiting for it to finish`);
        onVerifying?.();
        const gone = await waitUntilGone(async () => !(await this.episodeFileExists(id)), this.timing);
        if (gone) {
          logger.info(`Sonarr finished deleting episode file ${id} after the request timed out`);
          return;
        }
        throw new Error(
          `Sonarr did not finish deleting episode file ${id} within ${Math.round((this.timing.deleteTimeoutMs + this.timing.verifyWindowMs) / 1000)}s; it may still be working on it. Raise ARR_DELETE_TIMEOUT_MS if your storage is slow.`
        );
      }
      const axiosError = error as AxiosError;
      logger.error(`Failed to delete episode file ${id} from Sonarr`, {
        status: axiosError.response?.status,
        message: axiosError.message,
      });
      throw error;
    }
  }

  /**
   * Progress callback type for deletion operations
   */
  public static readonly ProgressCallback = Symbol('ProgressCallback');

  /**
   * Delete every episode file of a series while keeping the series in Sonarr.
   *
   * Resolves rather than throws for the "nothing to do" cases (no files, or
   * Sonarr no longer has the series). Files that fail are counted and their
   * errors collected, so the caller can decide that a half-deleted show is
   * not a finished deletion.
   */
  async deleteAllEpisodeFiles(
    seriesId: number,
    onProgress?: (progress: FileDeletionProgress) => void
  ): Promise<SeriesFileDeletionResult> {
    // Sonarr answers an unknown series id with an empty list here, so ask for
    // the series itself first: that is the only way to tell "no files" from
    // "already removed".
    const series = await this.findSeriesById(seriesId);
    if (!series) {
      return { outcome: 'not_found', deleted: 0, failed: 0, freedBytes: 0, errors: [] };
    }

    const episodeFiles = await this.getEpisodeFiles(seriesId);

    if (episodeFiles.length === 0) {
      logger.info(`No episode files found for series ${seriesId}`);
      return { outcome: 'no_files', deleted: 0, failed: 0, freedBytes: 0, errors: [] };
    }

    let deleted = 0;
    let failed = 0;
    let freedBytes = 0;
    const errors: string[] = [];
    const total = episodeFiles.length;

    for (let i = 0; i < episodeFiles.length; i++) {
      const file = episodeFiles[i];
      if (!file) continue;
      const fileName = file.relativePath || file.path || `Episode file ${file.id}`;

      onProgress?.({ current: i + 1, total, fileName, status: 'deleting' });

      try {
        await this.deleteEpisodeFile(file.id, () =>
          onProgress?.({ current: i + 1, total, fileName, status: 'verifying' })
        );
        deleted++;
        freedBytes += file.size || 0;
        onProgress?.({ current: i + 1, total, fileName, status: 'deleted' });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`Failed to delete episode file ${file.id} for series ${seriesId}: ${message}`);
        failed++;
        errors.push(`${fileName}: ${message}`);
        onProgress?.({ current: i + 1, total, fileName, status: 'failed' });
      }
    }

    logger.info(`Deleted ${deleted}/${episodeFiles.length} episode files for series ${seriesId}`);
    return { outcome: 'deleted', deleted, failed, freedBytes, errors };
  }

  /**
   * Unmonitor a series. Resolves to 'not_found' when Sonarr no longer has it,
   * so callers can stop there instead of failing on the follow-up calls.
   */
  async unmonitorSeries(id: number): Promise<'unmonitored' | 'not_found'> {
    const series = await this.findSeriesById(id);
    if (!series) return 'not_found';
    if (!series.monitored) {
      // A retry after an earlier attempt got this far: nothing to do.
      logger.info(`Series ${id} is already unmonitored in Sonarr`);
      return 'unmonitored';
    }

    // The bulk editor endpoint is what Sonarr's own UI uses to toggle
    // monitoring. It changes just that flag, instead of a full PUT of the
    // series object, which Sonarr re-validates (path, root folder, seasons).
    const started = Date.now();
    try {
      await this.client.put(
        '/series/editor',
        { seriesIds: [id], monitored: false },
        { timeout: this.timing.deleteTimeoutMs }
      );
      logger.info(`Unmonitored series ${id} in Sonarr in ${Date.now() - started}ms`);
      return 'unmonitored';
    } catch (error) {
      if (isNotFound(error)) {
        logger.info(`Series ${id} disappeared from Sonarr while unmonitoring it`);
        return 'not_found';
      }
      if (isTimeout(error)) {
        logger.warn(`Sonarr did not answer the unmonitor of series ${id} within ${this.timing.deleteTimeoutMs}ms; checking whether it applied`);
        const done = await waitUntilGone(async () => {
          const current = await this.findSeriesById(id);
          return current === null || !current.monitored;
        }, this.timing);
        if (done) return 'unmonitored';
        throw new Error(`Sonarr did not finish unmonitoring series ${id} within ${Math.round((this.timing.deleteTimeoutMs + this.timing.verifyWindowMs) / 1000)}s`);
      }
      const axiosError = error as AxiosError;
      logger.error(`Failed to unmonitor series ${id} in Sonarr`, {
        status: axiosError.response?.status,
        message: axiosError.message,
      });
      throw error;
    }
  }

  /**
   * Unmonitor specific episodes
   */
  async unmonitorEpisodes(episodeIds: number[]): Promise<void> {
    if (episodeIds.length === 0) {
      return;
    }

    try {
      await this.client.put('/episode/monitor', {
        episodeIds,
        monitored: false,
      });

      logger.info(`Unmonitored ${episodeIds.length} episodes in Sonarr`);
    } catch (error) {
      const axiosError = error as AxiosError;
      logger.error('Failed to unmonitor episodes in Sonarr', {
        status: axiosError.response?.status,
        message: axiosError.message,
        episodeIds,
      });
      throw error;
    }
  }

  /**
   * Get quality profiles as a map of ID to name.
   *
   * Used to show which profile a series is tracked against; failures are the
   * caller's to handle (the series detail view treats it as optional garnish).
   */
  async getQualityProfiles(): Promise<Map<number, string>> {
    try {
      const response = await this.client.get<SonarrQualityProfile[]>('/qualityprofile');
      const profiles = new Map<number, string>();
      for (const profile of response.data) {
        profiles.set(profile.id, profile.name);
      }
      logger.debug(`Retrieved ${profiles.size} quality profiles from Sonarr`);
      return profiles;
    } catch (error) {
      const axiosError = error as AxiosError;
      logger.error('Failed to get quality profiles from Sonarr', {
        status: axiosError.response?.status,
        message: axiosError.message,
      });
      throw error;
    }
  }

  /**
   * Get the download queue.
   *
   * Sonarr's /queue is paged and has no dependable per-series filter across v3
   * and v4, so we page through it (bounded) and let callers filter by seriesId.
   */
  async getQueue(maxPages: number = 5, pageSize: number = 200): Promise<SonarrQueueRecord[]> {
    try {
      const records: SonarrQueueRecord[] = [];

      for (let page = 1; page <= maxPages; page++) {
        const response = await this.client.get<{
          page?: number;
          pageSize?: number;
          totalRecords?: number;
          records?: SonarrQueueRecord[];
        }>('/queue', {
          params: {
            page,
            pageSize,
            includeUnknownSeriesItems: false,
            includeEpisode: true,
          },
        });

        const pageRecords = response.data?.records ?? [];
        records.push(...pageRecords);

        const totalRecords = response.data?.totalRecords ?? records.length;
        if (pageRecords.length < pageSize || records.length >= totalRecords) break;
      }

      logger.debug(`Retrieved ${records.length} queue records from Sonarr`);
      return records;
    } catch (error) {
      const axiosError = error as AxiosError;
      logger.error('Failed to get queue from Sonarr', {
        status: axiosError.response?.status,
        message: axiosError.message,
      });
      throw error;
    }
  }

  /**
   * Monitor or unmonitor a whole season.
   *
   * Sonarr has no season endpoint — the season's monitored flag lives on the
   * series, so this reads the series, flips the one season and writes it back.
   */
  async setSeasonMonitored(
    seriesId: number,
    seasonNumber: number,
    monitored: boolean
  ): Promise<void> {
    try {
      const series = await this.getSeriesById(seriesId);
      const season = series.seasons?.find((s) => s.seasonNumber === seasonNumber);

      if (!season) {
        logger.warn(`Season ${seasonNumber} not found on series ${seriesId}; skipping monitor update`);
        return;
      }
      if (season.monitored === monitored) return;

      season.monitored = monitored;
      await this.client.put(`/series/${seriesId}`, series);
      logger.info(
        `${monitored ? 'Monitored' : 'Unmonitored'} season ${seasonNumber} of series ${seriesId} in Sonarr`
      );
    } catch (error) {
      const axiosError = error as AxiosError;
      logger.error(`Failed to update monitoring for season ${seasonNumber} of series ${seriesId}`, {
        status: axiosError.response?.status,
        message: axiosError.message,
      });
      throw error;
    }
  }

  /**
   * Get the history Sonarr holds for one series: grabs, imports, file
   * deletions and failures, newest first.
   */
  async getSeriesHistory(seriesId: number): Promise<SonarrHistoryRecord[]> {
    try {
      const response = await this.client.get<SonarrHistoryRecord[] | { records?: SonarrHistoryRecord[] }>(
        '/history/series',
        { params: { seriesId, includeEpisode: false } }
      );

      // v3 returns a bare array here; be tolerant of a paged shape too.
      const records = Array.isArray(response.data) ? response.data : (response.data?.records ?? []);
      logger.debug(`Retrieved ${records.length} history records for series ${seriesId}`);
      return records;
    } catch (error) {
      const axiosError = error as AxiosError;
      logger.error(`Failed to get history for series ${seriesId}`, {
        status: axiosError.response?.status,
        message: axiosError.message,
      });
      throw error;
    }
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
      logger.info(`Retrieved ${tagMap.size} tags from Sonarr`);
      return tagMap;
    } catch (error) {
      const axiosError = error as AxiosError;
      logger.error('Failed to get tags from Sonarr', {
        status: axiosError.response?.status,
        message: axiosError.message,
      });
      throw error;
    }
  }

  /**
   * Search for a series by TVDB ID
   */
  async getSeriesByTvdbId(tvdbId: number): Promise<SonarrSeries | null> {
    try {
      const allSeries = await this.getSeries();
      return allSeries.find((s) => s.tvdbId === tvdbId) || null;
    } catch (error) {
      logger.error(`Failed to find series by TVDB ID ${tvdbId}`, {
        message: (error as Error).message,
      });
      return null;
    }
  }

  /**
   * Search for a series by IMDB ID
   */
  async getSeriesByImdbId(imdbId: string): Promise<SonarrSeries | null> {
    try {
      const allSeries = await this.getSeries();
      return allSeries.find((s) => s.imdbId === imdbId) || null;
    } catch (error) {
      logger.error(`Failed to find series by IMDB ID ${imdbId}`, {
        message: (error as Error).message,
      });
      return null;
    }
  }

  /**
   * Get total size on disk for a series
   */
  async getSeriesSizeOnDisk(seriesId: number): Promise<number> {
    try {
      const files = await this.getEpisodeFiles(seriesId);
      return files.reduce((total, file) => total + file.size, 0);
    } catch (error) {
      logger.error(`Failed to calculate size for series ${seriesId}`, {
        message: (error as Error).message,
      });
      return 0;
    }
  }

  /**
   * Refresh series metadata
   */
  async refreshSeries(seriesId: number): Promise<void> {
    try {
      await this.client.post('/command', {
        name: 'RefreshSeries',
        seriesId,
      });
      logger.info(`Triggered refresh for series ${seriesId} in Sonarr`);
    } catch (error) {
      const axiosError = error as AxiosError;
      logger.error(`Failed to refresh series ${seriesId} in Sonarr`, {
        status: axiosError.response?.status,
        message: axiosError.message,
      });
      throw error;
    }
  }
}

export default SonarrService;
