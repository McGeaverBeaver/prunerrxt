# Changelog

PrunerrXT uses [semantic versioning](https://semver.org). Every push to
`main` becomes a release: the patch number advances on its own, the section
below is written from the commits, the image is published as `:latest` and
`:<version>`, and a GitHub release carries the same notes. The major and
minor numbers are chosen by hand in `package.json`; see
[docs/versioning.md](docs/versioning.md).

## 2.0.0 (unreleased)

The first PrunerrXT release, an extended edition of Prunerr 1.8.2 by Harry
Elliott. Everything the original does is still here; on top of it:

- **Archive.** Before a queued title is deleted, Radarr or Sonarr is asked
  whether it could be downloaded again as good as the copy you have. At-risk
  titles are held for a decision or archived; checks pause while indexers
  are down or rate-limited and resume on their own.
- **Queue triage.** Replaceable and At Risk counts, the space at stake, and
  Protect At-Risk to archive every title you could not get back.
- **Protected page.** Every protected and archived title and protected
  collection in one place.
- **Audit log.** Append-only, hash-chained, verified daily, exportable.
- **Tasks page.** Live progress, every scheduled job, run history, Run now.
- **Login and roles.** Single sign-on through Authentik or any OpenID Connect
  provider, admin / operator / viewer roles, a local account, sessions.
- **AI assistant.** A Model Context Protocol server with OAuth 2.1, and a
  Connected clients card to see and disconnect every assistant.
- **Insights.** Stack health, library quality, watch patterns, playback
  friction, daily snapshots.
- **Watch state in rules.** In-progress, finished and completion fields per
  viewer.
- **Background deletions** with live status, reconciliation and slow-delete
  verification; **deletion diagnostics** from Sonarr's and Radarr's own logs.
- **Unmanaged folders** with import, delete, bulk jobs and permission repair.
- **Disk pressure** from the volumes Sonarr and Radarr report, limited to
  the mounts that hold a root folder.
- **Plex to Arr matching** by folder and title when ids disagree.
- **No outbound calls.** Telemetry, the remote announcements feed and
  third-party fonts are gone.
- **Node 24**, Tailwind CSS 4, and a clean dependency audit.
