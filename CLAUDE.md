# Prunerr Development Guide

## Project Overview
Prunerr is a media library cleanup tool for Plex/Sonarr/Radarr. It helps users reclaim disk space by identifying and removing unwanted content based on customizable rules.

## Tech Stack
- **Backend**: Node.js + Express + TypeScript
- **Frontend**: React + Vite + TailwindCSS
- **Database**: SQLite (better-sqlite3)
- **Deployment**: Docker (multi-arch: amd64/arm64)

## Project Structure
```
/client          # React frontend
/server          # Express backend
/assets          # Icons and images
/my-prunerr.xml  # Unraid template
```

## Release Workflow

The image lives on the GitHub Container Registry as `ghcr.io/mcgeaverbeaver/prunerr`
(built by `.github/workflows/docker-publish.yml`, both amd64 and arm64, using
only the repository's own GitHub token). Three ways to publish:

- **Manual run** (Actions → Build and Push Docker Image → Run workflow) on
  `main` with the tag input left empty publishes `:main` and a pinned
  `:main-<sha>`. This is the day-to-day way to get a change onto the test box.
  A tag typed into the input is published as is.
- **Beta channel.** Pushing to the `beta` branch publishes `:beta`:
  `git push origin <your-branch>:beta`.
- **Release.** A version tag publishes `:<version>`, `:<major>.<minor>`,
  `:<major>` and `:latest`, and creates a GitHub Release with generated notes:

```bash
git push
git tag v1.x.x
git push origin v1.x.x
```

A plain push to `main` runs `ci.yml` (client and server lint, typecheck,
build and tests) but builds no image.

**No outbound calls.** Prunerr contacts only the services the user configures.
Do not add telemetry, update checks, remote feeds, CDN assets or any other
request to a third party.

## Related Repositories
- **This fork**: https://github.com/McGeaverBeaver/prunerr
- **Container image**: https://github.com/McGeaverBeaver/prunerr/pkgs/container/prunerr
- **Upstream**: https://github.com/helliott20/prunerr (its wiki is still the
  user documentation the README links to)

## Database Migrations
Migrations are in `/server/src/db/schema.ts`. They run automatically on startup. The migration system handles "duplicate column" errors gracefully for idempotency.

## Attribution
Do not attribute work to Claude anywhere in the repo or on GitHub. No
`Co-Authored-By: Claude` or session-link trailers in commit messages, no
"Generated with Claude Code" lines in PR descriptions, and no Claude footers
on issue, PR, review or discussion comments. Everything should read as coming
from the maintainer.

Every commit is authored and committed as exactly:

    McGeaverBeaver <29310945+McGeaverBeaver@users.noreply.github.com>

Never use any other name or email, and never a personal address.
`.claude/settings.json` sets this in git config when a session starts; if the
identity is ever different (`git config user.email`), set it before committing.

## Login, roles and the MCP connector
- Login is configured only by environment variables (`AUTH_ENABLED`, `OIDC_*`,
  `AUTH_LOCAL_*`); see `server/src/auth/config.ts` and `docs/authentication.md`.
  Roles are `admin` > `operator` > `viewer`; the policy lives in
  `server/src/auth/roles.ts` and is enforced in `server/src/middleware/apiAuth.ts`.
  The API key always acts as admin. With login off, everything behaves as before.
- The MCP server (`server/src/mcp/`) is mounted at `/mcp`, authenticates with the
  API key, and is **off while login is disabled** (`mcp/config.ts`). Tools are
  registered through `defineTool` so the catalogue in Settings stays in sync.
  Anything that frees disk space goes through `services/deletionQueue.ts` and
  `services/mediaActions.ts`, which the REST routes share; put new behaviour
  there, not in a route or a tool.
- Immediate deletion via MCP is a separate opt-in (`mcp_allow_immediate_deletion`).
- Delete Now and Delete All never run inside a request: they create rows in
  `deletion_jobs` and `services/deletionJobs.ts` runs them in the background,
  one at a time per service, resuming after a restart. The UI follows them over
  `/api/deletion-jobs/stream` (`contexts/DeletionJobsContext.tsx`). A Sonarr or
  Radarr delete that outlasts `ARR_DELETE_TIMEOUT_MS` is verified by polling,
  not failed; see `services/arrHttp.ts`.
