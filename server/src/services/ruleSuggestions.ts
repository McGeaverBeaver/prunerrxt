/**
 * Smart rule suggestions from a look at the library: ready-made rules with
 * the number of items and the space each would reclaim. Shared by the Rules
 * page and the MCP connector.
 */
import mediaItemsRepo from '../db/repositories/mediaItems';
import type { RuleCondition } from '../types';
import { formatBytes } from '../utils/format';

export interface RuleSuggestion {
  id: string;
  name: string;
  description: string;
  icon: string;
  matchCount: number;
  totalSize: number;
  totalSizeFormatted: string;
  conditions: RuleCondition[];
  mediaType: 'all' | 'movie' | 'show';
}

export interface RuleSuggestionsResult {
  suggestions: RuleSuggestion[];
  libraryStats: {
    totalItems: number;
    movies: number;
    shows: number;
    totalSize: number;
  };
}

export function buildRuleSuggestions(): RuleSuggestionsResult {
// Suggestions estimate how much a proposed rule would reclaim, so they must
// ignore tombstones for the same reason /preview does, and protected items,
// which a rule never deletes.
const items = mediaItemsRepo
  .fetchAll({ excludeDeleted: true })
  .filter((item) => !item.is_protected);

const now = new Date();
const suggestions: RuleSuggestion[] = [];

// 1. Never watched (added 30+ days ago, play_count = 0)
const neverWatched = items.filter((item) => {
  if (item.play_count > 0) return false;
  if (!item.added_at) return false;
  const days = Math.floor((now.getTime() - new Date(item.added_at).getTime()) / (1000 * 60 * 60 * 24));
  return days >= 30;
});
if (neverWatched.length > 0) {
  const size = neverWatched.reduce((sum, i) => sum + (i.file_size || 0), 0);
  suggestions.push({
    id: 'never-watched',
    name: 'Never Watched',
    description: 'Added 30+ days ago, never played',
    icon: 'download',
    matchCount: neverWatched.length,
    totalSize: size,
    totalSizeFormatted: formatBytes(size),
    conditions: [
      { field: 'play_count', operator: 'equals', value: 0 },
      { field: 'days_since_added', operator: 'greater_than', value: 30 },
    ],
    mediaType: 'all',
  });
}

// 2. Watched once (watched exactly once, 60+ days ago)
const watchedOnce = items.filter((item) => {
  if (item.play_count !== 1) return false;
  if (!item.last_watched_at) return false;
  const days = Math.floor((now.getTime() - new Date(item.last_watched_at).getTime()) / (1000 * 60 * 60 * 24));
  return days >= 60;
});
if (watchedOnce.length > 0) {
  const size = watchedOnce.reduce((sum, i) => sum + (i.file_size || 0), 0);
  suggestions.push({
    id: 'watched-once',
    name: 'Watched Once',
    description: 'Played once, 60+ days ago',
    icon: 'eye',
    matchCount: watchedOnce.length,
    totalSize: size,
    totalSizeFormatted: formatBytes(size),
    conditions: [
      { field: 'play_count', operator: 'equals', value: 1 },
      { field: 'days_since_watched', operator: 'greater_than', value: 60 },
    ],
    mediaType: 'all',
  });
}

// 3. Large files (10GB+, not watched in 30+ days)
const largeFiles = items.filter((item) => {
  if (!item.file_size || item.file_size < 10 * 1024 * 1024 * 1024) return false; // 10GB
  if (!item.last_watched_at) return true;
  const days = Math.floor((now.getTime() - new Date(item.last_watched_at).getTime()) / (1000 * 60 * 60 * 24));
  return days >= 30;
});
if (largeFiles.length > 0) {
  const size = largeFiles.reduce((sum, i) => sum + (i.file_size || 0), 0);
  suggestions.push({
    id: 'large-files',
    name: 'Large Files',
    description: '10GB+ files, not watched in 30+ days',
    icon: 'hard-drive',
    matchCount: largeFiles.length,
    totalSize: size,
    totalSizeFormatted: formatBytes(size),
    conditions: [
      { field: 'size_gb', operator: 'greater_than', value: 10 },
      { field: 'days_since_watched', operator: 'greater_than', value: 30 },
    ],
    mediaType: 'all',
  });
}

// 4. Stale content (not watched in 90+ days)
const stale = items.filter((item) => {
  if (!item.last_watched_at) {
    if (!item.added_at) return false;
    const days = Math.floor((now.getTime() - new Date(item.added_at).getTime()) / (1000 * 60 * 60 * 24));
    return days >= 90;
  }
  const days = Math.floor((now.getTime() - new Date(item.last_watched_at).getTime()) / (1000 * 60 * 60 * 24));
  return days >= 90;
});
if (stale.length > 0) {
  const size = stale.reduce((sum, i) => sum + (i.file_size || 0), 0);
  suggestions.push({
    id: 'stale',
    name: 'Stale Content',
    description: 'Not watched in 90+ days',
    icon: 'clock',
    matchCount: stale.length,
    totalSize: size,
    totalSizeFormatted: formatBytes(size),
    conditions: [{ field: 'days_since_watched', operator: 'greater_than', value: 90 }],
    mediaType: 'all',
  });
}

// 5. Old movies (movies watched once, 30+ days ago)
const oldMovies = items.filter((item) => {
  if (item.type !== 'movie') return false;
  if (item.play_count !== 1) return false;
  if (!item.last_watched_at) return false;
  const days = Math.floor((now.getTime() - new Date(item.last_watched_at).getTime()) / (1000 * 60 * 60 * 24));
  return days >= 30;
});
if (oldMovies.length > 0) {
  const size = oldMovies.reduce((sum, i) => sum + (i.file_size || 0), 0);
  suggestions.push({
    id: 'old-movies',
    name: 'Old Movies',
    description: 'Movies watched once, 30+ days ago',
    icon: 'film',
    matchCount: oldMovies.length,
    totalSize: size,
    totalSizeFormatted: formatBytes(size),
    conditions: [
      { field: 'play_count', operator: 'equals', value: 1 },
      { field: 'days_since_watched', operator: 'greater_than', value: 30 },
    ],
    mediaType: 'movie',
  });
}

// 6. Completed TV shows (TV shows not watched in 60+ days)
const completedShows = items.filter((item) => {
  if (item.type !== 'show') return false;
  if (!item.last_watched_at) return false;
  const days = Math.floor((now.getTime() - new Date(item.last_watched_at).getTime()) / (1000 * 60 * 60 * 24));
  return days >= 60;
});
if (completedShows.length > 0) {
  const size = completedShows.reduce((sum, i) => sum + (i.file_size || 0), 0);
  suggestions.push({
    id: 'completed-shows',
    name: 'Old TV Shows',
    description: 'TV shows not watched in 60+ days',
    icon: 'tv',
    matchCount: completedShows.length,
    totalSize: size,
    totalSizeFormatted: formatBytes(size),
    conditions: [{ field: 'days_since_watched', operator: 'greater_than', value: 60 }],
    mediaType: 'show',
  });
}

// 7. Low Quality Files (SD and 720p content)
const lowQuality = items.filter((item) => {
  const res = String(item.resolution || '');
  let resNum = 0;
  if (res.toLowerCase().includes('4k') || res.includes('2160')) resNum = 2160;
  else {
    const m = res.match(/(\d+)/);
    resNum = m && m[1] ? parseInt(m[1], 10) : 0;
  }
  return resNum > 0 && resNum < 1080;
});
if (lowQuality.length > 0) {
  const size = lowQuality.reduce((sum, i) => sum + (i.file_size || 0), 0);
  suggestions.push({
    id: 'low-quality',
    name: 'Low Quality Files',
    description: 'Remove SD and 720p content to save space',
    icon: 'monitor',
    matchCount: lowQuality.length,
    totalSize: size,
    totalSizeFormatted: formatBytes(size),
    conditions: [
      { field: 'resolution_number', operator: 'less_than', value: 1080 },
    ],
    mediaType: 'all',
  });
}

// 8. Old Codec Cleanup (H.264 or similar)
const oldCodec = items.filter((item) => {
  if (item.type !== 'movie') return false;
  const codec = (item.codec || '').toLowerCase();
  return codec.includes('h264') || codec.includes('h.264');
});
if (oldCodec.length > 0) {
  const size = oldCodec.reduce((sum, i) => sum + (i.file_size || 0), 0);
  suggestions.push({
    id: 'old-codec',
    name: 'Old Codec Cleanup',
    description: 'Remove files using older codecs like H.264 or MPEG',
    icon: 'film',
    matchCount: oldCodec.length,
    totalSize: size,
    totalSizeFormatted: formatBytes(size),
    conditions: [
      { field: 'codec', operator: 'contains', value: 'h264' },
    ],
    mediaType: 'movie',
  });
}

// 9. Classic Movies Never Rewatched (before 2015, not watched in 180+ days)
const classicNeverRewatched = items.filter((item) => {
  if (item.type !== 'movie') return false;
  if (!item.year || item.year >= 2015) return false;
  if (!item.last_watched_at) return true; // Never watched counts
  const days = Math.floor((now.getTime() - new Date(item.last_watched_at).getTime()) / (1000 * 60 * 60 * 24));
  return days > 180;
});
if (classicNeverRewatched.length > 0) {
  const size = classicNeverRewatched.reduce((sum, i) => sum + (i.file_size || 0), 0);
  suggestions.push({
    id: 'classic-never-rewatched',
    name: 'Classic Movies Never Rewatched',
    description: "Movies released before 2015 that haven't been watched recently",
    icon: 'clock',
    matchCount: classicNeverRewatched.length,
    totalSize: size,
    totalSizeFormatted: formatBytes(size),
    conditions: [
      { field: 'year', operator: 'less_than', value: 2015 },
      { field: 'days_since_watched', operator: 'greater_than', value: 180 },
    ],
    mediaType: 'movie',
  });
}

// 10. Large 4K Files Watched Once (4K, play_count = 1, 20GB+)
const large4kWatchedOnce = items.filter((item) => {
  if (item.type !== 'movie') return false;
  if (item.play_count !== 1) return false;
  if (!item.file_size || item.file_size < 20 * 1024 * 1024 * 1024) return false; // 20GB
  const res = String(item.resolution || '');
  let resNum = 0;
  if (res.toLowerCase().includes('4k') || res.includes('2160')) resNum = 2160;
  else {
    const m = res.match(/(\d+)/);
    resNum = m && m[1] ? parseInt(m[1], 10) : 0;
  }
  return resNum > 2000;
});
if (large4kWatchedOnce.length > 0) {
  const size = large4kWatchedOnce.reduce((sum, i) => sum + (i.file_size || 0), 0);
  suggestions.push({
    id: 'large-4k-watched-once',
    name: 'Large 4K Files Watched Once',
    description: 'Large 4K files that have only been watched once',
    icon: 'hard-drive',
    matchCount: large4kWatchedOnce.length,
    totalSize: size,
    totalSizeFormatted: formatBytes(size),
    conditions: [
      { field: 'resolution_number', operator: 'greater_than', value: 2000 },
      { field: 'play_count', operator: 'equals', value: 1 },
      { field: 'size_gb', operator: 'greater_than', value: 20 },
    ],
    mediaType: 'movie',
  });
}

// 11. Low play count (watched 2 or fewer times, 90+ days ago)
const lowPlayCount = items.filter((item) => {
  if (item.play_count > 2) return false;
  if (!item.last_watched_at && !item.added_at) return false;
  const dateToCheck = item.last_watched_at || item.added_at;
  const days = Math.floor((now.getTime() - new Date(dateToCheck!).getTime()) / (1000 * 60 * 60 * 24));
  return days >= 90;
});
if (lowPlayCount.length > 0) {
  const size = lowPlayCount.reduce((sum, i) => sum + (i.file_size || 0), 0);
  suggestions.push({
    id: 'low-play-count',
    name: 'Rarely Watched',
    description: 'Played 2 or fewer times, 90+ days old',
    icon: 'eye',
    matchCount: lowPlayCount.length,
    totalSize: size,
    totalSizeFormatted: formatBytes(size),
    conditions: [
      { field: 'play_count', operator: 'less_than', value: 3 },
      { field: 'days_since_watched', operator: 'greater_than', value: 90 },
    ],
    mediaType: 'all',
  });
}

  return {
    suggestions,
    libraryStats: {
      totalItems: items.length,
      movies: items.filter((i) => i.type === 'movie').length,
      shows: items.filter((i) => i.type === 'show').length,
      totalSize: items.reduce((sum, i) => sum + (i.file_size || 0), 0),
    },
  };
}
