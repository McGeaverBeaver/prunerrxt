import type Database from 'better-sqlite3';
import logger from '../utils/logger';

interface Migration {
  version: number;
  name: string;
  up: string;
}

const migrations: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    up: `
      -- Settings table for application configuration
      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL UNIQUE,
        value TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Profiles table for rule grouping
      CREATE TABLE IF NOT EXISTS profiles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        is_active INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Media items table for tracking all media
      CREATE TABLE IF NOT EXISTS media_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL CHECK (type IN ('movie', 'show', 'episode')),
        title TEXT NOT NULL,
        plex_id TEXT,
        sonarr_id INTEGER,
        radarr_id INTEGER,
        poster_url TEXT,
        file_path TEXT,
        file_size INTEGER,
        resolution TEXT,
        codec TEXT,
        added_at TEXT,
        last_watched_at TEXT,
        play_count INTEGER NOT NULL DEFAULT 0,
        watched_by TEXT,
        status TEXT NOT NULL DEFAULT 'monitored' CHECK (status IN ('monitored', 'flagged', 'pending_deletion', 'deleted', 'protected')),
        marked_at TEXT,
        delete_after TEXT,
        is_protected INTEGER NOT NULL DEFAULT 0,
        protection_reason TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Rules table for automation rules
      CREATE TABLE IF NOT EXISTS rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        profile_id INTEGER,
        type TEXT NOT NULL CHECK (type IN ('age', 'watch_status', 'size', 'quality', 'custom')),
        conditions TEXT NOT NULL DEFAULT '[]',
        action TEXT NOT NULL CHECK (action IN ('flag', 'delete', 'notify')),
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE SET NULL
      );

      -- Deletion history table for audit trail
      CREATE TABLE IF NOT EXISTS deletion_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        media_item_id INTEGER,
        title TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('movie', 'show', 'episode')),
        file_size INTEGER,
        deleted_at TEXT NOT NULL DEFAULT (datetime('now')),
        deletion_type TEXT NOT NULL CHECK (deletion_type IN ('automatic', 'manual')),
        deleted_by_rule_id INTEGER,
        FOREIGN KEY (media_item_id) REFERENCES media_items(id) ON DELETE SET NULL,
        FOREIGN KEY (deleted_by_rule_id) REFERENCES rules(id) ON DELETE SET NULL
      );

      -- Scan history table for tracking scans
      CREATE TABLE IF NOT EXISTS scan_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT,
        items_scanned INTEGER NOT NULL DEFAULT 0,
        items_flagged INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed'))
      );

      -- Create indexes for common queries
      CREATE INDEX IF NOT EXISTS idx_media_items_type ON media_items(type);
      CREATE INDEX IF NOT EXISTS idx_media_items_status ON media_items(status);
      CREATE INDEX IF NOT EXISTS idx_media_items_plex_id ON media_items(plex_id);
      CREATE INDEX IF NOT EXISTS idx_media_items_sonarr_id ON media_items(sonarr_id);
      CREATE INDEX IF NOT EXISTS idx_media_items_radarr_id ON media_items(radarr_id);
      CREATE INDEX IF NOT EXISTS idx_media_items_last_watched ON media_items(last_watched_at);
      CREATE INDEX IF NOT EXISTS idx_rules_profile_id ON rules(profile_id);
      CREATE INDEX IF NOT EXISTS idx_rules_enabled ON rules(enabled);
      CREATE INDEX IF NOT EXISTS idx_deletion_history_deleted_at ON deletion_history(deleted_at);
      CREATE INDEX IF NOT EXISTS idx_scan_history_started_at ON scan_history(started_at);
      CREATE INDEX IF NOT EXISTS idx_settings_key ON settings(key);

      -- Insert default profile
      INSERT OR IGNORE INTO profiles (name, is_active) VALUES ('Default', 1);
    `,
  },
  {
    version: 2,
    name: 'add_year_and_imdb',
    up: `
      -- Add year and IMDB ID columns to media_items
      ALTER TABLE media_items ADD COLUMN year INTEGER;
      ALTER TABLE media_items ADD COLUMN imdb_id TEXT;
      ALTER TABLE media_items ADD COLUMN tmdb_id INTEGER;
      ALTER TABLE media_items ADD COLUMN tvdb_id INTEGER;

      -- Create indexes for new columns
      CREATE INDEX IF NOT EXISTS idx_media_items_imdb_id ON media_items(imdb_id);
      CREATE INDEX IF NOT EXISTS idx_media_items_tmdb_id ON media_items(tmdb_id);
    `,
  },
  {
    version: 3,
    name: 'add_deletion_options',
    up: `
      -- Add deletion_action column to rules for specifying how to delete
      -- Options: unmonitor_only, delete_files, full_removal
      ALTER TABLE rules ADD COLUMN deletion_action TEXT DEFAULT 'delete_files';

      -- Add reset_overseerr flag to rules to control whether to reset in Overseerr
      ALTER TABLE rules ADD COLUMN reset_overseerr INTEGER DEFAULT 0;

      -- Add grace_period_days to rules for configurable grace periods per rule
      ALTER TABLE rules ADD COLUMN grace_period_days INTEGER DEFAULT 7;

      -- Add requested_by column to media_items to track who requested the content
      ALTER TABLE media_items ADD COLUMN requested_by TEXT;

      -- Add deletion_action column to media_items to track what action to take
      ALTER TABLE media_items ADD COLUMN deletion_action TEXT DEFAULT 'delete_files';

      -- Add reset_overseerr flag to media_items
      ALTER TABLE media_items ADD COLUMN reset_overseerr INTEGER DEFAULT 0;

      -- Add matched_rule_id to track which rule flagged the item
      ALTER TABLE media_items ADD COLUMN matched_rule_id INTEGER REFERENCES rules(id) ON DELETE SET NULL;

      -- Add overseerr_reset_at to track when the item was reset in Overseerr
      ALTER TABLE media_items ADD COLUMN overseerr_reset_at TEXT;

      -- Create index for matched_rule_id
      CREATE INDEX IF NOT EXISTS idx_media_items_matched_rule ON media_items(matched_rule_id);

      -- Add overseerr_reset column to deletion_history
      ALTER TABLE deletion_history ADD COLUMN overseerr_reset INTEGER DEFAULT 0;
    `,
  },
  {
    version: 4,
    name: 'ensure_deletion_columns',
    up: `
      -- Ensure overseerr_reset_at column exists (may have been missed in migration 3)
      -- SQLite doesn't support IF NOT EXISTS for ADD COLUMN, but will error if column exists
      -- Using a simple approach: try to select from the column, if it fails the column doesn't exist
      -- This migration uses a workaround by creating a new temp table

      -- For simplicity, we'll just try to add the column and catch the error in the migration runner
      -- This migration adds columns that might be missing
      ALTER TABLE media_items ADD COLUMN overseerr_reset_at TEXT;
    `,
  },
  {
    version: 5,
    name: 'add_rule_media_type',
    up: `
      -- Add media_type column to rules for filtering by media type
      -- Options: all, movie, show
      ALTER TABLE rules ADD COLUMN media_type TEXT DEFAULT 'all' CHECK (media_type IN ('all', 'movie', 'show'));
    `,
  },
  {
    version: 6,
    name: 'add_activity_log',
    up: `
      -- Activity log table for unified event tracking
      CREATE TABLE IF NOT EXISTS activity_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL CHECK (event_type IN ('scan', 'deletion', 'rule_match', 'protection', 'manual_action', 'error')),
        action TEXT NOT NULL,
        actor_type TEXT NOT NULL CHECK (actor_type IN ('scheduler', 'user', 'rule')),
        actor_id TEXT,
        actor_name TEXT,
        target_type TEXT,
        target_id INTEGER,
        target_title TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Indexes for efficient queries
      CREATE INDEX IF NOT EXISTS idx_activity_log_created_at ON activity_log(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_activity_log_event_type ON activity_log(event_type);
      CREATE INDEX IF NOT EXISTS idx_activity_log_actor_type ON activity_log(actor_type);
    `,
  },
  {
    version: 7,
    name: 'ensure_rule_media_type',
    up: `
      -- Ensure media_type column exists on rules table
      -- This is a defensive migration for databases where migration 5 may have been recorded but not applied
      ALTER TABLE rules ADD COLUMN media_type TEXT DEFAULT 'all' CHECK (media_type IN ('all', 'movie', 'show'));
    `,
  },
  {
    version: 8,
    name: 'add_storage_snapshots',
    up: `
      CREATE TABLE IF NOT EXISTS storage_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        total_size INTEGER NOT NULL DEFAULT 0,
        movie_size INTEGER NOT NULL DEFAULT 0,
        show_size INTEGER NOT NULL DEFAULT 0,
        item_count INTEGER NOT NULL DEFAULT 0,
        movie_count INTEGER NOT NULL DEFAULT 0,
        show_count INTEGER NOT NULL DEFAULT 0,
        space_reclaimed INTEGER NOT NULL DEFAULT 0,
        captured_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_storage_snapshots_captured_at ON storage_snapshots(captured_at);
    `,
  },
  {
    version: 9,
    name: 'add_library_key',
    up: `
      ALTER TABLE media_items ADD COLUMN library_key TEXT;
      CREATE INDEX IF NOT EXISTS idx_media_items_library_key ON media_items(library_key);
    `,
  },
  {
    version: 10,
    name: 'add_watch_history_cache',
    up: `
      CREATE TABLE IF NOT EXISTS watch_history_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plex_rating_key TEXT NOT NULL,
        username TEXT NOT NULL,
        watched INTEGER NOT NULL DEFAULT 0,
        stopped_at TEXT NOT NULL,
        session_id TEXT,
        media_title TEXT,
        media_type TEXT,
        show_title TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_watch_history_cache_rating_key ON watch_history_cache(plex_rating_key);
      CREATE INDEX IF NOT EXISTS idx_watch_history_cache_show_title ON watch_history_cache(show_title);
      CREATE INDEX IF NOT EXISTS idx_watch_history_cache_stopped_at ON watch_history_cache(stopped_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_watch_history_cache_session ON watch_history_cache(session_id);
    `,
  },
  {
    version: 11,
    name: 'add_activity_log_target_id_index',
    up: `
      CREATE INDEX IF NOT EXISTS idx_activity_log_target_id ON activity_log(target_id);
    `,
  },
  {
    version: 12,
    name: 'add_collections',
    up: `
      -- Collections table (Radarr-sourced TMDB movie franchises)
      CREATE TABLE IF NOT EXISTS collections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tmdb_id INTEGER UNIQUE,
        title TEXT NOT NULL,
        overview TEXT,
        poster_url TEXT,
        item_count INTEGER DEFAULT 0,
        is_protected INTEGER NOT NULL DEFAULT 0,
        protection_reason TEXT,
        protected_at TEXT,
        last_synced_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      -- Join table between collections and media items
      CREATE TABLE IF NOT EXISTS collection_items (
        collection_id INTEGER NOT NULL,
        media_item_id INTEGER NOT NULL,
        added_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (collection_id, media_item_id),
        FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE,
        FOREIGN KEY (media_item_id) REFERENCES media_items(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_collections_tmdb_id ON collections(tmdb_id);
      CREATE INDEX IF NOT EXISTS idx_collections_is_protected ON collections(is_protected);
      CREATE INDEX IF NOT EXISTS idx_collection_items_media_item ON collection_items(media_item_id);
    `,
  },
  {
    version: 13,
    name: 'expand_media_items_metadata',
    up: `
      -- Metadata enrichment columns for granular rule filtering.
      -- Each ALTER is idempotent via the "duplicate column" handling in the runner.
      ALTER TABLE media_items ADD COLUMN genres TEXT;
      ALTER TABLE media_items ADD COLUMN tags TEXT;
      ALTER TABLE media_items ADD COLUMN studio TEXT;
      ALTER TABLE media_items ADD COLUMN audio_codec TEXT;
      ALTER TABLE media_items ADD COLUMN video_codec TEXT;
      ALTER TABLE media_items ADD COLUMN hdr TEXT;
      ALTER TABLE media_items ADD COLUMN bitrate INTEGER;
      ALTER TABLE media_items ADD COLUMN runtime_minutes INTEGER;
      ALTER TABLE media_items ADD COLUMN season_count INTEGER;
      ALTER TABLE media_items ADD COLUMN episode_count INTEGER;
      ALTER TABLE media_items ADD COLUMN series_status TEXT;
      ALTER TABLE media_items ADD COLUMN rating_imdb REAL;
      ALTER TABLE media_items ADD COLUMN rating_tmdb REAL;
      ALTER TABLE media_items ADD COLUMN rating_rt REAL;
      ALTER TABLE media_items ADD COLUMN content_rating TEXT;
      ALTER TABLE media_items ADD COLUMN original_language TEXT;
    `,
  },
  {
    version: 14,
    name: 'add_plex_users',
    up: `
      CREATE TABLE IF NOT EXISTS plex_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plex_user_id TEXT UNIQUE NOT NULL,
        username TEXT NOT NULL,
        email TEXT,
        thumb_url TEXT,
        is_home_user INTEGER NOT NULL DEFAULT 0,
        is_owner INTEGER NOT NULL DEFAULT 0,
        last_synced_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_plex_users_username ON plex_users(username);
    `,
  },
  {
    version: 15,
    name: 'add_rule_priority',
    up: `
      ALTER TABLE rules ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX IF NOT EXISTS idx_rules_priority ON rules(priority DESC);
    `,
  },
  {
    version: 16,
    name: 'add_media_items_deleted_at',
    up: `
      -- Timestamp set when PrunerrXT deletes an item. The row is now kept as a
      -- "tombstone" instead of being hard-removed, so a later Plex sync can
      -- tell a stale leftover entry (added_at older than deleted_at) from a
      -- genuine re-add (added_at newer than deleted_at).
      ALTER TABLE media_items ADD COLUMN deleted_at TEXT;
    `,
  },
  {
    version: 17,
    name: 'add_unraid_capacity_snapshots',
    up: `
      CREATE TABLE IF NOT EXISTS unraid_capacity_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        total_bytes INTEGER NOT NULL,
        used_bytes INTEGER NOT NULL,
        free_bytes INTEGER NOT NULL,
        captured_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_unraid_capacity_snapshots_captured_at ON unraid_capacity_snapshots(captured_at);
    `,
  },
  {
    version: 18,
    name: 'backfill_stuck_pending_deletion',
    up: `
      -- Repair items stuck in 'pending_deletion' without the marked_at /
      -- delete_after timestamps the queue requires. These were counted by the
      -- dashboard "Reclaimable" card but hidden from the Queue page (which
      -- filters on delete_after), so the two disagreed. Backfill the timestamps
      -- from the best available time + the default 7-day grace period so the
      -- items become real, visible queue entries instead of silently dropping
      -- media the user intended to delete.
      UPDATE media_items
      SET marked_at = COALESCE(marked_at, updated_at, created_at, datetime('now'))
      WHERE status = 'pending_deletion' AND marked_at IS NULL;

      UPDATE media_items
      SET delete_after = datetime(
        COALESCE(marked_at, updated_at, created_at, datetime('now')),
        '+7 days'
      )
      WHERE status = 'pending_deletion' AND delete_after IS NULL;
    `,
  },
  {
    version: 19,
    name: 'add_rule_library_keys',
    up: `
      -- Optional per-rule Plex library targeting. Stores a JSON array of
      -- Plex library section keys (e.g. '["1","5"]'). NULL means the rule
      -- applies to every library (existing behaviour).
      ALTER TABLE rules ADD COLUMN library_keys TEXT;
    `,
  },
  {
    version: 20,
    name: 'add_episode_deletions',
    up: `
      -- Per-episode deletion queue. Shows live in media_items as a single row,
      -- so episode- and season-level deletions need their own queue. Rows are
      -- always per-episode: queueing a season expands into its episodes so a
      -- single episode can still be cancelled afterwards.
      CREATE TABLE IF NOT EXISTS episode_deletions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        media_item_id INTEGER NOT NULL,
        series_id INTEGER NOT NULL,
        season_number INTEGER NOT NULL,
        episode_number INTEGER NOT NULL,
        episode_id INTEGER NOT NULL,
        episode_file_id INTEGER,
        series_title TEXT NOT NULL,
        episode_title TEXT NOT NULL,
        file_size INTEGER NOT NULL DEFAULT 0,
        deletion_action TEXT NOT NULL DEFAULT 'unmonitor_and_delete',
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
        marked_at TEXT NOT NULL DEFAULT (datetime('now')),
        delete_after TEXT NOT NULL,
        completed_at TEXT,
        error TEXT,
        FOREIGN KEY (media_item_id) REFERENCES media_items(id) ON DELETE CASCADE
      );

      -- An episode can only sit in the queue once at a time.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_episode_deletions_pending
        ON episode_deletions(episode_id) WHERE status = 'pending';

      CREATE INDEX IF NOT EXISTS idx_episode_deletions_item
        ON episode_deletions(media_item_id, status);

      CREATE INDEX IF NOT EXISTS idx_episode_deletions_due
        ON episode_deletions(status, delete_after);
    `,
  },
  {
    version: 21,
    name: 'auth_sessions',
    up: `
      -- Browser login sessions (OIDC and local). Rows are the source of truth;
      -- the cookie only carries a signed session id.
      CREATE TABLE IF NOT EXISTS auth_sessions (
        id TEXT PRIMARY KEY,
        user_key TEXT NOT NULL,
        username TEXT NOT NULL,
        display_name TEXT,
        email TEXT,
        role TEXT NOT NULL,
        provider TEXT NOT NULL,
        groups TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at);
      CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_key);
    `,
  },
  {
    version: 22,
    name: 'remove_telemetry_settings',
    up: `
      -- PrunerrXT no longer contacts anything outside the instance. Drop the
      -- install ID and feed cache the old heartbeat and announcements kept.
      DELETE FROM settings WHERE key LIKE 'telemetry_%' OR key LIKE 'announcements_%';
    `,
  },
  {
    version: 23,
    name: 'oauth_server',
    up: `
      -- PrunerrXT as an OAuth 2.1 authorization server for MCP clients
      -- (claude.ai connectors, Claude Desktop, …). Secrets, codes and tokens
      -- are stored as SHA-256 hashes.
      CREATE TABLE IF NOT EXISTS oauth_clients (
        client_id TEXT PRIMARY KEY,
        client_secret_hash TEXT,
        client_name TEXT,
        redirect_uris TEXT NOT NULL,
        token_endpoint_auth_method TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS oauth_consents (
        user_key TEXT NOT NULL,
        client_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (user_key, client_id)
      );

      CREATE TABLE IF NOT EXISTS oauth_codes (
        code_hash TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        scope TEXT NOT NULL,
        user_key TEXT NOT NULL,
        username TEXT NOT NULL,
        role TEXT NOT NULL,
        resource TEXT,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS oauth_tokens (
        token_hash TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
        pair_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        user_key TEXT NOT NULL,
        username TEXT NOT NULL,
        role TEXT NOT NULL,
        scope TEXT NOT NULL,
        resource TEXT,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_oauth_tokens_pair ON oauth_tokens(pair_id);
      CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user ON oauth_tokens(user_key, client_id);
      CREATE INDEX IF NOT EXISTS idx_oauth_tokens_expires ON oauth_tokens(expires_at);
    `,
  },
  {
    version: 24,
    name: 'deletion_jobs',
    up: `
      -- Background deletions. Delete Now / Delete All create a row per item
      -- and return; a worker runs them, so the UI never waits on a slow
      -- Sonarr/Radarr file delete. Rows outlive restarts: anything still
      -- running when the process stopped is picked up again on boot.
      CREATE TABLE IF NOT EXISTS deletion_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        queue_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('media', 'episode')),
        media_item_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        media_type TEXT NOT NULL,
        service TEXT,
        file_size INTEGER NOT NULL DEFAULT 0,
        deletion_action TEXT NOT NULL,
        reset_overseerr INTEGER NOT NULL DEFAULT 0,
        rule_id INTEGER,
        batch_id TEXT,
        requested_by TEXT NOT NULL,
        deletion_type TEXT NOT NULL DEFAULT 'manual',
        status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'verifying', 'done', 'reconciled', 'failed', 'cancelled')),
        stage TEXT,
        step TEXT,
        message TEXT,
        step_started_at TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        upstream_status INTEGER,
        failed_step TEXT,
        failed_service TEXT,
        file_size_freed INTEGER,
        overseerr_reset INTEGER,
        step_durations TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        updated_at TEXT NOT NULL
      );

      -- One live job per queue entry: the per-item lock.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_deletion_jobs_active_queue
        ON deletion_jobs(queue_id) WHERE status IN ('pending', 'running', 'verifying');
      CREATE INDEX IF NOT EXISTS idx_deletion_jobs_status ON deletion_jobs(status);
      CREATE INDEX IF NOT EXISTS idx_deletion_jobs_batch ON deletion_jobs(batch_id);
    `,
  },
  {
    version: 25,
    name: 'deletion_jobs_upstream_log',
    up: `
      -- What Sonarr/Radarr logged about a failed deletion, captured when the
      -- job fails so the reason is on the job itself.
      ALTER TABLE deletion_jobs ADD COLUMN upstream_log TEXT;
    `,
  },
  {
    version: 26,
    name: 'folder_jobs',
    up: `
      -- Bulk work on unmanaged folders (delete, import, fix permissions),
      -- one row per folder, run in the background by services/folderJobs.ts.
      -- Rows outlive restarts the same way deletion_jobs do.
      CREATE TABLE IF NOT EXISTS folder_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_id TEXT NOT NULL,
        folder_id TEXT NOT NULL,
        service TEXT NOT NULL CHECK (service IN ('sonarr', 'radarr')),
        folder_name TEXT NOT NULL,
        folder_path TEXT NOT NULL,
        size_bytes INTEGER,
        action TEXT NOT NULL CHECK (action IN ('delete', 'import', 'fix_permissions')),
        params TEXT,
        requested_by TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'done', 'failed', 'cancelled')),
        message TEXT,
        error TEXT,
        result TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        updated_at TEXT NOT NULL
      );

      -- One live job per folder.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_folder_jobs_active_folder
        ON folder_jobs(folder_id) WHERE status IN ('pending', 'running');
      CREATE INDEX IF NOT EXISTS idx_folder_jobs_status ON folder_jobs(status);
      CREATE INDEX IF NOT EXISTS idx_folder_jobs_batch ON folder_jobs(batch_id);
    `,
  },
  {
    version: 27,
    name: 'api_key_usage',
    up: `
      -- One row per request that presented the API key (REST or MCP), so the
      -- Settings page can show whether and how the key is being used.
      -- services/apiKeyUsage.ts writes and prunes it.
      CREATE TABLE IF NOT EXISTS api_key_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        used_at TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'invalid', 'disabled')),
        source TEXT NOT NULL CHECK (source IN ('api', 'mcp')),
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        ip TEXT,
        user_agent TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_api_key_usage_used_at ON api_key_usage(used_at);
    `,
  },
  {
    version: 28,
    name: 'insight_snapshots',
    up: `
      -- One row a day of the Insights numbers, so the page and the MCP
      -- connector can show trends. services/insights/snapshots.ts writes it.
      CREATE TABLE IF NOT EXISTS insight_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        captured_at TEXT NOT NULL,
        stack_critical INTEGER NOT NULL DEFAULT 0,
        stack_warning INTEGER NOT NULL DEFAULT 0,
        library_items INTEGER NOT NULL DEFAULT 0,
        library_bytes INTEGER NOT NULL DEFAULT 0,
        sd_count INTEGER NOT NULL DEFAULT 0,
        low_quality_unwatched_bytes INTEGER NOT NULL DEFAULT 0,
        never_played_count INTEGER NOT NULL DEFAULT 0,
        never_played_bytes INTEGER NOT NULL DEFAULT 0,
        quiet_year_bytes INTEGER NOT NULL DEFAULT 0,
        plays_30 INTEGER NOT NULL DEFAULT 0,
        viewers_30 INTEGER NOT NULL DEFAULT 0,
        transcode_rate_30 REAL
      );
      CREATE INDEX IF NOT EXISTS idx_insight_snapshots_captured_at ON insight_snapshots(captured_at);
    `,
  },
  {
    version: 29,
    name: 'media_items_watch_state',
    up: `
      -- Per-viewer watch state computed at sync (services/watchState.ts):
      -- who is in progress, who finished, episodes watched. in_progress and
      -- watch_completion are denormalised for the rules engine and filters.
      ALTER TABLE media_items ADD COLUMN watch_state TEXT;
      ALTER TABLE media_items ADD COLUMN in_progress INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE media_items ADD COLUMN watch_completion REAL;
      CREATE INDEX IF NOT EXISTS idx_media_items_in_progress ON media_items(in_progress);
    `,
  },
  {
    version: 30,
    name: 'media_items_availability',
    up: `
      -- Archive (services/availability.ts): before a queued item is deleted,
      -- Radarr/Sonarr are asked whether it could be downloaded again.
      -- availability holds the verdict as JSON, availability_decision is set
      -- to 'delete' when a person chose to delete an at-risk item anyway, and
      -- archived_at marks an item protected because it is not replaceable.
      ALTER TABLE media_items ADD COLUMN availability TEXT;
      ALTER TABLE media_items ADD COLUMN availability_checked_at TEXT;
      ALTER TABLE media_items ADD COLUMN availability_decision TEXT;
      ALTER TABLE media_items ADD COLUMN archived_at TEXT;
    `,
  },
  {
    version: 31,
    name: 'media_items_protected_at',
    up: `
      -- When an item was protected, for the Protected page. Rows protected
      -- before this column existed take their last update as the best guess.
      ALTER TABLE media_items ADD COLUMN protected_at TEXT;
      UPDATE media_items SET protected_at = updated_at WHERE is_protected = 1 AND protected_at IS NULL;
    `,
  },
  {
    version: 32,
    name: 'task_runs_and_audit_log',
    up: `
      -- One row per background task run (scheduled, manual, start-up), for
      -- the Tasks page.
      CREATE TABLE IF NOT EXISTS task_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        trigger TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        duration_ms INTEGER,
        success INTEGER,
        message TEXT,
        error TEXT,
        data TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_task_runs_name ON task_runs(name, id);

      -- The audit log (services/audit.ts): append-only, each row HMAC-chained
      -- to the previous one. Nothing updates or deletes rows here.
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        actor_name TEXT NOT NULL,
        actor_id TEXT,
        actor_role TEXT,
        source TEXT NOT NULL,
        action TEXT NOT NULL,
        target_type TEXT,
        target_id TEXT,
        target_title TEXT,
        details TEXT,
        ip TEXT,
        prev_hash TEXT,
        hash TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action, id);
      CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor_name, id);
    `,
  },
  {
    version: 33,
    name: 'oauth_tokens_last_used',
    up: `
      -- When an OAuth access token was last presented at /mcp, so Settings can
      -- show which connected clients are actually in use.
      ALTER TABLE oauth_tokens ADD COLUMN last_used_at TEXT;
    `,
  },
];

