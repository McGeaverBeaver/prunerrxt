<p align="center">
  <img src="assets/banner.svg" alt="PrunerrXT — Prune what nobody watches. Keep what you can't get back." width="100%">
</p>

<p align="center">
  <strong>Media library cleanup for Plex, Jellyfin and Emby, through Sonarr and Radarr, that knows what it can safely delete.</strong>
</p>

<p align="center">
  <a href="https://github.com/McGeaverBeaver/prunerr/pkgs/container/prunerr"><img src="https://img.shields.io/badge/image-ghcr.io%2Fmcgeaverbeaver%2Fprunerr-0db7ed?style=flat-square" alt="Container image"></a>
  <img src="https://img.shields.io/github/license/McGeaverBeaver/prunerr?style=flat-square" alt="License">
  <a href="https://github.com/McGeaverBeaver/prunerr/actions/workflows/docker-publish.yml"><img src="https://img.shields.io/github/actions/workflow/status/McGeaverBeaver/prunerr/docker-publish.yml?style=flat-square&label=image%20build" alt="Image build"></a>
  <a href="https://github.com/McGeaverBeaver/prunerr/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/McGeaverBeaver/prunerr/ci.yml?style=flat-square&label=ci" alt="CI"></a>
</p>

<p align="center">
  <a href="#quick-start">Install</a> &bull;
  <a href="#what-prunerrxt-adds">What XT adds</a> &bull;
  <a href="#features">Features</a> &bull;
  <a href="#documentation">Docs</a> &bull;
  <a href="#credits">Credits</a>
</p>

---

Your library keeps growing, nobody watches half of it, and the disk keeps filling up. PrunerrXT sits between your media server and your *arr apps and works out what is worth keeping. You write rules such as *"movies nobody has watched in six months that are over 20 GB"*, every match goes into a deletion queue with a grace period, and nothing is removed without you knowing.

What makes it **XT**: before a queued title is deleted, PrunerrXT asks Radarr or Sonarr whether it could be downloaded again as good as the copy you have. Titles that could not be are held or archived instead of deleted. Every decision, by a person, a rule or the AI assistant, lands in a tamper-evident audit log. And the whole stack is watched from one Insights page, so a failed delete, a dead indexer or a full volume is explained before it costs you anything.

