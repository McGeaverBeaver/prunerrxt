# Library sync, tombstones and what "deleted" means

PrunerrXT's catalogue is a copy of what the media server lists, refreshed by
the nightly sync (`syncPlexLibrary`). Sonarr and Radarr are asked for each
title during the same pass, which is where the file size, the Arr ids and the
`hasFile` state come from.

## Tombstones

When PrunerrXT deletes a title, the row stays in `media_items` with
`status = 'deleted'` and a `deleted_at` date. The row is the history: it keeps
the title's activity, its deletion record and the id it had upstream. It
counts for nothing in the dashboard, the trend or the rules.

Plex keeps listing a removed title until it rescans the folder and empties its
trash, and a Plex on another host cannot watch a network mount for changes.
So "Plex still lists it" is not a reason to bring a tombstone back.

## When a tombstone comes back

At sync, every listed title that PrunerrXT holds as deleted is judged on
evidence (`services/tombstones.ts`), strongest first:

| Evidence | Outcome |
|---|---|
| Radarr says the movie has a file, or Sonarr counts episode files | revived |
| Radarr or Sonarr says it has no file | stays deleted |
| The file Plex reports exists on a path mapped in Settings → Folders | revived |
| The mapped path is missing | stays deleted |
| Plex has trashed the entry (`deletedAt` on the item) | stays deleted |
| Plex added it after the deletion (a genuine re-add) | revived |
| Plex still lists it, untrashed, more than 7 days after the deletion | revived |
| Deleted less than 7 days ago, nothing else known | stays deleted, Plex may not have noticed yet |

A revived title goes back to `monitored` with its queue state cleared. The
sync logs each one with the reason, and the total.

This matters because rows can be marked deleted without anything leaving the
disk: an early rule run before Radarr was linked, an upstream delete that
failed quietly, a re-download that Plex folded into its old entry. Without
revival those titles vanish from every count and rule for good while still
taking space.

## What a deletion reports

A deletion is judged by what happened to the file, not by what the app
answered:

- **Deleted, N GB freed.** Sonarr or Radarr removed a file. If the file's
  path is mapped in Settings → Folders, PrunerrXT also checked it is gone.
- **Had no file to delete.** The app had nothing to remove. The title leaves
  the catalogue, nothing was freed, and the deletion history records no size.
- **Still on disk.** The app reported the delete but the mapped file is still
  there. Nothing is counted as freed and the job says so. Look at the app's
  log: a permissions problem on the share is the usual cause.
- **Already deleted upstream.** The app no longer had the title; the queue
  caught up (reconciled).

After a confirmed delete PrunerrXT asks Plex to rescan the title's folder
(`/library/sections/{id}/refresh?path=`), so Plex drops the entry now rather
than at its next full scan. Jellyfin and Emby do not take a folder path; their
entries clear at their own scan.
