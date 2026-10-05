# Unmanaged folders

Sonarr and Radarr each know which folders under their root folders belong to
none of their series or movies. PrunerrXT lists them on the **Folders** page,
reading straight from both apps, and offers the two things worth doing with
such a folder:

- **Import** it into the app that owns the root folder. A lookup (from the
  folder name, or your own search term, or a `{tmdb-123}` / `[tvdb-123]` tag
  in the name) picks the title; the app adds it with the folder as its path
  and scans it in place. Nothing is moved.
- **Delete** it from disk. Sonarr and Radarr have no API for this, so PrunerrXT
  needs to see the files itself: see *Folder mappings* below.
- **Ignore** it, to keep a folder you know about off the list.

Everything is logged in the Activity log, and the same operations are
available through the MCP connector (`list_orphan_folders`,
`lookup_orphan_folder`, `import_orphan_folder`, `delete_orphan_folder`,
`ignore_orphan_folder`). Deleting through the connector needs the "allow
immediate deletion" switch, like every other destructive tool.

## Folder mappings

A mapping pairs a path as Sonarr/Radarr see it with the same location as the
PrunerrXT container sees it, for example `/movies` → `/media/movies`. With a
mapping in place PrunerrXT can measure each folder (size, file count, the video
files inside) and delete it. Without one, folders are still listed and can
still be imported; they just show no size and cannot be deleted.

1. Mount the media share into the PrunerrXT container, read-write if you want
   to delete. On Unraid that is a Path in the container settings, for
   example `/mnt/user/media` → `/media`.
2. In Settings, Connections, **Media folders**, add a mapping per root folder.
   The section lists the root folders your apps report, and the PrunerrXT side
   is a pick list of the volumes mounted into the container (and the folders
   inside them, two levels deep), read from the container's own mount table.
   Pick the one that holds the same files; choose *Type a path…* for anything
   deeper. A volume mounted read-only is marked as such: folders under it can
   be measured but not deleted.

Deletion is deliberately strict: a folder is removed only when its resolved
location sits strictly inside a mapped path (so a mapping can never reach a
root folder, a parent, or a symlink target outside the media tree), and only
after re-checking with the app that the folder is still unmanaged.

## Ownership and permissions

Media directories collect files owned by whoever wrote them: a DVR running as
root, a download client as another user. PrunerrXT runs as PUID:PGID, which is
also what Sonarr and Radarr usually run as, so such files block a delete
("permission denied") and would block the app's own renames after an import.

The image gives the Node binary the two Linux capabilities needed to set a
file's owner and mode without owning it (CAP_CHOWN and CAP_FOWNER), and
nothing more. On the Folders page a folder whose entries are owned by someone
else, or that PrunerrXT cannot write to, shows a badge and a **Fix permissions**
button. Repairing sets the configured owner and modes on the folder and
everything in it; with *Repair automatically* on (the default), a delete or
import that hits a permission error repairs the folder first and carries on,
so the end state is the same whether the folder is kept or removed. The
owner, the modes (0775 / 0664 by default) and the automatic repair switch are
under Settings, Connections, Media folders. Every repair is in the Activity
log.

If the container is run with capabilities dropped (`--cap-drop ALL`), the
page says so and repair is unavailable; `--cap-add CHOWN --cap-add FOWNER`
restores it.

## Working on many folders at once

Tick folders in the list (or "Select the N shown", which follows the current
search and filters) and the bar above the list offers the same actions for the
whole selection:

- **Import…** matches every selected folder against the catalogue of the app
  that owns it and shows the result first. Each match is graded: *exact* (an
  id tag in the folder name, or title and year both match), *likely* (title
  matches, no conflicting year), *check* (best guess) or *no match*. Exact and
  likely matches start ticked; untick or tick rows, pick a quality profile per
  app, then queue the imports.
- **Fix permissions** and **Delete…** queue one job per folder.
- **Ignore** / **Show again** apply at once.

Delete, import and fix run as background jobs, one at a time per app, so a
Sonarr batch never waits behind a Radarr one. The *Bulk jobs* panel at the top
of the page shows each batch's progress, the folder being worked on, failures
with a retry, and a button to stop the rest. Each delete is re-checked as
still unmanaged just before it goes. Jobs survive a restart: a batch that was
half done when the container updated carries on. Folders filter by
*Permission issues* and *No mapping* to find the ones that need attention.

Over the MCP connector the same is `preview_folder_imports`,
`run_folder_jobs` (import or fix permissions), `delete_orphan_folders`,
`ignore_orphan_folders`, `list_folder_jobs` and `cancel_folder_batch`.