PrunerrXT is built on [Prunerr](https://github.com/helliott20/prunerr) by Harry Elliott. See [Credits](#credits).

## What PrunerrXT adds

PrunerrXT was forked from Prunerr 1.8.2 at the end of September 2026. The middle column describes what the original does today; the right column is what PrunerrXT does instead.

| Area | Prunerr (original) | PrunerrXT |
|---|---|---|
| **Before a title is deleted** | Once the grace period ends, the title is deleted. Nothing checks whether you could ever get it back. | **Archive.** Asks Radarr or Sonarr to search the indexers for the title. If nothing comes back, or only a worse copy, or too few seeders, the title is held for a decision or archived (protected for good) instead of deleted. Checks pause while indexers are down or rate-limited and resume on their own. [docs](docs/archive.md) |
| **Queue overview** | Three numbers: items in the queue, items past their grace period, space to reclaim. | Adds how many queued titles are replaceable and how many are at risk, with the space those take, and a **Protect At-Risk** button that archives every at-risk title in one go. |
| **Seeing what is kept** | Protection shows as a badge on each item. There is no list of everything protected. | A **Protected** page: every protected title, every archived title and every protected collection, each with the reason and the date, releasable from the row. |
| **Record of who did what** | An activity log of scans, matches and jobs. It is a plain database table: it does not record logins, settings changes or who made a decision, and nothing would notice an entry being changed or removed. | A separate **audit log**: logins, settings and rule changes, every delete, protect, archive and "delete anyway" decision, every MCP call, with the actor and source. Append-only and HMAC-chained, so an altered or deleted entry is detected; verify button, daily check, anchor outside the database, JSON Lines export. [docs](docs/tasks-and-audit.md) |
| **Background work** | The schedule is listed in Settings with each job's last run. There is no view of what is running right now and no history of past runs. | A **Tasks** page: the Archive pass with live progress, syncs and jobs in flight, every scheduled job with its last and next run, a history of recent runs, and Run now for the read-only jobs. |
| **Who can use it** | Anyone who can reach the port can do anything. The API key protects the API only. | Optional login through Authentik or any OpenID Connect provider, admin / operator / viewer roles mapped from your groups, an optional local account, and a list of signed-in sessions you can sign out. Off by default. [docs](docs/authentication.md) |
| **AI assistant** | None. | A Model Context Protocol server at `/mcp` with OAuth 2.1, so Claude, Cursor or any MCP client can search the library, preview and build rules, review the queue and queue cleanups, through the same grace-period queue, with protected titles off limits and immediate deletion a separate opt-in. [docs](docs/mcp.md) |
| **Health of the whole setup** | The dashboard shows whether each service is reachable. | An **Insights** page: every problem across PrunerrXT, Sonarr, Radarr and the media server with a next step, the library's resolution and codec mix, what people actually watch, and where playback transcodes or gets abandoned; daily snapshots for trends. [docs](docs/insights.md) |
| **Watch history in rules** | Rules can use watched or unwatched, days since last watched, play count and who watched. | Also whether someone is part-way through a title, who finished it, and how much of a show has been seen, as rule fields (`in_progress`, `fully_watched`, `watch_completion`, `in_progress_by`, `completed_by`), so a rule can delete finished shows and never touch one someone is watching. [docs](docs/watch-state.md) |
| **Delete Now and Delete All** | The browser request waits while Sonarr or Radarr deletes the files. A slow delete times out and is reported as failed even when it finishes; closing the tab loses the result. | Deletions run as background jobs with live status in the UI, continue after a restart, recognise titles that were already removed, and verify a slow Sonarr or Radarr delete by polling instead of calling it a failure. |
| **When a delete fails** | You get the error text Sonarr or Radarr returned, which is usually a generic message that does not say why. | PrunerrXT reads Sonarr's and Radarr's own logs for the failed delete and shows the real cause (recycle bin on another filesystem, permission denied, missing root folder). Settings → Connections shows each app's health, version, command queue and deletion setup. |
| **Folders the apps do not own** | Not visible. Leftovers from moves, failed imports and titles removed without their files stay on disk. | A **Folders** page listing every folder under the root folders that no series or movie owns, with import into the right app or deletion, in bulk, strictly inside the mapped paths. [docs](docs/folders.md) |
| **Wrong file ownership** | Not handled. A folder Sonarr or Radarr cannot write to fails every delete. | Repairs the ownership and modes of media folders from inside PrunerrXT, only within mapped paths, using capabilities granted in the image. |
| **Where disk pressure looks** | Only at paths you type into Settings, which must be mounted into the container. | Also at the volumes Sonarr and Radarr report for their root folders, so nothing has to be mounted or typed. Only mounts that hold a root folder count; the apps' own container volumes never do. |
| **Matching Plex to Radarr/Sonarr** | By TMDB, TVDB and IMDb ids only. A title whose ids disagree is "not linked" and cannot be deleted. | Falls back to the folder the file sits in, then to a unique title and year, and asks the app once more before failing a delete as "not linked". |
| **Entering media paths** | Typed by hand. | A picker that lists the container's mounts, roots first. |
| **API key** | Always on. | Can be switched off, and shows when and from where it was last used. |
| **What leaves your network** | Sends an anonymous install ping and fetches a "What's new" feed from the project's servers. | Nothing. PrunerrXT talks only to the services you configure. No telemetry, no update check, no remote feed, no third-party fonts or scripts. |

## Features

Everything the original Prunerr does is still here, and works the same way.

- **Rules engine** &mdash; 40 condition fields across quality, ratings, watch history, watch state, collections and metadata. Build rules from templates, in plain English, or in a nested condition editor with a live preview that browses every match.
- **Deletion queue** &mdash; Grace periods, four deletion actions (unmonitor, delete files, remove from the app, or both), Seerr request resets, and a review queue. Nothing is removed without your say-so.
- **Archive** &mdash; The re-acquisition check described above, with three modes: hold and ask, archive automatically, or delete anyway.
- **Collections** &mdash; Synced from Radarr. Protect a whole collection or queue it for deletion in one go.
- **Episodes** &mdash; Sonarr episode breakdown on every show, with seasons and episodes deletable or queueable individually or in bulk.
- **Dashboard** &mdash; Library stats, storage trends, the volumes being watched, service health, upcoming deletions and recommendations.
- **Insights** &mdash; Stack health, library quality, watch patterns and playback friction.
- **Protected, Tasks and Audit pages** &mdash; What is kept, what is running, and who did what.
- **Plex, Jellyfin or Emby** &mdash; Pick your media server in Settings or with `MEDIA_SERVER_TYPE`. Rules, scanning and deletion work the same on each.
- **Per-user watch history** &mdash; Read from the media server, or through Tautulli or Tracearr on Plex, so rules can follow specific viewers.
- **Notifications** &mdash; Discord, signed webhooks and Home Assistant, in six languages.
- **Backup and restore** &mdash; The whole database, from Settings.
- **REST API** &mdash; Key-authenticated, for scripts, automation and mobile apps such as nzb360.
- **AI assistant** &mdash; The MCP connector, with protected items off limits and immediate deletion opt-in.
- **Login and roles** &mdash; Optional, configured by environment variables, off by default so an existing install behaves as before.

## Quick start

```bash
docker run -d \
  --name prunerr \
  -p 3000:3000 \
  -v /path/to/data:/app/data \
  -e PLEX_URL=http://your-plex-server:32400 \
  -e PLEX_TOKEN=your-plex-token \
  -e SONARR_URL=http://your-sonarr:8989 \
  -e SONARR_API_KEY=your-sonarr-api-key \
  -e RADARR_URL=http://your-radarr:7878 \
  -e RADARR_API_KEY=your-radarr-api-key \
  ghcr.io/mcgeaverbeaver/prunerr:main
```

For **Jellyfin** or **Emby**, swap the two Plex variables for:

```bash
  -e MEDIA_SERVER_TYPE=jellyfin \
  -e JELLYFIN_URL=http://your-server:8096 \
  -e JELLYFIN_API_KEY=your-api-key \
```

Use `MEDIA_SERVER_TYPE=emby` for Emby; both share the `JELLYFIN_*` variables. On Jellyfin, install the **Playback Reporting** plugin for full watch history; without it Jellyfin keeps only the most recent play per item.

Every other connection (Tautulli, Seerr, Unraid, Discord, media folders) is set up in the web UI. Login, roles and the AI connector are configured by environment variables; see [docs/authentication.md](docs/authentication.md) and [docs/mcp.md](docs/mcp.md).

| Platform | How |
|----------|-----|
| **Docker Compose** | [`docker-compose.yml`](docker-compose.yml) in this repository |
| **Unraid** | Add [`my-prunerr.xml`](my-prunerr.xml) as a template, or paste its raw URL into *Add Container* &rarr; *Template* |

### Image channels

The image is published to the GitHub Container Registry as [`ghcr.io/mcgeaverbeaver/prunerr`](https://github.com/McGeaverBeaver/prunerr/pkgs/container/prunerr), for amd64 and arm64.

| Tag | What it is |
|---|---|
| `:main` | The main branch, rebuilt on demand. Each build also publishes a pinned `:main-<sha>`. |
| `:beta` | The `beta` branch, rebuilt as changes land. Back up the database first; beta builds can carry schema migrations and downgrading is not supported. |
| `:1.x.x`, `:1.x`, `:1`, `:latest` | Tagged releases. |

### Upgrading from Prunerr

PrunerrXT is a drop-in replacement. The database file, the data directory, every environment variable and every setting key are unchanged, so point your existing container at the PrunerrXT image and start it; the migrations run on first start. The image, repository and container keep the `prunerr` name for the same reason.

## Integrations

| Service | Purpose | Required |
|---------|---------|----------|
| **Plex** / **Jellyfin** / **Emby** | Media server: library data, watch status | One required |
| **Sonarr** | TV show management, episode breakdown, release search for Archive | Recommended |
| **Radarr** | Movie management, collections, release search for Archive | Recommended |
| **Tautulli** / **Tracearr** | Per-user watch history and playback friction (Plex only) | Optional |
| **Seerr** | Request tracking and resets | Optional |
| **Unraid** | Array capacity and server monitoring | Optional |
| **Discord**, **webhooks**, **Home Assistant** | Notifications | Optional |
| **Authentik** or any OpenID Connect provider | Single sign-on and roles | Optional |
| **Claude**, **Cursor** or any MCP client | AI assistant | Optional |

## Mobile

PrunerrXT works as a custom web app in [nzb360](https://nzb360.com/) on Android, or in any mobile browser. The UI is fully responsive and installs as a web app.

## Documentation

Guides for what PrunerrXT adds live in this repository:

- [Archive](docs/archive.md) &mdash; Re-acquisition checks before deletion, holds, archived titles, pauses
- [Tasks and the audit log](docs/tasks-and-audit.md) &mdash; Background work with live progress; the tamper-evident record of who did what
- [Login and access](docs/authentication.md) &mdash; Single sign-on (Authentik/OIDC), roles, local account, sessions
- [AI assistant (MCP)](docs/mcp.md) &mdash; Connect Claude, Cursor and other MCP clients
- [Insights](docs/insights.md) &mdash; Stack health, library quality, watch patterns, playback friction
- [Watch state](docs/watch-state.md) &mdash; In-progress and finished detection per viewer, and the rule fields built on it
- [Unmanaged folders](docs/folders.md) &mdash; Folders Sonarr and Radarr do not own: import, delete, repair permissions
- [Home Assistant](docs/home-assistant.md) &mdash; Webhooks, signed payloads and sensors

For the features shared with the original, the [Prunerr wiki](https://github.com/helliott20/prunerr/wiki) remains the reference: [Installation](https://github.com/helliott20/prunerr/wiki/Installation), [Configuration](https://github.com/helliott20/prunerr/wiki/Configuration), [Rules Engine](https://github.com/helliott20/prunerr/wiki/Rules-Engine), [Collections](https://github.com/helliott20/prunerr/wiki/Collections), [Deletion Management](https://github.com/helliott20/prunerr/wiki/Deletion-Management), [API Reference](https://github.com/helliott20/prunerr/wiki/API-Reference), [Mobile Access](https://github.com/helliott20/prunerr/wiki/Mobile-Access) and [Troubleshooting](https://github.com/helliott20/prunerr/wiki/Troubleshooting).

## Privacy

PrunerrXT talks only to the services you configure: your media server, Sonarr, Radarr and the integrations you turn on in Settings. There is no telemetry, no update check, no remote feed and no third-party fonts or scripts. Nothing is sent anywhere, and nothing asks whether it may.

## Credits

PrunerrXT is an extended edition of **[Prunerr](https://github.com/helliott20/prunerr)**, created by **Harry Elliott ([@helliott20](https://github.com/helliott20))** and its contributors. The rules engine, the deletion queue and grace periods, collections, the dashboard, multi-server support, per-user watch history, the Sonarr episode breakdown, notifications, backups, the six translations and the design this edition builds on are their work, and their wiki is still the best introduction to those parts. Thank you.

PrunerrXT keeps Prunerr's MIT licence. The name marks a different direction (no outbound calls, login and roles, the Archive safety net, the audit log and the AI connector), not a different origin.

## Support

- **GitHub:** [McGeaverBeaver/prunerr](https://github.com/McGeaverBeaver/prunerr)
- **Container image:** [ghcr.io/mcgeaverbeaver/prunerr](https://github.com/McGeaverBeaver/prunerr/pkgs/container/prunerr)
- **Original project:** [helliott20/prunerr](https://github.com/helliott20/prunerr)

## License

MIT License. See [LICENSE](LICENSE).
