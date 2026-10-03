import { describe, it, expect, vi, beforeEach } from 'vitest';

// Delete Now against the real world: the movie was already deleted by hand in
// Radarr (404 everywhere), a file delete fails part-way, Radarr answers with a
// 5xx. Each case has to end with the right queue state, an activity entry that
// says what happened, and progress events that name the service and step.

const logActivitySpy = vi.fn();

vi.mock('../../db/repositories/activity', () => ({
  logActivity: (...args: unknown[]) => logActivitySpy(...args),
}));

vi.mock('../../utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { DeletionService, type DeletionProgress, type DeletionServiceDependencies } from '../deletion';

type RadarrDeps = NonNullable<DeletionServiceDependencies['radarrService']>;
type SonarrDeps = NonNullable<DeletionServiceDependencies['sonarrService']>;
import { DeletionAction } from '../../rules/types';

const movie = {
  id: 101,
  title: 'Some Movie',
  type: 'movie',
  file_size: 4_000_000_000,
  radarr_id: 501,
  sonarr_id: null,
  tmdb_id: 550,
} as never;

const show = {
  id: 102,
  title: 'Some Show',
  type: 'show',
  file_size: 9_000_000_000,
  radarr_id: null,
  sonarr_id: 77,
  tmdb_id: null,
} as never;

function upstreamError(status: number): Error {
  const error = new Error(`Request failed with status code ${status}`) as Error & {
    isAxiosError: boolean;
    response: { status: number };
  };
  error.isAxiosError = true;
  error.response = { status };
  return error;
}

function buildService(overrides: Record<string, unknown> = {}) {
  const update = vi.fn(async () => undefined);
  const historyCreate = vi.fn(async () => ({}) as never);
  const resetMediaByTmdbId = vi.fn(async () => ({ outcome: 'reset' as const, mediaId: 1 }));
  const radarr = {
    unmonitorMovie: vi.fn<RadarrDeps['unmonitorMovie']>(async () => 'unmonitored'),
    deleteMovieFilesByMovieId: vi.fn<RadarrDeps['deleteMovieFilesByMovieId']>(async () => ({ outcome: 'deleted' })),
    removeMovie: vi.fn<RadarrDeps['removeMovie']>(async () => 'deleted'),
  };
  const sonarr = {
    unmonitorSeries: vi.fn<SonarrDeps['unmonitorSeries']>(async () => 'unmonitored'),
    deleteAllEpisodeFiles: vi.fn<SonarrDeps['deleteAllEpisodeFiles']>(async () => ({ outcome: 'deleted', deleted: 3, failed: 0, errors: [] })),
    removeSeries: vi.fn<SonarrDeps['removeSeries']>(async () => 'deleted'),
  };
  const service = new DeletionService({
    mediaItemRepository: {
      getById: async () => movie,
      update,
      delete: vi.fn(async () => undefined),
      getByStatus: async () => [],
    },
    deletionHistoryRepository: { create: historyCreate },
    radarrService: radarr,
    sonarrService: sonarr,
    overseerrService: {
      resetMediaByTmdbId,
      getRequestedBy: async () => null,
      notifyRequesterOfDeletion: async () => true,
    },
    ...overrides,
  } as never);
  return { service, update, historyCreate, resetMediaByTmdbId, radarr, sonarr };
}

function activityEntries(): Array<Record<string, unknown>> {
  return logActivitySpy.mock.calls.map((call) => call[0] as Record<string, unknown>);
}

describe('executeDelete when the item is already gone upstream (404)', () => {
  beforeEach(() => logActivitySpy.mockClear());

  it('reconciles a movie Radarr no longer has instead of failing', async () => {
    const { service, update, historyCreate, resetMediaByTmdbId, radarr } = buildService();
    radarr.unmonitorMovie.mockResolvedValue('not_found');

    const events: DeletionProgress[] = [];
    const result = await service.executeDelete(movie, DeletionAction.UNMONITOR_AND_DELETE, {
      resetOverseerr: true,
      deletionType: 'manual',
      onProgress: (p) => events.push(p),
    });

    expect(result.success).toBe(true);
    expect(result.reconciled).toBe(true);
    // Nothing was freed by this run, and the file delete was never attempted.
    expect(result.fileSizeFreed).toBe(0);
    expect(radarr.deleteMovieFilesByMovieId).not.toHaveBeenCalled();
    // The Seerr reset still runs: the request needs clearing either way.
    expect(resetMediaByTmdbId).toHaveBeenCalledWith(550, 'movie');
    // The item leaves the queue as a deleted tombstone.
    expect(update).toHaveBeenCalledWith(101, expect.objectContaining({ status: 'deleted', delete_after: null }));
    expect(historyCreate).toHaveBeenCalledWith(expect.objectContaining({ file_size: null, deletion_type: 'manual' }));

    const [entry] = activityEntries();
    expect(entry).toMatchObject({ eventType: 'deletion', action: 'reconciled', actorName: 'Manual deletion' });
    expect(JSON.parse(entry!['metadata'] as string)).toMatchObject({
      reconciled: true,
      reason: 'already deleted upstream',
      service: 'Radarr',
      upstreamStatus: 404,
    });

    const complete = events.at(-1)!;
    expect(complete.stage).toBe('complete');
    expect(complete.result).toMatchObject({ success: true, reconciled: true, fileSizeFreed: 0 });
    expect(complete.message).toContain('already deleted in Radarr');
  });

  it('reconciles when the movie vanishes between unmonitor and file delete', async () => {
    const { service, radarr } = buildService();
    radarr.deleteMovieFilesByMovieId.mockResolvedValue({ outcome: 'not_found' });

    const result = await service.executeDelete(movie, DeletionAction.UNMONITOR_AND_DELETE);

    expect(result.success).toBe(true);
    expect(result.reconciled).toBe(true);
    expect(activityEntries()[0]).toMatchObject({ action: 'reconciled' });
  });

  it('reconciles a series Sonarr no longer has, on full removal too', async () => {
    const { service, sonarr } = buildService();
    sonarr.removeSeries.mockResolvedValue('not_found');

    const result = await service.executeDelete(show, DeletionAction.FULL_REMOVAL);

    expect(result.success).toBe(true);
    expect(result.reconciled).toBe(true);
    expect(JSON.parse(activityEntries()[0]!['metadata'] as string)).toMatchObject({ service: 'Sonarr' });
  });

  it('treats a movie with no file as done without claiming freed space', async () => {
    const { service, radarr } = buildService();
    radarr.deleteMovieFilesByMovieId.mockResolvedValue({ outcome: 'no_file' });

    const result = await service.executeDelete(movie, DeletionAction.UNMONITOR_AND_DELETE);

    expect(result.success).toBe(true);
    expect(result.reconciled).toBe(false);
    expect(result.fileSizeFreed).toBe(0);
    expect(activityEntries()[0]).toMatchObject({ action: 'deleted' });
  });
});

describe('executeDelete failures', () => {
  beforeEach(() => logActivitySpy.mockClear());

  it('logs an error activity naming the step, service and HTTP status', async () => {
    const { service, update, radarr } = buildService();
    radarr.deleteMovieFilesByMovieId.mockRejectedValue(upstreamError(500));

    const events: DeletionProgress[] = [];
    const result = await service.executeDelete(movie, DeletionAction.UNMONITOR_AND_DELETE, {
      ruleId: 7,
      onProgress: (p) => events.push(p),
    });

    expect(result.success).toBe(false);
    expect(result.failedStep).toBe('delete_files');
    expect(result.failedService).toBe('Radarr');
    expect(result.upstreamStatus).toBe(500);
    // The item stays in the queue.
    expect(update).not.toHaveBeenCalledWith(101, expect.objectContaining({ status: 'deleted' }));

    const [entry] = activityEntries();
    expect(entry).toMatchObject({
      eventType: 'error',
      action: 'deletion_failed',
      actorType: 'rule',
      actorId: '7',
      targetId: 101,
    });
    expect(JSON.parse(entry!['metadata'] as string)).toMatchObject({
      step: 'delete_files',
      service: 'Radarr',
      upstreamStatus: 500,
      message: 'Request failed with status code 500',
    });

    const errorEvent = events.at(-1)!;
    expect(errorEvent.stage).toBe('error');
    expect(errorEvent.step).toBe('delete_files');
    expect(errorEvent.service).toBe('Radarr');
    expect(errorEvent.result).toMatchObject({ success: false, step: 'delete_files', service: 'Radarr', upstreamStatus: 500 });
  });

  it('fails a show whose episode files only partly deleted, so it is retried', async () => {
    const { service, sonarr } = buildService();
    sonarr.deleteAllEpisodeFiles.mockResolvedValue({
      outcome: 'deleted',
      deleted: 2,
      failed: 1,
      errors: ['S01E03.mkv: Sonarr did not finish deleting episode file 9 within 210s'],
    });

    const result = await service.executeDelete(show, DeletionAction.UNMONITOR_AND_DELETE);

    expect(result.success).toBe(false);
    expect(result.error).toContain('1 of 3 episode files');
    expect(result.error).toContain('S01E03.mkv');
    expect(activityEntries()[0]).toMatchObject({ eventType: 'error', action: 'deletion_failed' });
  });

  it('records a timeout that verification could not resolve as a failure of that step', async () => {
    const { service, radarr } = buildService();
    radarr.deleteMovieFilesByMovieId.mockRejectedValue(
      new Error('Radarr did not finish deleting movie file 9001 within 210s; it may still be working on it')
    );

    const result = await service.executeDelete(movie, DeletionAction.UNMONITOR_AND_DELETE);

    expect(result.success).toBe(false);
    expect(result.failedStep).toBe('delete_files');
    expect(result.upstreamStatus).toBeUndefined();
    expect(JSON.parse(activityEntries()[0]!['metadata'] as string)).toMatchObject({ upstreamStatus: null });
  });
});

describe('executeDelete progress', () => {
  beforeEach(() => logActivitySpy.mockClear());

  it('names the right service and step for each stage of a movie deletion', async () => {
    const { service, radarr } = buildService();
    radarr.deleteMovieFilesByMovieId.mockImplementation(async (_id, onProgress) => {
      onProgress?.({ current: 1, total: 1, fileName: 'Movie (2024)/movie.mkv', status: 'deleting' });
      onProgress?.({ current: 1, total: 1, fileName: 'Movie (2024)/movie.mkv', status: 'verifying' });
      onProgress?.({ current: 1, total: 1, fileName: 'Movie (2024)/movie.mkv', status: 'deleted' });
      return { outcome: 'deleted' };
    });

    const events: DeletionProgress[] = [];
    const result = await service.executeDelete(movie, DeletionAction.UNMONITOR_AND_DELETE, {
      resetOverseerr: true,
      onProgress: (p) => events.push(p),
    });

    expect(result.success).toBe(true);
    expect(result.fileSizeFreed).toBe(4_000_000_000);
    expect(events.map((e) => e.stage)).toEqual([
      'starting',
      'unmonitoring',
      'deleting_files',
      'deleting_files',
      'verifying',
      'deleting_files',
      'resetting_overseerr',
      'complete',
    ]);
    const unmonitoring = events[1]!;
    expect(unmonitoring).toMatchObject({ step: 'unmonitor', service: 'Radarr' });
    expect(unmonitoring.message).toContain('Radarr');
    expect(unmonitoring.message).not.toContain('Sonarr');
    expect(events[4]!.message).toContain('still deleting');
    expect(events[6]).toMatchObject({ step: 'overseerr_reset', service: 'Overseerr' });
  });

  it('talks to Sonarr, not Radarr, for a show', async () => {
    const { service, radarr, sonarr } = buildService();

    const events: DeletionProgress[] = [];
    await service.executeDelete(show, DeletionAction.UNMONITOR_AND_DELETE, { onProgress: (p) => events.push(p) });

    expect(sonarr.unmonitorSeries).toHaveBeenCalledWith(77);
    expect(radarr.unmonitorMovie).not.toHaveBeenCalled();
    expect(events.filter((e) => e.service).every((e) => e.service === 'Sonarr')).toBe(true);
  });
});
