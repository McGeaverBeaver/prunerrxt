/**
 * A reference an assistant can read before writing a rule: the fields the
 * engine resolves, the operators it understands, and the exact JSON shape a
 * v2 condition tree takes. Served as the `prunerr://rules/schema` resource and
 * by the `describe_rule_fields` tool.
 */

export interface RuleFieldDoc {
  field: string;
  type: 'number' | 'string' | 'boolean' | 'string[]' | 'special';
  description: string;
  operators: string[];
  example?: Record<string, unknown>;
}

const NUMBER_OPS = ['equals', 'not_equals', 'greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal', 'between', 'in', 'not_in', 'is_null', 'is_not_null'];
const STRING_OPS = ['equals', 'not_equals', 'contains', 'not_contains', 'starts_with', 'ends_with', 'regex_match', 'in', 'not_in', 'is_empty', 'is_not_empty'];
const LIST_OPS = ['contains', 'not_contains', 'contains_any', 'contains_all', 'matches_any', 'matches_all', 'is_empty', 'is_not_empty'];
const BOOL_OPS = ['equals', 'not_equals'];

export const RULE_FIELDS: RuleFieldDoc[] = [
  { field: 'days_since_watched', type: 'number', description: 'Days since anyone last watched the item. null when never watched (use never_watched for that).', operators: NUMBER_OPS, example: { field: 'days_since_watched', operator: 'greater_than', value: 180 } },
  { field: 'days_since_added', type: 'number', description: 'Days since the item was added to the media server.', operators: NUMBER_OPS, example: { field: 'days_since_added', operator: 'greater_than', value: 30 } },
  { field: 'never_watched', type: 'boolean', description: 'true when play_count is 0.', operators: BOOL_OPS, example: { field: 'never_watched', operator: 'equals', value: true } },
  { field: 'play_count', type: 'number', description: 'Total plays across all users.', operators: NUMBER_OPS },
  { field: 'watched_by_count', type: 'number', description: 'How many distinct users have watched it.', operators: NUMBER_OPS },
  { field: 'size_gb', type: 'number', description: 'File size in gigabytes (GiB).', operators: NUMBER_OPS, example: { field: 'size_gb', operator: 'greater_than', value: 20 } },
  { field: 'file_size', type: 'number', description: 'File size in bytes. Prefer size_gb.', operators: NUMBER_OPS },
  { field: 'resolution_number', type: 'number', description: 'Vertical resolution: 480, 576, 720, 1080, 2160 (4K).', operators: NUMBER_OPS, example: { field: 'resolution_number', operator: 'less_than', value: 1080 } },
  { field: 'resolution', type: 'string', description: 'Raw resolution label, e.g. "1080p", "4K".', operators: STRING_OPS },
  { field: 'year', type: 'number', description: 'Release year.', operators: NUMBER_OPS },
  { field: 'rating_imdb', type: 'number', description: 'IMDb rating, 0-10.', operators: NUMBER_OPS },
  { field: 'rating_tmdb', type: 'number', description: 'TMDB rating, 0-10.', operators: NUMBER_OPS },
  { field: 'rating_rt', type: 'number', description: 'Rotten Tomatoes score, 0-100.', operators: NUMBER_OPS },
  { field: 'runtime_minutes', type: 'number', description: 'Runtime in minutes.', operators: NUMBER_OPS },
  { field: 'bitrate', type: 'number', description: 'Video bitrate in kbps.', operators: NUMBER_OPS },
  { field: 'season_count', type: 'number', description: 'Seasons (shows only).', operators: NUMBER_OPS },
  { field: 'episode_count', type: 'number', description: 'Episodes (shows only).', operators: NUMBER_OPS },
  { field: 'type', type: 'string', description: '"movie" or "show". Usually set via the rule\'s mediaType instead.', operators: ['equals', 'not_equals'] },
  { field: 'title', type: 'string', description: 'Item title.', operators: STRING_OPS },
  { field: 'codec', type: 'string', description: 'Video codec label, e.g. "h264", "hevc".', operators: STRING_OPS, example: { field: 'codec', operator: 'contains', value: 'h264' } },
  { field: 'video_codec', type: 'string', description: 'Video codec from the media server.', operators: STRING_OPS },
  { field: 'audio_codec', type: 'string', description: 'Audio codec.', operators: STRING_OPS },
  { field: 'hdr', type: 'string', description: 'HDR format label (e.g. "HDR10", "Dolby Vision"), empty for SDR.', operators: STRING_OPS },
  { field: 'studio', type: 'string', description: 'Studio or network.', operators: STRING_OPS },
  { field: 'content_rating', type: 'string', description: 'Content rating such as "PG-13", "TV-MA".', operators: STRING_OPS },
  { field: 'original_language', type: 'string', description: 'ISO language code of the original audio.', operators: STRING_OPS },
  { field: 'series_status', type: 'string', description: '"continuing", "ended", "upcoming" (shows only).', operators: STRING_OPS },
  { field: 'file_path', type: 'string', description: 'Path on disk.', operators: STRING_OPS },
  { field: 'library_key', type: 'string', description: 'Media-server library section key. Prefer the rule\'s libraryKeys.', operators: STRING_OPS },
  { field: 'requested_by', type: 'string', description: 'Who requested the item in Overseerr/Jellyseerr.', operators: STRING_OPS },
  { field: 'genres', type: 'string[]', description: 'Genre labels.', operators: LIST_OPS, example: { field: 'genres', operator: 'contains_any', value: ['Documentary', 'Reality'] } },
  { field: 'tags', type: 'string[]', description: 'Tags/labels from the media server.', operators: LIST_OPS },
  { field: 'watched_by', type: 'special', description: 'Usernames who have watched the item (from the watch-history cache).', operators: ['equals', 'not_equals', 'in', 'not_in', 'contains', 'not_contains', 'starts_with', 'ends_with', 'regex_match', 'is_empty', 'is_not_empty'], example: { field: 'watched_by', operator: 'not_in', value: ['alice', 'bob'] } },
  { field: 'in_progress', type: 'boolean', description: 'true when someone started it, has not finished, and played it within the in-progress window (30 days). Add "in_progress equals false" to keep a rule off anything being watched. Plex direct history cannot see partial movie plays; Tautulli can.', operators: BOOL_OPS, example: { field: 'in_progress', operator: 'equals', value: false } },
  { field: 'fully_watched', type: 'boolean', description: 'true when every viewer who started it finished it and, for a show, every episode the library holds has been seen. Never true when the watch state is unknown.', operators: BOOL_OPS, example: { field: 'fully_watched', operator: 'equals', value: true } },
  { field: 'watch_completion', type: 'number', description: 'Share watched, 0-100. A movie is 0 or 100; a show is episodes watched by anyone over episodes held. null when unknown.', operators: NUMBER_OPS, example: { field: 'watch_completion', operator: 'greater_than_or_equal', value: 100 } },
  { field: 'in_progress_by', type: 'special', description: 'Usernames currently in progress on the item (started, not finished, played within the window).', operators: ['equals', 'not_equals', 'in', 'not_in', 'contains', 'not_contains', 'starts_with', 'ends_with', 'regex_match', 'is_empty', 'is_not_empty'], example: { field: 'in_progress_by', operator: 'is_empty', value: null } },
  { field: 'completed_by', type: 'special', description: 'Usernames who finished the item (a movie to the watched threshold; every held episode of a show).', operators: ['equals', 'not_equals', 'in', 'not_in', 'contains', 'not_contains', 'starts_with', 'ends_with', 'regex_match', 'is_empty', 'is_not_empty'], example: { field: 'completed_by', operator: 'is_not_empty', value: null } },
  { field: 'watched_by_user', type: 'special', description: 'One named user\'s watch state. Uses params.username and, for the *_since operators, params.days.', operators: ['ever_watched', 'never_watched', 'watched_since', 'not_watched_since'], example: { field: 'watched_by_user', operator: 'not_watched_since', value: null, params: { username: 'alice', days: 90 } } },
  { field: 'collection_membership', type: 'special', description: 'Radarr collection membership.', operators: ['in_any_protected', 'not_in_any_protected', 'in_collection_id'], example: { field: 'collection_membership', operator: 'not_in_any_protected', value: null } },
];

