# AI assistant connector (MCP)

Prunerr speaks the [Model Context Protocol](https://modelcontextprotocol.io), so
an AI assistant — Claude, Cursor, Windsurf, VS Code Copilot, anything that can
talk to an MCP server — can look at your library, review the deletion queue,
build and test rules, and queue cleanups with you, using the same logic the
web UI uses.

The connector lives at **`/mcp`** on the Prunerr port and uses the Streamable
HTTP transport. Nothing else to install or run.

## Turning it on

Three switches, all of which must agree:

| Switch | Where | Default |
|---|---|---|
| Login enabled | `AUTH_ENABLED=true` in the container environment ([authentication](authentication.md)) | off |
| Container switch | `MCP_ENABLED` environment variable | on |
| In-app switch | **Settings → System → AI assistant (MCP)** | on |

The connector is deliberately **off while login is disabled**. An install with
no login is open to anyone who can reach its address; putting an AI connector
on top of that is one exposure too many. Enable a login first — single sign-on
through Authentik or another OpenID Connect provider, or a local account.

### Immediate deletion is a separate opt-in

Everything an assistant does goes through Prunerr's normal safety model:
items are *queued* with a grace period, protected items can never be queued,
and anything in the queue can be taken back out. Two things bypass that —
"delete now" and processing the queue for real — and those are **refused by
default**. Turn on **Allow immediate deletion** in the same Settings card if
you want an assistant to be able to do them. Dry runs of the queue always
work.

## Connecting a client

There are two ways to authenticate, depending on the client.

### Hosted clients: sign in with OAuth (claude.ai, Claude Desktop connectors)

Clients that cannot send a custom header use the MCP OAuth flow, which
Prunerr serves itself. Add the endpoint as a custom connector:

```
https://prunerr.example.com/mcp
```

The client registers itself automatically, sends you to Prunerr to sign in
(through Authentik, or the local account), and shows a one-time **Allow**
page. From then on it acts with **your** account and **your role**: a viewer
gets read-only tools, an operator can queue and manage, an admin can also use
the system tools. Approvals are remembered per client; tokens last an hour
and refresh for 30 days.

For this to work Prunerr must know its public address. Behind a reverse proxy
either pass `X-Forwarded-Proto` and `X-Forwarded-Host`, or set
`APP_URL=https://prunerr.example.com` — the OAuth issuer and redirect targets
are built from it, and a mismatch shows up as *Couldn't register* or
*invalid redirect* in the client.

Endpoints, for the curious: `/.well-known/oauth-protected-resource`,
`/.well-known/oauth-authorization-server`, `/oauth/register`,
`/oauth/authorize`, `/oauth/token`, `/oauth/revoke`. Authorization code with
PKCE (S256) only; public clients are accepted; tokens are stored hashed.

### Local clients: the API key

Clients you run yourself can send your Prunerr API key (Settings → System →
API key) as either header and act as an admin:

```
Authorization: Bearer <api-key>
X-Api-Key: <api-key>
```

The Settings card shows these snippets with your real endpoint, and fills in
the key when you click **Reveal key**.

**Claude Code**

```bash
claude mcp add --transport http prunerr http://prunerr.local:3000/mcp \
  --header "Authorization: Bearer <api-key>"
```

**Cursor, Windsurf, VS Code and other clients that speak HTTP** (`mcp.json`):

```json
{
  "mcpServers": {
    "prunerr": {
      "url": "http://prunerr.local:3000/mcp",
      "headers": { "Authorization": "Bearer <api-key>" }
    }
  }
}
```

**Claude Desktop** only launches local commands, so bridge it with
[`mcp-remote`](https://www.npmjs.com/package/mcp-remote) (needs Node.js on that
machine) in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "prunerr": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://prunerr.local:3000/mcp",
               "--header", "Authorization: Bearer <api-key>"]
    }
  }
}
```

If Prunerr sits behind a reverse proxy, point the client at the public URL
and make sure the proxy passes `Authorization`, `Mcp-Session-Id` and
`Accept: text/event-stream` through unbuffered.

## What the assistant can do

Every tool is annotated so clients can tell read-only from destructive. The
server's instructions tell the assistant to start with `get_overview`, to
preview before changing anything, and to confirm with you before queueing
more than a handful of items.

**Overview** — `get_overview`, `get_system_health`, `get_insights`, `acknowledge_insight`, `get_insight_trends`, `get_storage_history`,
`get_recommendations`

**Library** — `search_library` (title, type, status, watched, staleness, size,
protection, requester; sorted and paged), `get_media_item`,
`get_show_episodes` (Sonarr season/episode breakdown), `list_requesters`,
`list_libraries`

**Item actions** — `queue_for_deletion` (grace period applies; protected items
skipped), `protect_items`, `unprotect_items`, `queue_episodes_for_deletion`,
`cancel_episode_deletions`, `get_deletion_defaults`

**Archive** — `check_availability` (can it be downloaded again?),
`archive_items` (keep for good; `allAtRisk: true` archives every at-risk queued title), `unarchive_items`, `clear_availability_hold`
(delete an at-risk item anyway). `list_queue` carries each item's verdict and
whether Archive is holding it. See docs/archive.md.

**Unmanaged folders** — `list_orphan_folders`, `lookup_orphan_folder`,
`import_orphan_folder`, `delete_orphan_folder` (needs the opt-in),
`ignore_orphan_folder`: folders under Sonarr's and Radarr's root folders that
no title owns, imported into the right app or cleaned up. See docs/folders.md.

**Tasks and audit** — `get_task_status` (what is running, recent runs),
`list_audit_log` (who did what, hash-chained), `verify_audit_log`. See
docs/tasks-and-audit.md.

**Troubleshooting** — `get_service_logs`, `get_service_health`,
`get_service_activity`, `get_deletion_setup` read Sonarr's and Radarr's own
logs, health checks, command queue and recycling-bin/root-folder setup, so a
slow or failed deletion can be explained without leaving the chat. A failed
deletion job also carries the matching log lines from the service.

**Deletion queue** — `list_queue`, `remove_from_queue`, `process_queue`
(dry run by default), `delete_now` (needs the opt-in), `list_deletion_jobs`.
Real deletions run as background jobs: `delete_now` and a real `process_queue`
return at once with the job(s), and `list_deletion_jobs` reports their step,
elapsed time and outcome. Sonarr/Radarr can take minutes to delete a large
file on network storage, so a job may sit in *verifying* for a while before
it ends as *done*.

**Rules** — `list_rules`, `get_rule`, `describe_rule_fields` (every field,
operator and example in the exact JSON shape), `preview_rule`, `create_rule`,
`update_rule`, `set_rule_enabled`, `delete_rule`, `run_rule`,
`get_rule_suggestions`, `list_profiles`, `activate_profile`

**Collections** — `list_collections`, `get_collection`, `sync_collections`,
`set_collection_protection`, `queue_collection_for_deletion`

**Scans & sync** — `trigger_scan`, `get_scan_status`, `list_scan_history`,
`sync_library`, `get_sync_status`, `list_scheduled_tasks`

**History & users** — `list_deletion_history`, `list_activity`,
`get_item_activity`, `list_users`, `sync_users`

**System** — `get_settings_summary` (URLs and switches only, never
credentials), `test_connection`

Resources (`prunerr://overview`, `prunerr://queue`, `prunerr://rules`,
`prunerr://rules/schema`, `prunerr://collections`, `prunerr://tools`,
`prunerr://media/{id}`) mirror the read tools for clients that prefer to pull
documents into context, and four prompts (`review_queue`, `reclaim_space`,
`build_rule`, `health_check`) lay out the safe order of operations for the
common jobs.

Actions taken through the connector appear in the Activity log attributed to
**MCP assistant**.

## Things to try

- *"What's taking up the most space that nobody has watched this year?"*
- *"Review my deletion queue and tell me if anything looks like a mistake."*
- *"Build a rule that deletes 4K movies over 30 GB that were watched once more than six months ago, and show me what it would catch before saving it."*
- *"Protect everything in the Studio Ghibli collection."*
- *"Is Sonarr reachable? When did the last scan run?"*

## Troubleshooting

| Symptom | Cause |
|---|---|
| `403 … off because login is disabled` | `AUTH_ENABLED` is not `true`. |
| `403 … disabled by MCP_ENABLED=false` | The container switch. |
| `403 … turned off in Settings` | The in-app toggle. |
| `401 Authentication required` | No `Authorization`/`X-Api-Key` header reached Prunerr (check the proxy). |
| `401 Invalid API key` | Wrong or regenerated key. |
| `401 API key access is turned off` | *External API access* is off under Settings → System → API key. Turn it on, or sign in through OAuth. |
| `delete_now` returns *Immediate deletion is not allowed* | Expected. Turn on **Allow immediate deletion** or queue instead. |
| Client says the session was not found | Sessions end after 30 idle minutes; the client reconnects on its own. |