// Schema version tracking table
const createMigrationsTable = `
  CREATE TABLE IF NOT EXISTS migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

export function runMigrations(db: Database.Database): void {
  // Create migrations tracking table
  db.exec(createMigrationsTable);

  // Get current schema version
  const getCurrentVersion = db.prepare<[], { max_version: number | null }>(
    'SELECT MAX(version) as max_version FROM migrations'
  );
  const result = getCurrentVersion.get();
  const currentVersion = result?.max_version ?? 0;

  logger.info(`Current database schema version: ${currentVersion}`);

  // Run pending migrations
  const pendingMigrations = migrations.filter((m) => m.version > currentVersion);

  if (pendingMigrations.length === 0) {
    logger.info('Database schema is up to date');
    return;
  }

  logger.info(`Running ${pendingMigrations.length} pending migration(s)...`);

  const insertMigration = db.prepare<[number, string]>(
    'INSERT INTO migrations (version, name) VALUES (?, ?)'
  );

  for (const migration of pendingMigrations) {
    logger.info(`Running migration ${migration.version}: ${migration.name}`);

    try {
      db.exec(migration.up);
      insertMigration.run(migration.version, migration.name);
      logger.info(`Migration ${migration.version} completed successfully`);
    } catch (error) {
      // Handle "duplicate column" errors gracefully - column already exists
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('duplicate column name')) {
        logger.info(`Migration ${migration.version}: Column already exists, marking as complete`);
        insertMigration.run(migration.version, migration.name);
      } else {
        logger.error(`Migration ${migration.version} failed:`, error);
        throw error;
      }
    }
  }

  logger.info('All migrations completed successfully');
}

export { migrations };
