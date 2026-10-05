/**
 * Link a library item to the Radarr movie or Sonarr series that owns it when
 * the sync stored no id: by the folder the file sits in, then by title and
 * year (see arrMatch.ts). Used by the deletion service before it fails an
 * item as "not linked", and by Archive before it gives up on a verdict. The
 * id found is written back so neither has to look twice.
 */
import logger from '../utils/logger';
import mediaItemsRepo from '../db/repositories/mediaItems';
import type { MediaItem } from '../types';
import { getRadarrService, getSonarrService } from './init';
import { MovieMatcher, SeriesMatcher } from './arrMatch';

export interface ArrLinkHit {
  id: number;
  how: string;
}

export async function findRadarrId(item: Pick<MediaItem, 'title' | 'year' | 'file_path'>): Promise<ArrLinkHit | null> {
  const radarr = getRadarrService();
  if (!radarr) return null;
  const hit = new MovieMatcher(await radarr.getMovies()).match({ title: item.title, year: item.year, filePath: item.file_path });
  return hit ? { id: hit.item.id, how: hit.how } : null;
}

export async function findSonarrId(item: Pick<MediaItem, 'title' | 'year' | 'file_path'>): Promise<ArrLinkHit | null> {
  const sonarr = getSonarrService();
  if (!sonarr) return null;
  const hit = new SeriesMatcher(await sonarr.getSeries()).match({ title: item.title, year: item.year, filePath: item.file_path });
  return hit ? { id: hit.item.id, how: hit.how } : null;
}

/**
 * Give the item its missing Radarr/Sonarr id if one can be found, persist it,
 * and return the refreshed row. Returns the item unchanged when nothing
 * matched or the owning app is not configured; never throws.
 */
export async function linkToArr(item: MediaItem, context: string = 'lookup'): Promise<MediaItem> {
  try {
    if (item.type === 'movie' && !item.radarr_id) {
      const hit = await findRadarrId(item);
      if (!hit) return item;
      logger.info(`Linked "${item.title}" to Radarr #${hit.id} by ${hit.how} (${context})`);
      return mediaItemsRepo.update(item.id, { radarr_id: hit.id }) ?? { ...item, radarr_id: hit.id };
    }
    if (item.type === 'show' && !item.sonarr_id) {
      const hit = await findSonarrId(item);
      if (!hit) return item;
      logger.info(`Linked "${item.title}" to Sonarr #${hit.id} by ${hit.how} (${context})`);
      return mediaItemsRepo.update(item.id, { sonarr_id: hit.id }) ?? { ...item, sonarr_id: hit.id };
    }
  } catch (error) {
    logger.warn(`Could not look "${item.title}" up upstream: ${(error as Error).message}`);
  }
  return item;
}