- Unmanaged folders (`services/orphanFolders.ts`, the Folders page, the
  `folders` MCP tools) come from Sonarr's and Radarr's own unmapped-folder
  lists. Deleting one needs a folder mapping (`media_folder_mappings`) and
  stays strictly inside the mapped path; importing adds the title to the app
  with the folder as its path. See docs/folders.md.
- Bulk folder actions (delete, import, fix permissions) are `folder_jobs` rows
  run by `services/folderJobs.ts`, one lane per service, streamed at
  `/api/folders/jobs/stream` (`hooks/useFolderJobs.ts`). Per-folder work stays
  in `orphanFolders.ts`; the listing cache is patched in place after each job
  rather than rebuilt (a full rebuild walks every folder on disk).
- The Insights page (`services/insights/`, `routes/insights.ts`, client
  `components/Insights/`) has four blocks: stack health (Sonarr/Radarr `/health`
  and queue plus Prunerr's own signals), library quality, watch patterns and
  playback friction (Tautulli only). Each report is cached in memory for one
  to five minutes; `captureInsightSnapshot` stores one row a day in
  `insight_snapshots` for trends. The MCP tools `get_insights` and
  `get_insight_trends` return the same reports. See docs/insights.md.
- Watch state (`services/watchState.ts`): every provider's `WatchedStatus` now
  carries its raw `plays`; the scanner turns them into `media_items.watch_state`
  (JSON), `in_progress` and `watch_completion` at sync. Rule fields
  `in_progress`, `fully_watched`, `watch_completion`, `in_progress_by` and
  `completed_by` read those columns (`rules/conditions.ts`); MCP shapes carry
  `inProgress` / `watchCompletion` / `watchState`. See docs/watch-state.md.
- Disk pressure watches the typed paths (statfs) plus the volumes Sonarr and
  Radarr report from `/diskspace` (`services/arrDiskSpace.ts`, merged in
  `services/monitoredVolumes.ts`, switch `diskPressure_includeArrVolumes`).
  `computeDiskPressureStats`, the `monitorDiskPressure` task, the dashboard's
  volumes card and `get_overview` all read that merged list.
- Matching Plex items to Radarr/Sonarr goes by TMDB/TVDB/IMDb id first; when
  the ids disagree, `services/arrMatch.ts` falls back to the folder the file
  sits in (last path segment, so mount prefixes can differ) and then to a
  unique normalised title and year. The scanner uses it at sync, and
  `deletion.ts` asks the owning app once more before failing an item as
  "not linked", persisting the id it finds.
- Archive (`services/availabilityVerdict.ts` pure logic and settings,
  `services/availability.ts` the Radarr/Sonarr release search): every queued
  movie/show gets a verdict (`media_items.availability` JSON) saying whether
  it could be downloaded again; `archive_mode` = ask (hold it in the queue:
  `holdState` is applied in `deletion.ts`, `deletionQueue.ts` and
  `readyQueueIds`), archive (protect at once) or delete. An archived item is a
  protected item with `archived_at` set (`mediaActions.archiveItems`). Checks
  are kicked after queueing through `availabilityKick.ts` (avoids an import
  cycle), run by the `checkAvailability` task and before the nightly queue
  run. MCP: `check_availability`, `archive_items`, `unarchive_items`,
  `clear_availability_hold`. See docs/archive.md.
- Permission repair (`services/permissions.ts`) relies on the Dockerfile
  granting the Node binary `cap_chown,cap_fowner`; it only ever runs on paths
  resolved inside a folder mapping.

## Key Patterns
- Client uses `camelCase`, server/database uses `snake_case`
- Media type: client uses `'tv'`, server uses `'show'` - conversion happens in routes
- Version is injected at Docker build time via `APP_VERSION` env var
