/**
 * When does a deleted title come back?
 *
 * A row with status 'deleted' is a tombstone: it keeps the history of what
 * PrunerrXT removed. Plex goes on listing a removed title until it rescans
 * and empties its trash, so a tombstone cannot be revived merely because Plex
 * still mentions it. It must be revived when the title is demonstrably still
 * there, otherwise the library silently shrinks: a title that was never
 * actually removed (an early rule run that marked rows without touching
 * Radarr, a delete that failed upstream, a re-download that Plex folded into
 * its old entry) stays hidden from every rule, count and chart for good.
 *
 * Evidence, strongest first:
 *   1. Radarr says the movie has a file, or Sonarr counts episode files.
 *   2. The file Plex reports exists on a path PrunerrXT has mounted.
 *   3. Plex added the title after the deletion: a genuine re-add.
 *   4. Plex has not trashed it and the deletion is old enough for Plex to
 *      have noticed a missing file.
 *
 * Counter-evidence beats all of it: Radarr or Sonarr reporting no file, or
 * the mounted file being absent, keeps the tombstone.
 */
import fs from 'fs';
import type { MatchedArrData, PlexMediaItem } from './types';
import { getFolderMappings, toLocalPath } from './orphanFolders';

export interface TombstoneEvidence {
  /** Radarr hasFile / Sonarr episodeFileCount > 0; null when the app was not asked. */
  arrHasFile: boolean | null;
  /** The file Plex reports, checked on a mounted path; null when no mapping covers it. */
  localFileExists: boolean | null;
  /** Plex marked the entry as trashed (its file is missing). */
  plexTrashed: boolean;
  /** Plex's added date (ISO) for the entry, when known. */
  addedAt: string | null;
}

export interface ReviveDecision {
  revive: boolean;
  reason: string;
}

/** How long Plex gets to notice a missing file before a listed title counts as alive. */
export const PLEX_TRASH_GRACE_DAYS = 7;

export function decideRevive(deletedAt: string | null, evidence: TombstoneEvidence, now: Date = new Date()): ReviveDecision {
  if (evidence.arrHasFile === false) return { revive: false, reason: 'Sonarr/Radarr reports no file' };
  if (evidence.localFileExists === false) return { revive: false, reason: 'file is not on disk' };
  if (evidence.arrHasFile === true) return { revive: true, reason: 'Sonarr/Radarr still has its file' };
  if (evidence.localFileExists === true) return { revive: true, reason: 'file is on disk' };
  if (evidence.plexTrashed) return { revive: false, reason: 'Plex has trashed it' };

  const deletedMs = deletedAt ? new Date(deletedAt).getTime() : NaN;
  if (evidence.addedAt && Number.isFinite(deletedMs) && new Date(evidence.addedAt).getTime() > deletedMs) {
    return { revive: true, reason: 'added to Plex after the deletion' };
  }
  if (Number.isFinite(deletedMs) && now.getTime() - deletedMs > PLEX_TRASH_GRACE_DAYS * 86_400_000) {
    return { revive: true, reason: `still listed by Plex ${PLEX_TRASH_GRACE_DAYS} days after the deletion` };
  }
  return { revive: false, reason: 'Plex may not have noticed the deletion yet' };
}

/** What the sync knows about a title's file, from Sonarr/Radarr and the local mounts. */
export function gatherEvidence(
  plexItem: Pick<PlexMediaItem, 'addedAt' | 'deletedAt'>,
  arrData: MatchedArrData | undefined,
  filePath: string | null,
  exists: (localPath: string) => boolean = fs.existsSync
): TombstoneEvidence {
  let arrHasFile: boolean | null = null;
  if (arrData?.radarrMovie) arrHasFile = Boolean(arrData.radarrMovie.hasFile);
  else if (arrData?.sonarrSeries) {
    const files = arrData.sonarrSeries.statistics?.episodeFileCount;
    arrHasFile = typeof files === 'number' ? files > 0 : null;
  }

  let localFileExists: boolean | null = null;
  if (filePath) {
    const local = toLocalPath(filePath, getFolderMappings());
    if (local) {
      try {
        localFileExists = exists(local);
      } catch {
        localFileExists = null;
      }
    }
  }

  return {
    arrHasFile,
    localFileExists,
    plexTrashed: Boolean(plexItem.deletedAt),
    addedAt: plexItem.addedAt ? new Date(plexItem.addedAt * 1000).toISOString() : null,
  };
}
