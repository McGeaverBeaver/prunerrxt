import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';

// Radarr and Sonarr keep deleting after the HTTP client gives up. These tests
// run a fake of each behind a real socket: the DELETE hangs past the client's
// timeout while the follow-up GET flips to 404, which is exactly what a slow
// NAS looks like from Prunerr's side.

vi.mock('../../utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../db/repositories/collections', () => ({ default: {} }));
vi.mock('../../db/index', () => ({ getDatabase: () => ({}) }));

import { RadarrService } from '../radarr';
import { SonarrService } from '../sonarr';
import { isNotFound, isTimeout, resolveArrTiming } from '../arrHttp';

let server: Server;
let baseUrl: string;

// What the fakes believe is on disk.
const state = {
  movieFileExists: true,
  movieExists: true,
  episodeFileExists: true,
  seriesExists: true,
  /** Finish a hanging delete this many ms after it arrives. */
  deleteDurationMs: 400,
  /** Whether hanging deletes ever complete at all. */
  deleteCompletes: true,
  /** Whether the movie editor call never answers. */
  unmonitorHangs: false,
  seriesMonitored: true,
  calls: [] as string[],
  editorBodies: [] as unknown[],
};

const movie = { id: 601, title: 'Big File', hasFile: true, monitored: true, movieFile: { id: 9001, relativePath: 'Big File (2024)/big.mkv', size: 42 } };

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    state.calls.push(`${req.method} ${req.path}`);
    next();
  });

  // Radarr
  app.get('/api/v3/movie/:id', (_req, res) => {
    if (!state.movieExists) return res.status(404).json({ message: 'NotFound' });
    return res.json(state.movieFileExists ? movie : { ...movie, hasFile: false, movieFile: undefined });
  });
  app.put('/api/v3/movie/editor', (req, res) => {
    state.editorBodies.push(req.body);
    if (!state.movieExists) return res.status(404).json({ message: 'NotFound' });
    if (state.unmonitorHangs) return undefined;
    movie.monitored = false;
    return res.json([movie]);
  });
  app.get('/api/v3/moviefile/:id', (_req, res) => {
    if (!state.movieFileExists) return res.status(404).json({ message: 'NotFound' });
    return res.json(movie.movieFile);
  });
  app.delete('/api/v3/moviefile/:id', (_req, res) => {
    if (!state.movieFileExists) return res.status(404).json({ message: 'NotFound' });
    // Radarr deletes synchronously inside the request: the response only
    // comes once the file is gone, however long that takes.
    if (state.deleteCompletes) {
      setTimeout(() => {
        state.movieFileExists = false;
        if (!res.headersSent) res.status(200).end();
      }, state.deleteDurationMs);
    }
    return undefined;
  });

  // Sonarr
  app.get('/api/v3/series/:id', (_req, res) => {
    if (!state.seriesExists) return res.status(404).json({ message: 'NotFound' });
    return res.json({ id: 77, title: 'Show', monitored: state.seriesMonitored });
  });
  app.put('/api/v3/series/editor', (req, res) => {
    state.editorBodies.push(req.body);
    if (!state.seriesExists) return res.status(404).json({ message: 'NotFound' });
    state.seriesMonitored = false;
    return res.json([{ id: 77, monitored: false }]);
  });
  app.get('/api/v3/episodefile', (_req, res) => {
    return res.json(state.episodeFileExists ? [{ id: 9, seriesId: 77, relativePath: 'S01E01.mkv', size: 7 }] : []);
  });
  app.get('/api/v3/episodefile/:id', (_req, res) => {
    if (!state.episodeFileExists) return res.status(404).json({ message: 'NotFound' });
    return res.json({ id: 9 });
  });
  app.delete('/api/v3/episodefile/:id', (_req, res) => {
    if (!state.episodeFileExists) return res.status(404).json({ message: 'NotFound' });
    if (state.deleteCompletes) {
      setTimeout(() => {
        state.episodeFileExists = false;
        if (!res.headersSent) res.status(200).end();
      }, state.deleteDurationMs);
    }
    return undefined;
  });

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function reset(): void {
  state.movieFileExists = true;
  state.movieExists = true;
  state.episodeFileExists = true;
  state.seriesExists = true;
  state.deleteDurationMs = 400;
  state.deleteCompletes = true;
  state.unmonitorHangs = false;
  state.seriesMonitored = true;
  movie.monitored = true;
  state.calls = [];
  state.editorBodies = [];
}

