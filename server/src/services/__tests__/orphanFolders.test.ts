import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { Server } from 'http';

// Unmanaged folders end to end: a fake Radarr behind a real socket reports
// unmapped folders, answers lookups and accepts adds; a temp directory stands
// in for the mapped media share so sizes and deletes are real.

const { tmpDbPath } = vi.hoisted(() => {
  const osMod = require('os');
  const pathMod = require('path');
  return {
    tmpDbPath: pathMod.join(osMod.tmpdir(), `prunerr-folders-test-${process.pid}-${Date.now()}.db`),
  };
});

vi.mock('../../config', () => ({ default: { dbPath: tmpDbPath, nodeEnv: 'test' } }));
vi.mock('../../utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../db/repositories/collections', () => ({ default: {} }));

let radarr: RadarrService | null = null;
vi.mock('../init', () => ({
  getRadarrService: () => radarr,
  getSonarrService: () => null,
}));

import { initializeDatabase, getDatabase, closeDatabase } from '../../db/index';
import { RadarrService } from '../radarr';
import {
  deleteFolder,
  importFolder,
  invalidateCache,
  listOrphanFolders,
  lookupCandidates,
  matchFolder,
  parseFolderName,
  setFolderIgnored,
  setFoldersIgnored,
  suggestImports,
  setFolderMappings,
  toLocalPath,
} from '../orphanFolders';

let server: Server;
let baseUrl: string;
let mediaRoot: string;

const state = {
  unmapped: [] as Array<{ name: string; path: string; relativePath: string }>,
  added: [] as Record<string, unknown>[],
};

const catalogue = [
  { tmdbId: 296098, title: 'Deepwater Horizon', year: 2016, overview: 'Rig.', images: [{ coverType: 'poster', remoteUrl: 'http://img/dh.jpg' }], id: 0 },
  { tmdbId: 1, title: 'Deep Water', year: 2022, overview: 'Other.', images: [], id: 77 },
];

beforeAll(async () => {
  initializeDatabase();
  mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prunerr-media-'));

  const app = express();
  app.use(express.json());
  app.get('/api/v3/rootfolder', (_req, res) =>
    res.json([{ id: 1, path: '/movies', accessible: true, freeSpace: 10, unmappedFolders: state.unmapped }])
  );
  app.get('/api/v3/movie/lookup', (req, res) => {
    const term = String(req.query['term'] ?? '').toLowerCase();
    if (term.startsWith('tmdb:')) {
      const id = Number(term.slice(5));
      return res.json(catalogue.filter((m) => m.tmdbId === id));
    }
    const stem = (term.split(' ')[0] ?? '').slice(0, 4);
    return res.json(catalogue.filter((m) => m.title.toLowerCase().replace(/\s/g, '').startsWith(stem)));
  });
  app.get('/api/v3/qualityprofile', (_req, res) => res.json([{ id: 4, name: 'HD-1080p' }, { id: 6, name: 'Ultra-HD' }]));
  app.post('/api/v3/movie', (req, res) => {
    state.added.push(req.body);
    return res.status(201).json({ ...req.body, id: 900 });
  });

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
      resolve();
    });
  });
  radarr = new RadarrService(baseUrl, 'key', { deleteTimeoutMs: 1000, verifyWindowMs: 10, verifyIntervalMs: 5 });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDatabase();
  fs.rmSync(mediaRoot, { recursive: true, force: true });
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* ignore */ }
  }
});

function makeFolder(name: string, files: Record<string, number>): string {
  const dir = path.join(mediaRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, size] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, file), Buffer.alloc(size));
  }
  return dir;
}

beforeEach(() => {
  getDatabase().prepare("DELETE FROM settings WHERE key IN ('media_folder_mappings', 'orphan_folders_ignored')").run();
  getDatabase().prepare('DELETE FROM activity_log').run();
  state.unmapped = [];
  state.added = [];
  invalidateCache();
});

