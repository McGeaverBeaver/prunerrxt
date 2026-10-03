# Unmanaged folders

Sonarr and Radarr each know which folders under their root folders belong to
none of their series or movies. Prunerr lists them on the **Folders** page,
reading straight from both apps, and offers the two things worth doing with
such a folder:

- **Import** it into the app that owns the root folder. A lookup (from the
  folder name, or your own search term, or a `{tmdb-123}` / `[tvdb-123]` tag
  in the name) picks the title; the app adds it with the folder as its path
  and scans it in place. Nothing is moved.
- **Delete** it from disk. Sonarr and Radarr have no API for this, so Prunerr
  needs to see the files itself: see *Folder mappings* below.
- **Ignore** it, to keep a folder you know about off the list.

Everything is logged in the Activity log, and the same operations are
available through the MCP connector (`list_orphan_folders`,
`lookup_orphan_folder`, `import_orphan_folder`, `delete_orphan_folder`,
`ignore_orphan_folder`). Deleting through the connector needs the "allow
immediate deletion" switch, like every other destructive tool.

## Folder mappings

A mapping pairs a path as Sonarr/Radarr see it with the same location as the
Prunerr container sees it, for example `/movies` → `/media/movies`. With a
mapping in place Prunerr can measure each folder (size, file count, the video
files inside) and delete it. Without one, folders are still listed and can
still be imported; they just show no size and cannot be deleted.

1. Mount the media share into the Prunerr container, read-write if you want
   to delete. On Unraid that is a Path in the container settings, for
   example `/mnt/user/media` → `/media`.
2. In Settings, Connections, **Media folders**, add a mapping per root folder.
   The section lists the root folders your apps report, so you only have to
   fill in where Prunerr sees each one.

Deletion is deliberately strict: a folder is removed only when its resolved
location sits strictly inside a mapped path (so a mapping can never reach a
root folder, a parent, or a symlink target outside the media tree), and only
after re-checking with the app that the folder is still unmanaged.