// Short timings so the tests run in well under a second: the delete call is
// abandoned after 100 ms and the file is polled every 50 ms for up to 2 s.
const fast = { deleteTimeoutMs: 100, verifyWindowMs: 2_000, verifyIntervalMs: 50 };

describe('arrHttp classification', () => {
  it('reads timing from the environment with floors', () => {
    const prev = {
      t: process.env['ARR_DELETE_TIMEOUT_MS'],
      v: process.env['ARR_DELETE_VERIFY_MINUTES'],
      i: process.env['ARR_DELETE_VERIFY_INTERVAL_SECONDS'],
    };
    process.env['ARR_DELETE_TIMEOUT_MS'] = '1';
    process.env['ARR_DELETE_VERIFY_MINUTES'] = '5';
    process.env['ARR_DELETE_VERIFY_INTERVAL_SECONDS'] = '0';
    expect(resolveArrTiming()).toMatchObject({ deleteTimeoutMs: 5_000, verifyWindowMs: 300_000, verifyIntervalMs: 1_000 });
    delete process.env['ARR_DELETE_TIMEOUT_MS'];
    delete process.env['ARR_DELETE_VERIFY_MINUTES'];
    delete process.env['ARR_DELETE_VERIFY_INTERVAL_SECONDS'];
    expect(resolveArrTiming()).toMatchObject({ deleteTimeoutMs: 120_000, verifyWindowMs: 1_800_000, verifyIntervalMs: 15_000 });
    expect(resolveArrTiming({ deleteTimeoutMs: 7 })).toMatchObject({ deleteTimeoutMs: 7, verifyWindowMs: 1_800_000 });
    if (prev.t !== undefined) process.env['ARR_DELETE_TIMEOUT_MS'] = prev.t;
    if (prev.v !== undefined) process.env['ARR_DELETE_VERIFY_MINUTES'] = prev.v;
    if (prev.i !== undefined) process.env['ARR_DELETE_VERIFY_INTERVAL_SECONDS'] = prev.i;
  });

  it('tells a 404 from a timeout from anything else', () => {
    const notFound = Object.assign(new Error('404'), { isAxiosError: true, response: { status: 404 } });
    const timeout = Object.assign(new Error('timeout of 100ms exceeded'), { isAxiosError: true, code: 'ECONNABORTED' });
    expect(isNotFound(notFound)).toBe(true);
    expect(isTimeout(notFound)).toBe(false);
    expect(isTimeout(timeout)).toBe(true);
    expect(isNotFound(new Error('boom'))).toBe(false);
    expect(isTimeout(new Error('boom'))).toBe(false);
  });
});