describe('parseFolderName', () => {
  it('reads title, year and id tags out of folder names', () => {
    expect(parseFolderName('Deepwater Horizon (2016)')).toMatchObject({ title: 'Deepwater Horizon', year: 2016, tmdbId: null });
    expect(parseFolderName('Deepwater Horizon (2016) {tmdb-296098}')).toMatchObject({ title: 'Deepwater Horizon', year: 2016, tmdbId: 296098 });
    expect(parseFolderName('The.Office.2005.S01-S09 [tvdb-73244]')).toMatchObject({ title: 'The Office', year: 2005, tvdbId: 73244 });
    expect(parseFolderName('Some Show [imdb-tt1234567]')).toMatchObject({ title: 'Some Show', year: null, imdbId: 'tt1234567' });
    expect(parseFolderName('random_stuff')).toMatchObject({ title: 'random stuff', year: null });
  });
});

describe('matchFolder', () => {
  const base = { service: 'radarr' as const, serviceLabel: 'Radarr' as const, id: 'x', rootFolder: '/movies', path: '/movies/x', localPath: null, sizeBytes: null, fileCount: null, videoFiles: [], modifiedAt: null, ignored: false, canDelete: false, permissionIssues: null, writable: null, name: 'x' };
  const cand = (id: number, title: string, year: number | null, inLibrary = false) => ({ id, title, year, overview: null, posterUrl: null, inLibrary, existingId: inLibrary ? 1 : null });
  const withGuess = (name: string) => ({ ...base, name, guess: parseFolderName(name) });

  it('grades matches by id tag, title and year', () => {
    expect(matchFolder(withGuess('Deepwater Horizon (2016) {tmdb-296098}'), [cand(1, 'Deep Water', 2022), cand(296098, 'Deepwater Horizon', 2016)])).toMatchObject({ confidence: 'exact', candidate: { id: 296098 } });
    expect(matchFolder(withGuess('The Deepwater Horizon (2016)'), [cand(1, 'Deep Water', 2022), cand(2, 'Deepwater Horizon', 2016)])).toMatchObject({ confidence: 'exact', candidate: { id: 2 } });
    expect(matchFolder(withGuess('Deepwater Horizon (2017)'), [cand(2, 'Deepwater Horizon', 2016)])).toMatchObject({ confidence: 'likely', candidate: { id: 2 } });
    expect(matchFolder(withGuess('Deepwater Horizon (1999)'), [cand(2, 'Deepwater Horizon', 2016)])).toMatchObject({ confidence: 'weak' });
    expect(matchFolder(withGuess('Deepwater Horizon'), [cand(2, 'Deepwater Horizon', 2016)])).toMatchObject({ confidence: 'likely' });
    expect(matchFolder(withGuess('Deepwater Horizon'), [cand(2, 'Deepwater Horizon', 2016), cand(3, 'Deepwater Horizon', 2001)])).toMatchObject({ confidence: 'weak' });
    expect(matchFolder(withGuess('Something Else (2016)'), [cand(2, 'Deepwater Horizon', 2016)])).toMatchObject({ confidence: 'weak', candidate: { id: 2 } });
  });

  it('never picks a title already in the library and reports nothing usable', () => {
    expect(matchFolder(withGuess('Deepwater Horizon (2016)'), [cand(2, 'Deepwater Horizon', 2016, true)])).toMatchObject({ confidence: 'none', candidate: null, reason: expect.stringContaining('already in Radarr') });
    expect(matchFolder(withGuess('Deepwater Horizon (2016)'), [])).toMatchObject({ confidence: 'none', reason: 'No results' });
  });
});

