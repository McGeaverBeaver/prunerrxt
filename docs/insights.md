# Insights

The **Insights** page reads the services you already connected and answers
four questions. Nothing is sent anywhere; every number comes from the media
server, Sonarr, Radarr, the watch history provider and Prunerr's own
database. The same reports are available to an assistant through the MCP
connector (`get_insights`, `get_insight_trends`).

## Stack health

One list of everything that is wrong, or worth knowing, across the stack,
worst first, each with a next step:

- **Sonarr and Radarr's own health checks** (indexer down, download client
  unreachable, root folder missing, update available), their queue (downloads
  stuck with errors never import, which leaves a gap after Prunerr deletes
  the old file), inaccessible root folders, and a recycle bin on another
  filesystem.
- **Connectivity** of every configured service, from the dashboard's health
  check.
- **Prunerr itself**: a failed or stale library sync, a failed scan, deletion
  jobs stuck or failed in the last week, queued items past their grace
  period with automatic processing off, a folder mapping that points nowhere
  or sits on a read-only volume, missing permission capabilities, disk
  pressure, a watch history provider that is selected but not configured or
  has gone quiet, login switched off, and requests with a wrong or disabled
  API key.

The report is cached for a minute. *Refresh* re-queries the apps.

**Acknowledging.** A finding that is true but accepted (Sonarr's "Allowed
Hosts is not configured" on a LAN-only install, a recycle bin kept on another
filesystem on purpose) can be acknowledged with the tick beside it. It then
leaves the counts and the list; *Show N acknowledged* lists them with an undo.
An acknowledgement is taken at the finding's current severity, so one that
later escalates (warning to critical) comes back on its own. Operators and
admins can acknowledge; the choice is stored on the server and applies to the
MCP connector's reports too (`acknowledge_insight`, with `undo` to reverse).

## Library quality

What the library is made of: the resolution mix by titles and by disk space,
the video codec mix (HEVC and AV1 are smaller but transcode for older
clients), HDR titles, the average bitrate per resolution, how many movies
and episodes sit below their quality cutoff in Radarr and Sonarr, and the
low-resolution titles nobody has played, which are the clearest deletion
candidates in the library. Resolution and codec come from the last library
sync; a title with none recorded has not been analysed by the media server.

## Watch patterns

Plays per week for the last 12 weeks, plays and viewers in the last 30 days
against the month before, who watches, the most played shows and movies,
and the part of the library that has never been played or has had no play
in a year, with its size. These are the numbers the rules engine works from,
shown so a "not watched in a year" rule can be judged before it runs.

Sessions come from Tautulli when it is the watch history provider, or from
the history Prunerr caches for Tracearr and for the media server's own
history. Per-title play counts come from the sync whichever provider is in
use.

## Playback friction

Only Tautulli records the transcode decision, the player and how far a
viewer got, so this block needs Tautulli as the watch history provider and
says so otherwise. From its sessions over the last 30 days: the share of
direct play, direct stream and transcode; the clients with the highest
transcode rate and the codecs they choke on; the titles that transcode most;
and plays dropped in the first fifth, with how many were tried again within
a day (the shape of a playback problem rather than a change of mind).

Buffering counts and client errors are not persisted anywhere Prunerr can
read, so this is inference about friction, not a count of failures.

## Trends

A scheduled task (`captureInsightSnapshot`, daily at 03:50 after the scan)
stores one row of the headline numbers: stack problems, library size and SD
count, never-played share, plays and viewers over the trailing 30 days, and
the transcode rate. Rows are kept for a year and served at
`GET /api/insights/history?days=90` and through `get_insight_trends`.

## API

| Endpoint | Returns |
|---|---|
| `GET /api/insights/stack?refresh=true` | Stack health |
| `GET /api/insights/library` | Library quality |
| `GET /api/insights/watching` | Watch patterns |
| `GET /api/insights/playback` | Playback friction |
| `GET /api/insights/history?days=90` | Daily snapshots |

All are readable by every role, like the dashboard.
