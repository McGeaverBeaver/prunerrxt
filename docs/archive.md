# Archive

Deleting a title you can get back in ten minutes is cheap. Deleting the only
good copy of a 1998 film that no indexer carries any more is not. **Archive**
tells the two apart before anything goes: when a movie or show is queued for
deletion, Prunerr asks Radarr or Sonarr what the indexers can offer for it
right now and compares that with the file on disk.

Nothing is zipped, moved or copied. An archived title stays exactly where it
is, playable in Plex, and is simply protected for good.

## The verdict

Every queued movie or show gets one of three verdicts during its grace period:

| Verdict | Meaning |
|---|---|
| **Replaceable** | At least one release as good as your file is on offer, and it would actually download (usenet, or torrents with enough seeders). |
| **At risk** | Nothing is on offer, or what is on offer is a downgrade, or it hangs on a few seeders. |
| **Unknown** | The question could not be answered: the title is not linked to Radarr/Sonarr, every indexer is failing, or the search itself failed. |

The reasons behind an at-risk verdict:

| Reason | What it means |
|---|---|
| `no_releases` | No enabled indexer returned a release. |
| `downgrade` | The best release is a lower resolution than your file (say 1080p on offer, 2160p on disk). |
| `smaller` | Same resolution, but every release is under half the size of your file, which usually means a worse encode. |
| `low_seeders` | Only torrents, and the best of them has fewer seeders than the floor in Settings (default 5). Usenet releases need no seeders. |
| `missing_seasons` | For a show: at least one of the seasons checked has no season pack on offer. |

For movies the check is one interactive search, the same one Radarr's own
*Interactive Search* button runs, plus a look at the movie file Radarr holds
for the resolution and size to compare against. For shows it searches season
packs for up to three seasons that have files (the first, the middle and the
last), since a show with twelve seasons would otherwise mean twelve searches.

The title's age is not part of the verdict. A 1950s classic that every tracker
carries is replaceable; a 2019 release with one dead torrent is not, and only
the live search can tell which is which.

## What happens to an at-risk title

**When an item is at risk** in Settings → Safety → Archive decides:

- **Hold and ask** (default). The item stays in the queue but automatic
  processing, Process Queue and Delete All all skip it. The Queue page shows
  it as *Held* with the reason, and two choices: **Archive** or **Delete
  anyway**. Delete Now on a single item still works; that is an explicit
  decision.
- **Archive automatically.** The moment the check comes back at risk, the item
  is archived: protected for good and taken out of the queue. The hands-off
  setting for an install nobody reviews.
- **Delete anyway.** The verdict is recorded and shown, nothing is held.

Unknown verdicts are held too in *Hold and ask* mode: an item that could not
be checked is treated as at risk until someone looks. In both *Hold and ask*
and *Archive automatically* an item that has no verdict yet is held as well,
so an outage never turns into a deletion on a guess.

## Archived titles

An archived title is a protected title with an archive mark. Every rule, scan,
bulk action and the MCP connector already leave protected titles alone, so
nothing new has to learn about it. The **Protected** page in the sidebar lists
every archived title under its own tab, with the verdict that led there, the
date, a re-check button and Unarchive; the Library's status filter has
*Protected* and *Archived* entries too. The detail page shows the same badge
and **Unarchive** on its page lifts the protection again.

You can archive any title from its page, queued or not, when you simply know
it is hard to find again.

## When the check runs

- A few seconds after items are queued, by a rule or by hand, in the
  background.
- Every 15 minutes, for queued items that still have no verdict (and to probe
  a paused app).
- Right before the nightly queue run, so a hold is in place before anything
  would be deleted.
- A verdict older than the re-check window (default 7 days) is asked again
  before the queue acts on it.
- Any time from the Queue page (*Re-check*) or the item's page (*Check now*).

Searches run one at a time with a short pause between them, and one background
pass covers at most forty items, so a rule that queues a whole library does not
hammer your indexers. Each interactive search can take up to a minute or two.

## When the indexers are down

An outage pauses the checks; it never produces a verdict. Before a pass
touches Radarr or Sonarr it reads that app's indexer status (the same list the
app shows under *System → Status*). When every enabled indexer is backed off,
or the app cannot be reached, or a search fails or comes back rate-limited
(HTTP 429), that app is **paused**:

- its queued items are left without a verdict, which the queue treats as held;
- the pass carries on with the other app, if it has items;
- the pause lasts until the earliest indexer may retry, the `Retry-After` the
  app sent, or a back-off of 5, 15, 30 then 60 minutes for repeated failures.

Every 15 minutes the scheduled check probes a paused app's indexer status
again and resumes the moment it answers. The Queue page shows a *Archive
checks paused* banner with the reason and the retry time, stack health on the
Insights page carries a warning, and `list_queue` reports it under
`summary.archive`. *Re-check* and *Check now* on a single item still try even
while paused, so you can test whether things are back.

A verdict is only ever stored when a search actually answered. The one
exception is an app with no enabled indexer at all, which is recorded as
*unknown* (`no_indexers`) since nothing will change until one is added.

## Settings

| Setting | Default | Effect |
|---|---|---|
| Check before deleting | on | Turn Archive off to delete without asking. |
| When an item is at risk | Hold and ask | See above. |
| Minimum seeders | 5 | The seeder floor for torrent-only titles. |
| Re-check after (days) | 7 | How old a verdict may be before it is asked again. |

Archive needs Sonarr or Radarr; without them every verdict is *unknown*.

## MCP connector

| Tool | What it does |
|---|---|
| `check_availability` | Run the check now for up to ten items and return the verdicts. |
| `archive_items` | Archive items (keep for good); resolves a hold. |
| `unarchive_items` | Lift the archive mark and its protection. |
| `clear_availability_hold` | Record "delete anyway" for held items. |

`list_queue` carries each item's verdict and `held` flag, and `get_media_item`
returns the full report under `archive`.

## Activity log

Archive writes `availability_hold`, `archived`, `unarchived` and
`availability_overridden` entries under the *protection* event type, so the
item's timeline shows why it was held and who decided what.