describe('folder mappings', () => {
  it('maps service paths to local paths by longest prefix', () => {
    const mappings = [
      { remotePath: '/movies', localPath: '/media/movies' },
      { remotePath: '/movies/4k', localPath: '/media/uhd' },
    ];
    expect(toLocalPath('/movies/Film (2020)', mappings)).toBe('/media/movies/Film (2020)');
    expect(toLocalPath('/movies/4k/Film (2020)', mappings)).toBe('/media/uhd/Film (2020)');
    expect(toLocalPath('/tv/Show', mappings)).toBeNull();
  });

  it('rejects relative local paths and normalises trailing slashes', () => {
    expect(() => setFolderMappings([{ remotePath: '/movies', localPath: 'media/movies' }])).toThrow(/absolute/);
    expect(setFolderMappings([{ remotePath: '/movies/', localPath: '/media/movies/' }])).toEqual([{ remotePath: '/movies', localPath: '/media/movies' }]);
  });
});

describe('listing', () => {
  it('lists unmapped folders with sizes when mapped, and without when not', async () => {
    makeFolder('Deepwater Horizon (2016)', { 'movie.mkv': 5_000, 'movie.nfo': 10 });
    state.unmapped = [
      { name: 'Deepwater Horizon (2016)', path: '/movies/Deepwater Horizon (2016)', relativePath: 'Deepwater Horizon (2016)' },
      { name: 'Unknown Thing', path: '/movies/Unknown Thing', relativePath: 'Unknown Thing' },
    ];

    const before = await listOrphanFolders({ refresh: true });
    expect(before.folders).toHaveLength(2);
    expect(before.folders.every((f) => f.sizeBytes === null && !f.canDelete)).toBe(true);
    expect(before.unsized).toBe(2);

    setFolderMappings([{ remotePath: '/movies', localPath: mediaRoot }]);
    const after = await listOrphanFolders({ refresh: true });
    const dh = after.folders.find((f) => f.name.startsWith('Deepwater'))!;
    expect(dh).toMatchObject({ service: 'radarr', serviceLabel: 'Radarr', sizeBytes: 5_010, fileCount: 2, canDelete: true, videoFiles: ['movie.mkv'] });
    expect(dh.guess).toMatchObject({ title: 'Deepwater Horizon', year: 2016 });
    // Mapped but absent on disk: listed, unsized, not deletable.
    const unknown = after.folders.find((f) => f.name === 'Unknown Thing')!;
    expect(unknown).toMatchObject({ sizeBytes: null, canDelete: false, localPath: path.join(mediaRoot, 'Unknown Thing') });
    expect(after.totalSizeBytes).toBe(5_010);
  });

  it('hides ignored folders unless asked', async () => {
    state.unmapped = [{ name: 'Old Stuff', path: '/movies/Old Stuff', relativePath: 'Old Stuff' }];
    const listing = await listOrphanFolders({ refresh: true });
    const folder = listing.folders[0]!;
    await setFolderIgnored(folder.id, true, 'tester');
    expect((await listOrphanFolders({ refresh: true })).folders).toHaveLength(0);
    expect((await listOrphanFolders({ refresh: true, includeIgnored: true })).folders[0]).toMatchObject({ ignored: true });
    await setFolderIgnored(folder.id, false, 'tester');
    expect((await listOrphanFolders({ refresh: true })).folders).toHaveLength(1);
  });

  it('ignores many folders in one write and updates the cached listing in place', async () => {
    state.unmapped = [
      { name: 'A', path: '/movies/A', relativePath: 'A' },
      { name: 'B', path: '/movies/B', relativePath: 'B' },
      { name: 'C', path: '/movies/C', relativePath: 'C' },
    ];
    const listing = await listOrphanFolders({ refresh: true });
    const [a, b] = listing.folders;
    const result = await setFoldersIgnored([a!.id, b!.id, 'missing'], true, 'tester');
    expect(result.folders.map((f) => f.name)).toEqual(['A', 'B']);
    expect(result.missing).toEqual(['missing']);
    expect((await listOrphanFolders()).folders.map((f) => f.name)).toEqual(['C']);
    expect((await listOrphanFolders({ refresh: true })).folders.map((f) => f.name)).toEqual(['C']);
    const activity = getDatabase().prepare("SELECT COUNT(*) AS n FROM activity_log WHERE action = 'folder_ignored'").get() as { n: number };
    expect(activity.n).toBe(2);
  });
});

