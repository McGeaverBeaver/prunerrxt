# Watch state

Every library sync already records, per title, how many times it was played,
when it was last played and by whom. **Watch state** adds what those plays
amount to per viewer, so a rule can tell "someone is halfway through season
three" from "everyone finished it a year ago" before it deletes anything.

For each movie and show the sync stores:

| Field | Meaning |
|---|---|
| `startedBy` | viewers with at least one play |
| `completedBy` | viewers who finished it: a movie when a play reached the provider's watched threshold, a show when they have watched every episode the library holds |
| `inProgressUsers` | viewers who started, have not finished, and played it within the in-progress window |
| `lastPlayedByUser` | the latest play per viewer |
| `episodesWatched` / `episodesTotal` | distinct episodes finished by anyone, over the episodes the library holds (shows only) |
| `completion` | 0..1: a movie is 0 or 1; a show is `episodesWatched / episodesTotal` |

The in-progress window is 30 days by default (`watch_state_in_progress_days`
in the settings table).

## Rule conditions

| Field | Type | Use |
|---|---|---|
| `in_progress` | boolean | `equals false` keeps a rule off anything someone is watching |
| `fully_watched` | boolean | true when every viewer who started it finished it (and, for a show, every episode has been seen) |
| `watch_completion` | number, 0–100 | share of a show that has been watched by anyone |
| `in_progress_by` | user list | the usual user operators (`equals`, `in`, `is_empty`, …) against the in-progress viewers |
| `completed_by` | user list | the same, against the viewers who finished it |

A typical finished-shows rule: media type *show*, `fully_watched equals true`,
`days_since_watched greater_than 30`. A guard for any rule: `in_progress
equals false`.

The rule suggestions on the Rules page include **Finished shows** when the
library has any.

## What each provider can see

| Provider | Movies in progress | Shows in progress | Finished |
|---|---|---|---|
| Tautulli | yes, from partial plays | yes | yes |
| Tracearr | yes, where it reports a session as not watched | yes | yes |
| Plex direct | no: Plex's own history only records plays that reached the watched threshold | yes, as long as episodes remain and someone played one recently | yes |
| Jellyfin / Emby direct | no, unless the Playback Reporting plugin is installed | yes | yes |

Stack health on the Insights page says so when the selected provider cannot
see partial plays and an enabled rule uses one of the fields above.

## Where it shows

- The library card carries an **In progress** badge; the item page lists who
  is in progress, who finished, and episodes watched.
- The Library's status filter has **In progress**.
- `search_library` and `get_media_item` on the MCP connector return
  `inProgress`, `watchCompletion` and, for one item, the whole watch state.
