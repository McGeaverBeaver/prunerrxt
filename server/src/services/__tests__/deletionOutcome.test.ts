import { describe, it, expect, vi, beforeEach } from 'vitest';

// A delete is judged by what happened to the file, not by what the app
// answered. Sonarr/Radarr saying "done" with no file to remove frees nothing;
// a file that is still on a mounted path after "done" frees nothing either,
// and the job says so. Only a confirmed delete tells Plex to rescan the folder.

vi.mock('../../db/repositories/activity', () => ({ logActivity: vi.fn() }));
vi.mock('../../utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { DeletionService, type DeletionServiceDependencies } from '../deletion';
import { jobDoneMessage } from '../deletionJobs';
import { DeletionAction } from '../../rules/types';

type RadarrDeps = NonNullable<DeletionServiceDependencies['radarrService']>;

const movie = {
  id: 7,
  title: 'Tenet',
  type: 'movie',
  file_size: 69_939_809_855,
  file_path: '/movies/Tenet (2020)/Tenet (2020).mkv',
  library_key: '1',
  radarr_id: 4551,
  sonarr_id: null,
  tmdb_id: 577922,
} as never;

function build(over: Partial<DeletionServiceDependencies> = {}) {
  const radarr = {
    unmonitorMovie: vi.fn<RadarrDeps['unmonitorMovie']>(async () => 'unmonitored'),
    deleteMovieFilesByMovieId: vi.fn<RadarrDeps['deleteMovieFilesByMovieId']>(async () => ({ outcome: 'deleted' })),
    removeMovie: vi.fn<RadarrDeps['removeMovie']>(async () => 'deleted'),
  };
  const refreshPath = vi.fn(async () => undefined);
  const historyCreate = vi.fn(async () => ({}) as never);
  const service = new DeletionService({
    mediaItemRepository: { getById: async () => movie, update: vi.fn(async () => undefined), delete: vi.fn(), getByStatus: async () => [] },
    deletionHistoryRepository: { create: historyCreate },
    radarrService: radarr,
    mediaServerService: { refreshPath },
    ...over,
  } as never);
  return { service, radarr, refreshPath, historyCreate };
}

describe('executeDelete outcome', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reports the file deleted, the space freed, and asks Plex to rescan the folder', async () => {
    const { service, refreshPath, historyCreate } = build({ fileOnDisk: () => false });
    const result = await service.executeDelete(movie, DeletionAction.UNMONITOR_AND_DELETE);

    expect(result.success).toBe(true);
    expect(result.filesDeleted).toBe(true);
    expect(result.leftOnDisk).toBeUndefined();
    expect(result.fileSizeFreed).toBe(69_939_809_855);
    expect(refreshPath).toHaveBeenCalledWith('1', '/movies/Tenet (2020)');
    expect(historyCreate).toHaveBeenCalledWith(expect.objectContaining({ file_size: 69_939_809_855 }));
  });

  it('frees nothing when Radarr had no file, and says so', async () => {
    const { service, radarr, refreshPath } = build();
    radarr.deleteMovieFilesByMovieId.mockResolvedValue({ outcome: 'no_file' });
    const result = await service.executeDelete(movie, DeletionAction.UNMONITOR_AND_DELETE);

    expect(result.success).toBe(true);
    expect(result.filesDeleted).toBe(false);
    expect(result.fileSizeFreed).toBe(0);
    // No mount to check, so Plex is still told; its entry is stale either way.
    expect(refreshPath).toHaveBeenCalled();
  });

  it('frees nothing when the file is still on disk after Radarr said deleted', async () => {
    const { service, refreshPath, historyCreate } = build({ fileOnDisk: () => true });
    const result = await service.executeDelete(movie, DeletionAction.UNMONITOR_AND_DELETE);

    expect(result.success).toBe(true);
    expect(result.filesDeleted).toBe(true);
    expect(result.leftOnDisk).toBe('/movies/Tenet (2020)/Tenet (2020).mkv');
    expect(result.fileSizeFreed).toBe(0);
    expect(refreshPath).not.toHaveBeenCalled();
    expect(historyCreate).toHaveBeenCalledWith(expect.objectContaining({ file_size: null }));
  });

  it('does not check the disk or rescan for an unmonitor-only action', async () => {
    const fileOnDisk = vi.fn(() => true);
    const { service, refreshPath } = build({ fileOnDisk });
    const result = await service.executeDelete(movie, DeletionAction.UNMONITOR_ONLY);

    expect(result.success).toBe(true);
    expect(result.fileSizeFreed).toBe(0);
    expect(fileOnDisk).not.toHaveBeenCalled();
    expect(refreshPath).not.toHaveBeenCalled();
  });
});

describe('jobDoneMessage', () => {
  const base = { fileSizeFreedFormatted: '65.14 GB', deletionAction: 'unmonitor_and_delete' };

  it('names each outcome in terms of files', () => {
    expect(jobDoneMessage({ ...base, filesDeleted: true }, 'Radarr')).toBe('Deleted, 65.14 GB freed');
    expect(jobDoneMessage({ ...base, reconciled: true }, 'Radarr')).toBe('Already deleted in Radarr; removed from the queue');
    expect(jobDoneMessage({ ...base, filesDeleted: false }, 'Radarr')).toBe('Radarr had no file to delete; removed from the catalogue, nothing freed');
    expect(jobDoneMessage({ ...base, filesDeleted: true, leftOnDisk: '/movies/x.mkv' }, 'Radarr')).toBe(
      'Radarr reported the delete but /movies/x.mkv is still on disk; nothing freed'
    );
    expect(jobDoneMessage({ ...base, deletionAction: 'unmonitor_only' }, null)).toBe('Unmonitored in Sonarr/Radarr');
  });
});