describe('lookup and import', () => {
  it('looks the folder up by its id tag when it has one, else by title and year', async () => {
    state.unmapped = [
      { name: 'Deepwater Horizon (2016) {tmdb-296098}', path: '/movies/Deepwater Horizon (2016) {tmdb-296098}', relativePath: 'x' },
      { name: 'Deepwater Horizon (2016)', path: '/movies/Deepwater Horizon (2016)', relativePath: 'y' },
    ];
    const listing = await listOrphanFolders({ refresh: true });
    const tagged = listing.folders.find((f) => f.name.includes('tmdb'))!;
    const plain = listing.folders.find((f) => !f.name.includes('tmdb'))!;

    const byId = await lookupCandidates(tagged.id);
    expect(byId.term).toBe('tmdb:296098');
    expect(byId.candidates).toHaveLength(1);
    expect(byId.candidates[0]).toMatchObject({ id: 296098, title: 'Deepwater Horizon', year: 2016, posterUrl: 'http://img/dh.jpg', inLibrary: false });

    const byTitle = await lookupCandidates(plain.id);
    expect(byTitle.term).toBe('Deepwater Horizon 2016');
    expect(byTitle.candidates.map((c) => [c.title, c.inLibrary])).toEqual([
      ['Deepwater Horizon', false],
      ['Deep Water', true],
    ]);
  });

  it('matches many folders at once and imports automatically only when the match is confident', async () => {
    state.unmapped = [
      { name: 'Deepwater Horizon (2016) {tmdb-296098}', path: '/movies/Deepwater Horizon (2016) {tmdb-296098}', relativePath: 'x' },
      { name: 'Deepwater Horizon (1999)', path: '/movies/Deepwater Horizon (1999)', relativePath: 'y' },
      { name: 'Deep Water (2022)', path: '/movies/Deep Water (2022)', relativePath: 'z' },
    ];
    const listing = await listOrphanFolders({ refresh: true });
    const ids = listing.folders.map((f) => f.id);
    const suggestions = await suggestImports([...ids, 'not-a-folder']);
    // Unsized folders list by name. "Deep Water" itself is already in Radarr,
    // so its best remaining result is a different title: a weak guess.
    expect(suggestions.map((s) => [s.name, s.confidence, s.candidate?.id ?? null])).toEqual([
      ['Deep Water (2022)', 'weak', 296098],
      ['Deepwater Horizon (1999)', 'weak', 296098],
      ['Deepwater Horizon (2016) {tmdb-296098}', 'exact', 296098],
    ]);
    expect(suggestions[0]!.reason).toMatch(/title differs/);

    const weak = listing.folders.find((f) => f.name.includes('1999'))!;
    await expect(importFolder(weak.id, { actorName: 'tester' })).rejects.toThrow(/No confident match/);
    const exact = listing.folders.find((f) => f.name.includes('tmdb'))!;
    const result = await importFolder(exact.id, { actorName: 'tester' });
    expect(result).toMatchObject({ addedId: 900, title: 'Deepwater Horizon' });
    // The imported folder leaves the cached listing without a full refresh.
    expect((await listOrphanFolders()).folders.map((f) => f.id)).not.toContain(exact.id);
  });

  it('adds the movie to Radarr with the folder as its path and refuses titles already there', async () => {
    state.unmapped = [{ name: 'Deepwater Horizon (2016)', path: '/movies/Deepwater Horizon (2016)', relativePath: 'y' }];
    const folder = (await listOrphanFolders({ refresh: true })).folders[0]!;

    await expect(importFolder(folder.id, { candidateId: 1, actorName: 'tester' })).rejects.toThrow(/already in Radarr/);
    await expect(importFolder(folder.id, { candidateId: 296098, qualityProfileId: 99, actorName: 'tester' })).rejects.toThrow(/Quality profile 99/);

    const result = await importFolder(folder.id, { candidateId: 296098, qualityProfileId: 6, actorName: 'tester' });
    expect(result).toMatchObject({ addedId: 900, title: 'Deepwater Horizon', year: 2016, service: 'radarr' });
    expect(state.added).toHaveLength(1);
    expect(state.added[0]).toMatchObject({
      tmdbId: 296098,
      path: '/movies/Deepwater Horizon (2016)',
      rootFolderPath: '/movies',
      qualityProfileId: 6,
      monitored: true,
      addOptions: { searchForMovie: false },
    });
    const activity = getDatabase().prepare("SELECT action, actor_name FROM activity_log WHERE action = 'folder_imported'").all() as Array<{ action: string; actor_name: string }>;
    expect(activity).toEqual([{ action: 'folder_imported', actor_name: 'tester' }]);
  });
});

