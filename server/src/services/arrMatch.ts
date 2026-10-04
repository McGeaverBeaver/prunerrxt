/**
 * Matching a media-server item to the Radarr movie or Sonarr series that
 * owns its files when the ids disagree.
 *
 * The sync matches by TMDB / TVDB / IMDb id first, which is right whenever
 * both apps agree on what a title is. They do not always: Plex can match a
 * folder to the wrong entry (a 2007 film filed under a 2024 IMDb id, say),
 * or to an entry with no TMDB id, and then nothing lines up even though the
 * file is sitting in the folder Radarr created. Two further clues settle
 * most of those:
 *
 *   1. the folder: Radarr and Sonarr name the folder they manage, and the
 *      media server reports the file inside it. The folder's last path
 *      segment ("300 (2006)") is compared, so it does not matter that the
 *      two containers may mount the share at different paths;
 *   2. the title and year: a normalised title (case, punctuation and
 *      articles ignored) with the year within one either way.
 *
 * Each clue only counts when it points at exactly one candidate.
 */

export interface MatchableMovie {
  id: number;
  title: string;
  originalTitle?: string;
  year: number;
  path: string;
}

export interface MatchableSeries {
  id: number;
  title: string;
  year: number;
  path: string;
}

export interface MatchClues {
  title: string;
  originalTitle?: string;
  year?: number | null;
  /** A file inside the title's folder, as the media server reports it. */
  filePath?: string | null;
}

export type FallbackMatchHow = 'folder' | 'title';

export interface FallbackMatch<T> {
  item: T;
  how: FallbackMatchHow;
}

/** Last path segment, with either separator and a trailing separator tolerated. */
export function lastSegment(p: string | null | undefined): string {
  if (!p) return '';
  const parts = p.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  return (parts[parts.length - 1] ?? '').trim().toLowerCase();
}

/** The folder a file sits in, as its last segment. */
export function parentFolderName(filePath: string | null | undefined): string {
  if (!filePath) return '';
  const parts = filePath.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  parts.pop();
  return (parts[parts.length - 1] ?? '').trim().toLowerCase();
}

/** "The Lord of the Rings: The Two Towers" and "lord of the rings two towers" compare equal. */
export function normaliseTitle(title: string | null | undefined): string {
  if (!title) return '';
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(the|a|an)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function yearClose(a: number | null | undefined, b: number | null | undefined): boolean {
  if (!a || !b) return true;
  return Math.abs(a - b) <= 1;
}

function uniqueOrNull<T>(candidates: T[]): T | null {
  return candidates.length === 1 ? candidates[0]! : null;
}

export class MovieMatcher {
  private readonly byFolder = new Map<string, MatchableMovie[]>();
  private readonly byTitle = new Map<string, MatchableMovie[]>();

  constructor(movies: readonly MatchableMovie[]) {
    for (const movie of movies) {
      const folder = lastSegment(movie.path);
      if (folder) this.byFolder.set(folder, [...(this.byFolder.get(folder) ?? []), movie]);
      for (const title of new Set([normaliseTitle(movie.title), normaliseTitle(movie.originalTitle)])) {
        if (title) this.byTitle.set(title, [...(this.byTitle.get(title) ?? []), movie]);
      }
    }
  }

  match(clues: MatchClues): FallbackMatch<MatchableMovie> | null {
    const folder = parentFolderName(clues.filePath);
    if (folder) {
      const hit = uniqueOrNull(this.byFolder.get(folder) ?? []);
      if (hit) return { item: hit, how: 'folder' };
    }
    for (const title of new Set([normaliseTitle(clues.title), normaliseTitle(clues.originalTitle)])) {
      if (!title) continue;
      const hit = uniqueOrNull((this.byTitle.get(title) ?? []).filter((m) => yearClose(m.year, clues.year)));
      if (hit) return { item: hit, how: 'title' };
    }
    return null;
  }
}

export class SeriesMatcher {
  private readonly byFolder = new Map<string, MatchableSeries[]>();
  private readonly byTitle = new Map<string, MatchableSeries[]>();

  constructor(series: readonly MatchableSeries[]) {
    for (const s of series) {
      const folder = lastSegment(s.path);
      if (folder) this.byFolder.set(folder, [...(this.byFolder.get(folder) ?? []), s]);
      const title = normaliseTitle(s.title);
      if (title) this.byTitle.set(title, [...(this.byTitle.get(title) ?? []), s]);
    }
  }

  /**
   * For a show, the clue file is an episode, two folders below the series
   * folder ("Show/Season 01/episode.mkv"), so both the parent and the
   * grandparent folder are tried. A series folder path (no file) also works.
   */
  match(clues: MatchClues & { seriesFolder?: string | null }): FallbackMatch<MatchableSeries> | null {
    const folders = new Set<string>();
    if (clues.seriesFolder) folders.add(lastSegment(clues.seriesFolder));
    if (clues.filePath) {
      const parts = clues.filePath.replace(/\\/g, '/').split('/').filter(Boolean);
      if (parts.length >= 2) folders.add(parts[parts.length - 2]!.trim().toLowerCase());
      if (parts.length >= 3) folders.add(parts[parts.length - 3]!.trim().toLowerCase());
    }
    for (const folder of folders) {
      if (!folder) continue;
      const hit = uniqueOrNull(this.byFolder.get(folder) ?? []);
      if (hit) return { item: hit, how: 'folder' };
    }
    const title = normaliseTitle(clues.title);
    if (title) {
      const hit = uniqueOrNull((this.byTitle.get(title) ?? []).filter((s) => yearClose(s.year, clues.year)));
      if (hit) return { item: hit, how: 'title' };
    }
    return null;
  }
}