export const RULE_SCHEMA_DOC = {
  summary:
    'A rule has a name, a mediaType (all | movie | tv), optional libraryKeys, an action (delete queues matching items for deletion after gracePeriodDays; flag only marks them), and conditions. Conditions are a v2 tree: {"version":2,"root":<node>} where a node is either {"kind":"condition","field","operator","value","params"?} or {"kind":"group","logic":"AND"|"OR"|"NOT","children":[...]}. Protected items (directly or via a protected collection) are never deleted whatever the rule says.',
  deletionActions: {
    unmonitor_only: 'Stop monitoring in Sonarr/Radarr, keep files',
    delete_files_only: 'Delete files, keep the entry in Sonarr/Radarr so it can be re-downloaded',
    unmonitor_and_delete: 'Unmonitor and delete files (default)',
    full_removal: 'Remove from Sonarr/Radarr entirely, including metadata',
  },
  examples: [
    {
      name: 'Never watched, added 6+ months ago',
      mediaType: 'all',
      action: 'delete',
      gracePeriodDays: 14,
      conditions: {
        version: 2,
        root: {
          kind: 'group',
          logic: 'AND',
          children: [
            { kind: 'condition', field: 'never_watched', operator: 'equals', value: true },
            { kind: 'condition', field: 'days_since_added', operator: 'greater_than', value: 180 },
          ],
        },
      },
    },
    {
      name: 'Big 4K movies nobody has watched in a year',
      mediaType: 'movie',
      action: 'delete',
      conditions: {
        version: 2,
        root: {
          kind: 'group',
          logic: 'AND',
          children: [
            { kind: 'condition', field: 'resolution_number', operator: 'greater_than_or_equal', value: 2160 },
            { kind: 'condition', field: 'size_gb', operator: 'greater_than', value: 30 },
            {
              kind: 'group',
              logic: 'OR',
              children: [
                { kind: 'condition', field: 'never_watched', operator: 'equals', value: true },
                { kind: 'condition', field: 'days_since_watched', operator: 'greater_than', value: 365 },
              ],
            },
          ],
        },
      },
    },
  ],
  fields: RULE_FIELDS,
};