describe('delete', () => {
  it('deletes a mapped folder and refuses an unmapped one', async () => {
    const dir = makeFolder('Junk (1999)', { 'a.mkv': 100, 'b.srt': 5 });
    state.unmapped = [{ name: 'Junk (1999)', path: '/movies/Junk (1999)', relativePath: 'Junk (1999)' }];

    const unmapped = (await listOrphanFolders({ refresh: true })).folders[0]!;
    await expect(deleteFolder(unmapped.id, { actorName: 'tester' })).rejects.toThrow(/No folder mapping/);
    expect(fs.existsSync(dir)).toBe(true);

    setFolderMappings([{ remotePath: '/movies', localPath: mediaRoot }]);
    const mapped = (await listOrphanFolders({ refresh: true })).folders[0]!;
    const result = await deleteFolder(mapped.id, { actorName: 'tester' });
    expect(result).toMatchObject({ sizeBytes: 105, fileCount: 2 });
    expect(fs.existsSync(dir)).toBe(false);
    const activity = getDatabase().prepare("SELECT action FROM activity_log WHERE action = 'folder_deleted'").all();
    expect(activity).toHaveLength(1);
  });

  it('never follows a symlink out of the mapped path, and never deletes the mapped root', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'prunerr-outside-'));
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
    const link = path.join(mediaRoot, 'Sneaky (2000)');
    fs.symlinkSync(outside, link, 'dir');
    setFolderMappings([{ remotePath: '/movies', localPath: mediaRoot }]);
    state.unmapped = [
      { name: 'Sneaky (2000)', path: '/movies/Sneaky (2000)', relativePath: 'Sneaky (2000)' },
      { name: '', path: '/movies', relativePath: '' },
    ];

    const listing = await listOrphanFolders({ refresh: true });
    const sneaky = listing.folders.find((f) => f.name === 'Sneaky (2000)')!;
    await expect(deleteFolder(sneaky.id, { actorName: 'tester' })).rejects.toThrow(/outside its mapped media path/);
    expect(fs.existsSync(path.join(outside, 'keep.txt'))).toBe(true);
    fs.unlinkSync(link);
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('refuses when the app has started managing the folder since the listing', async () => {
    const dir = makeFolder('Now Managed (2001)', { 'a.mkv': 1 });
    setFolderMappings([{ remotePath: '/movies', localPath: mediaRoot }]);
    state.unmapped = [{ name: 'Now Managed (2001)', path: '/movies/Now Managed (2001)', relativePath: 'Now Managed (2001)' }];
    const folder = (await listOrphanFolders({ refresh: true })).folders[0]!;

    state.unmapped = []; // Radarr imported it in the meantime
    await expect(deleteFolder(folder.id, { actorName: 'tester' })).rejects.toThrow(/now manages/);
    expect(fs.existsSync(dir)).toBe(true);
  });
});