describe('RadarrService deletes', () => {
  it('reports a movie Radarr no longer has as not_found, without a PUT', async () => {
    reset();
    state.movieExists = false;
    const radarr = new RadarrService(baseUrl, 'key', fast);

    expect(await radarr.unmonitorMovie(602)).toBe('not_found');
    expect(await radarr.deleteMovieFilesByMovieId(602)).toEqual({ outcome: 'not_found' });
    expect(state.calls.filter((c) => c.startsWith('PUT'))).toHaveLength(0);
    expect(state.calls.filter((c) => c.startsWith('DELETE'))).toHaveLength(0);
  });

  it('unmonitors through the editor endpoint and skips it when already unmonitored', async () => {
    reset();
    const radarr = new RadarrService(baseUrl, 'key', fast);

    expect(await radarr.unmonitorMovie(601)).toBe('unmonitored');
    expect(state.editorBodies).toEqual([{ movieIds: [601], monitored: false }]);
    expect(state.calls.filter((c) => c === 'PUT /api/v3/movie/601')).toHaveLength(0);

    // Second run (a retry): the GET already says unmonitored, so no PUT at all.
    expect(await radarr.unmonitorMovie(601)).toBe('unmonitored');
    expect(state.editorBodies).toHaveLength(1);
  });

  it('verifies an unmonitor that timed out by reading the flag back', async () => {
    reset();
    state.unmonitorHangs = true;
    const radarr = new RadarrService(baseUrl, 'key', { ...fast, verifyWindowMs: 300 });
    // Radarr applies the change but never answers; a later GET shows it.
    setTimeout(() => {
      movie.monitored = false;
    }, 150);

    expect(await radarr.unmonitorMovie(601)).toBe('unmonitored');
  });

  it('waits for a slow file delete to finish after the request times out', async () => {
    reset();
    const radarr = new RadarrService(baseUrl, 'key', fast);
    const progress: string[] = [];

    const result = await radarr.deleteMovieFilesByMovieId(601, (p) => progress.push(p.status));

    expect(result).toMatchObject({ outcome: 'deleted', fileName: 'Big File (2024)/big.mkv', fileSize: 42 });
    expect(state.movieFileExists).toBe(false);
    // The dialog saw the wait happen, and the final verdict.
    expect(progress).toEqual(['deleting', 'verifying', 'deleted']);
    expect(state.calls).toContain('GET /api/v3/moviefile/9001');
  });

  it('fails with a clear message when the file is still there after the verification window', async () => {
    reset();
    state.deleteCompletes = false;
    const radarr = new RadarrService(baseUrl, 'key', { ...fast, verifyWindowMs: 200 });
    const progress: string[] = [];

    await expect(radarr.deleteMovieFilesByMovieId(601, (p) => progress.push(p.status))).rejects.toThrow(
      /Radarr did not finish deleting movie file 9001/
    );
    expect(progress).toEqual(['deleting', 'verifying', 'failed']);
  });

  it('answers no_file when the movie has nothing on disk', async () => {
    reset();
    state.movieFileExists = false;
    const radarr = new RadarrService(baseUrl, 'key', fast);

    expect(await radarr.deleteMovieFilesByMovieId(601)).toEqual({ outcome: 'no_file' });
  });
});

describe('SonarrService deletes', () => {
  it('reports a series Sonarr no longer has as not_found', async () => {
    reset();
    state.seriesExists = false;
    const sonarr = new SonarrService(baseUrl, 'key', fast);

    expect(await sonarr.unmonitorSeries(77)).toBe('not_found');
    expect((await sonarr.deleteAllEpisodeFiles(77)).outcome).toBe('not_found');
  });

  it('unmonitors a series through the editor endpoint', async () => {
    reset();
    const sonarr = new SonarrService(baseUrl, 'key', fast);

    expect(await sonarr.unmonitorSeries(77)).toBe('unmonitored');
    expect(state.editorBodies).toEqual([{ seriesIds: [77], monitored: false }]);
    expect(await sonarr.unmonitorSeries(77)).toBe('unmonitored');
    expect(state.editorBodies).toHaveLength(1);
  });

  it('waits for a slow episode file delete and reports the bytes it freed', async () => {
    reset();
    const sonarr = new SonarrService(baseUrl, 'key', fast);
    const progress: string[] = [];

    const result = await sonarr.deleteAllEpisodeFiles(77, (p) => progress.push(p.status));

    expect(result).toMatchObject({ outcome: 'deleted', deleted: 1, failed: 0, freedBytes: 7, errors: [] });
    expect(progress).toEqual(['deleting', 'verifying', 'deleted']);
  });

  it('counts a file that never goes away as failed, with its error', async () => {
    reset();
    state.deleteCompletes = false;
    const sonarr = new SonarrService(baseUrl, 'key', { ...fast, verifyWindowMs: 200 });

    const result = await sonarr.deleteAllEpisodeFiles(77);

    expect(result).toMatchObject({ outcome: 'deleted', deleted: 0, failed: 1 });
    expect(result.errors[0]).toMatch(/S01E01\.mkv: Sonarr did not finish deleting episode file 9/);
  });
});
