import { describe, it, expect } from 'vitest';
import { MovieMatcher, SeriesMatcher, normaliseTitle, parentFolderName } from '../arrMatch';

const movies = [
  { id: 1, title: '300', year: 2007, path: '/movies/300 (2006)' },
  { id: 2, title: '300: Rise of an Empire', year: 2014, path: '/movies/300 Rise of an Empire (2014)' },
  { id: 3, title: 'The Thing', year: 1982, path: '/movies/The Thing (1982)' },
  { id: 4, title: 'The Thing', year: 2011, path: '/movies/The Thing (2011)' },
  { id: 5, title: 'Léon: The Professional', originalTitle: 'Léon', year: 1994, path: '/movies/Leon (1994)' },
];

describe('MovieMatcher', () => {
  const matcher = new MovieMatcher(movies);

  it('matches by the folder the file sits in, whatever the mount prefix', () => {
    const hit = matcher.match({ title: '300', year: 2007, filePath: '/data/media/movies/300 (2006)/300 (2007).mkv' });
    expect(hit).toEqual({ item: movies[0], how: 'folder' });
  });

  it('falls back to title and year when the folder is unknown', () => {
    expect(matcher.match({ title: '300', year: 2007 })?.item.id).toBe(1);
    expect(matcher.match({ title: '300', year: 2006 })?.item.id).toBe(1);
    expect(matcher.match({ title: '300: Rise Of An Empire', year: 2014 })?.item.id).toBe(2);
  });

  it('refuses an ambiguous title', () => {
    expect(matcher.match({ title: 'The Thing' })).toBeNull();
    expect(matcher.match({ title: 'The Thing', year: 2011 })?.item.id).toBe(4);
  });

  it('ignores accents, punctuation and articles, and tries the original title', () => {
    expect(normaliseTitle('Léon: The Professional')).toBe('leon professional');
    expect(matcher.match({ title: 'Leon', year: 1994 })?.item.id).toBe(5);
    expect(matcher.match({ title: 'Nothing Here', year: 1994 })).toBeNull();
  });

  it('reads the parent folder with either separator', () => {
    expect(parentFolderName('C:\\Movies\\300 (2006)\\300.mkv')).toBe('300 (2006)');
    expect(parentFolderName(null)).toBe('');
  });
});

describe('SeriesMatcher', () => {
  const matcher = new SeriesMatcher([
    { id: 10, title: 'Slow Horses', year: 2022, path: '/tv/Slow Horses' },
    { id: 11, title: 'Doc', year: 2025, path: '/tv/Doc (US)' },
  ]);

  it('matches from an episode file two folders down, or from the series folder', () => {
    expect(matcher.match({ title: 'x', filePath: '/media/tv/Slow Horses/Season 01/Slow Horses - S01E01.mkv' })?.item.id).toBe(10);
    expect(matcher.match({ title: 'x', seriesFolder: '/media/tv/Doc (US)' })?.item.id).toBe(11);
  });

  it('matches by title and year otherwise', () => {
    expect(matcher.match({ title: 'slow horses', year: 2023 })).toEqual({ item: { id: 10, title: 'Slow Horses', year: 2022, path: '/tv/Slow Horses' }, how: 'title' });
    expect(matcher.match({ title: 'Doc (US)', year: 2025 })).toBeNull();
  });
});
