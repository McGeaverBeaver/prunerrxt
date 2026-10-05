# Tasks and the audit log

Two pages for the question "what is PrunerrXT doing, and who did what".

## Tasks

The **Tasks** page in the sidebar has three parts.

**Running now.** The Archive availability pass with the title being searched,
how many are done out of how many, and the verdict tally so far; a library
sync and its latest progress line; deletion and folder jobs in flight; any
scheduled job mid-run. When an app is paused (indexers down, rate-limited,
unreachable) the pause and its retry time are listed under the running work.

**Scheduled.** Every background job with its cron schedule, whether it is on,
its last run with outcome and duration, and its next run. Jobs that only read
or compute (library sync, rules scan, Archive check, snapshots, users sync,
disk-pressure monitor, reminders, audit verification) have a **Run now**
button. The queue run is deliberately not runnable from here; it deletes
things, and the Queue page's Process Queue is the place for that.

**Recent runs.** The last sixty runs of anything, newest first, each with how
it was started (scheduled, manual, start-up, after queueing, MCP), its
duration and its message or error. A run cut off by a restart is marked as
interrupted. The table keeps the last two thousand runs.

The MCP tool `get_task_status` returns the same running and recent data;
`list_scheduled_tasks` returns the schedules.

## Audit log

The **Audit** page lists who changed what, when and from where. It is
separate from the Activity page: Activity is the operational narrative
(scans, matches, jobs), the audit log is the record of decisions and access,
and unlike Activity it cannot be edited or trimmed.

### What is recorded

| Group | Entries |
|---|---|
| `auth.` | sign-ins, sign-outs, failed sign-ins, sign-ins refused for having no mapped role, sessions signed out by an admin |
| `settings.` | every settings save, with each changed key's old and new value (credentials, tokens and webhook URLs are replaced by `[redacted]`) |
| `apiKey.` | the API key enabled, disabled or regenerated |
| `rule.` | rules created, updated, deleted, enabled, disabled |
| `queue.` | titles queued for deletion (with the grace period and action) and removed from the queue |
| `item.` | every completed deletion (with bytes freed, the action and the rule), protect, unprotect, archive, unarchive, and "delete anyway" decisions |
| `collection.` | collection protection on or off |
| `folder.` | unmanaged folders deleted |
| `mcp.` | every MCP tool call that changes something, with its arguments |
| `task.` | tasks started by hand from the Tasks page |
| `audit.` | the log being verified or exported |
| `system.` | PrunerrXT starting |

Each entry carries the actor (a signed-in user with their role, the API key,
the MCP assistant, the scheduler, a rule or PrunerrXT itself), the source (web,
API, MCP, scheduler, system), the client address when there was a request,
the target, and details.

### How tampering is detected

Every entry stores an HMAC-SHA256 over its own content and the previous
entry's hash, so the table is a chain. Alter any row and its hash no longer
matches; delete one and the next row's link breaks. There is no route, tool
or retention job that updates or deletes audit rows.

The key is `AUDIT_SECRET` from the environment. Without it, a random secret
is created once in `audit.secret` beside the database (mode 600). Someone
with a copy of the database but not the secret cannot rewrite history and
produce a chain that verifies. Back the secret up with the data directory:
losing it does not lose the log, but older entries can no longer be
verified.

After every entry the newest hash is written to `audit.anchor.json` beside
the database. A chain rebuilt from scratch does not match the anchor.

**Verify chain** on the Audit page, the MCP tool `verify_audit_log`, and the
daily `verifyAuditLog` task (04:30) all walk the whole chain and report the
first broken entry. A break is a critical finding in stack health on the
Insights page and goes out through the configured notification channels as
`AUDIT_LOG_BROKEN`.

What this does not promise: nothing stored on the same machine is safe from
someone with root on it and the secret. The log makes tampering detectable
and, without the secret, unforgeable. For more, export it regularly
(**Export**, admin only, JSON Lines) to a place that machine cannot reach.

### Access

Anyone signed in can read the log. Export and session management are admin
only. With login disabled, entries are attributed to "anonymous (login off)".

## Users and sessions

Settings → System → **Users & sessions** lists everyone signed in right now
with their role, provider, groups, sign-in time and last activity, and can
sign any session out. Roles are not edited here: they come from the identity
provider's groups or the `AUTH_*` variables, and every login is in the audit
log.
