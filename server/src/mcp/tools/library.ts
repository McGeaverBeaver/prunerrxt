import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import mediaItemsRepo from '../../db/repositories/mediaItems';
import collectionsRepo from '../../db/repositories/collections';
import settingsRepo from '../../db/repositories/settings';
import episodeDeletionsRepo from '../../db/repositories/episodeDeletions';
import { getActivityByItemId } from '../../db/repositories/activity';
import { getPlexService, getSonarrService } from '../../services/init';
import { buildSonarrSeriesDetail, type SonarrEpisodeQueued } from '../../services/sonarrSeriesDetail';
import { getMediaServerLabel } from '../../services/mediaServer';
import { formatBytes } from '../../utils/format';
import type { MediaItem } from '../../types';
import { EXTERNAL_READ, GiB, READ_ONLY, clampLimit, defineTool, describeMediaItem, fail, ok, summarizeMediaItem } from '../helpers';

const SORT_FIELDS = ['title', 'size', 'addedAt', 'lastWatched', 'playCount', 'year', 'rating'] as const;

/**
 * Prefer the stored Sonarr ID and fall back to a TVDB lookup for rows synced
 * before the match ran (or where Sonarr re-added the series).
 */
export async function resolveSonarrSeriesId(item: MediaItem): Promise<number | null> {
  if (item.type !== 'show' && item.type !== 'episode') return null;
  const sonarr = getSonarrService();
  if (!sonarr) return null;
  if (item.sonarr_id) return item.sonarr_id;
  if (!item.tvdb_id) return null;
  const matched = await sonarr.getSeriesByTvdbId(item.tvdb_id);
  return matched?.id ?? null;
}

export function registerLibraryTools(server: McpServer): void {
  defineTool(
    server,
    {
      name: 'search_library',
      title: 'Search the library',
      description:
        'Find movies and shows in PrunerrXT\'s copy of the library. Filter by title, type, status, watched state, staleness, size and protection; sort and page. Returns compact summaries — use get_media_item for the full record. Sizes in the filters are gigabytes.',
      group: 'library',
      inputSchema: {
        query: z.string().optional().describe('Title search, case-insensitive substring.'),
        type: z.enum(['movie', 'tv']).optional(),
        status: z
          .enum(['active', 'queued', 'flagged', 'protected', 'deleted'])
          .optional()
          .describe('active = monitored and not queued; queued = in the deletion queue; deleted = tombstones of items already removed.'),
        watched: z.boolean().optional().describe('true = played at least once, false = never played.'),
        unwatchedDays: z.number().int().min(1).optional().describe('Only items not watched in at least this many days (never-watched items included).'),
        minSizeGB: z.number().min(0).optional(),
        maxSizeGB: z.number().min(0).optional(),
        protected: z.boolean().optional().describe('Filter on item-level protection.'),
        archived: z.boolean().optional().describe('Filter on Archive: true for titles kept because they could not be downloaded again.'),
        requestedBy: z.string().optional().describe('Overseerr/Jellyseerr requester name (exact, case-insensitive).'),
        sortBy: z.enum(SORT_FIELDS).optional().describe('Default: size, largest first.'),
        sortOrder: z.enum(['asc', 'desc']).optional(),
        page: z.number().int().min(1).optional(),
        limit: z.number().int().min(1).max(100).optional().describe('Page size (default 25, max 100).'),
      },
      annotations: READ_ONLY,
    },
    async (args) => {
      const limit = clampLimit(args.limit, 25, 100);
      const page = args.page ?? 1;
      const serverStatus =
        args.status === 'queued'
          ? 'pending_deletion'
          : args.status === 'active'
            ? 'monitored'
            : args.status;

      const result = mediaItemsRepo.getAll({
        type: args.type === 'tv' ? 'show' : args.type,
        status: serverStatus as 'monitored' | 'flagged' | 'pending_deletion' | 'protected' | 'deleted' | undefined,
        search: args.query,
        limit,
        offset: (page - 1) * limit,
        minSize: args.minSizeGB !== undefined ? Math.round(args.minSizeGB * GiB) : undefined,
        maxSize: args.maxSizeGB !== undefined ? Math.round(args.maxSizeGB * GiB) : undefined,
        watched: args.watched,
        unwatchedDays: args.unwatchedDays,
        isProtected: args.protected,
        archived: args.archived,
        excludeDeleted: args.status !== 'deleted',
        sortBy: args.sortBy ?? 'size',
        sortOrder: args.sortOrder ?? (args.sortBy === 'title' ? 'asc' : 'desc'),
      });

      const now = new Date();
      let rows = result.data;
      if (args.requestedBy) {
        const needle = args.requestedBy.toLowerCase();
        rows = rows.filter((item) => (item.requested_by ?? '').toLowerCase() === needle);
      }

      const protectedMap = collectionsRepo.findProtectedForItems(rows.map((r) => r.id));
      const items = rows.map((item) => {
        const colls = protectedMap.get(item.id) ?? [];
        const summary = summarizeMediaItem(item, now);
        if (colls.length > 0) {
          summary.isProtected = true;
          summary.protectionReason = summary.protectionReason ?? `Protected via collection "${colls[0]!.title}"`;
        }
        return summary;
      });
      const pageBytes = items.reduce((sum, i) => sum + i.sizeBytes, 0);

      return ok(
        {
          total: result.total,
          page,
          pageSize: limit,
          totalPages: Math.max(1, Math.ceil(result.total / limit)),
          pageSize_bytes: pageBytes,
          pageSizeFormatted: formatBytes(pageBytes),
          items,
        },
        `${result.total} match(es). Page ${page} of ${Math.max(1, Math.ceil(result.total / limit))}, ${items.length} item(s) totalling ${formatBytes(pageBytes)}.`
      );
    }
  );

  defineTool(
    server,
    {
      name: 'get_media_item',
      title: 'Media item details',
      description:
        'Everything PrunerrXT knows about one movie or show: metadata, ratings, file details, watch history summary, protection (including protection inherited from a collection), queue state, collections it belongs to, queued episodes, and its recent activity.',
      group: 'library',
      inputSchema: {
        id: z.number().int().positive().describe('PrunerrXT media item id (from search_library or list_queue).'),
      },
      annotations: READ_ONLY,
    },
    async ({ id }) => {
      const item = mediaItemsRepo.getById(id);
      if (!item) return fail(`Media item ${id} not found`);

      const protectedCollections = collectionsRepo.findProtectedContainingItem(id);
      const collections = collectionsRepo.findByMediaItem(id).map((c) => ({
        id: c.id,
        title: c.title,
        isProtected: Boolean(c.is_protected),
        itemCount: c.item_count,
      }));
      const detail = describeMediaItem(item);
      if (protectedCollections.length > 0) {
        detail['isProtected'] = true;
        detail['protectionReason'] = detail['protectionReason'] ?? `Protected via collection "${protectedCollections[0]!.title}"`;
        detail['protectedByCollection'] = { id: protectedCollections[0]!.id, title: protectedCollections[0]!.title };
      }
      const queuedEpisodes = episodeDeletionsRepo.getPendingForItem(id).map((row) => ({
        queueId: `ep-${row.id}`,
        season: row.season_number,
        episode: row.episode_number,
        title: row.episode_title,
        size: formatBytes(row.file_size || 0),
        deletionAction: row.deletion_action,
        deleteAfter: row.delete_after,
      }));
      const activity = getActivityByItemId(id, 10).map((e) => ({
        at: e.createdAt,
        event: e.eventType,
        action: e.action,
        actor: e.actorName ?? e.actorType,
      }));

      return ok(
        { ...detail, collections, queuedEpisodes, recentActivity: activity },
        `${item.title}${item.year ? ` (${item.year})` : ''}: ${detail['type']}, ${detail['size']}, status ${detail['status']}${detail['isProtected'] ? ', PROTECTED' : ''}. Played ${item.play_count} time(s).`
      );
    }
  );

  defineTool(
    server,
    {
      name: 'get_show_episodes',
      title: 'Show seasons and episodes (Sonarr)',
      description:
        'For a TV show: the season and episode breakdown from Sonarr with file sizes, monitored flags, download state and which episodes are already queued for deletion. Needed before queue_episodes_for_deletion. Requires Sonarr.',
      group: 'library',
      inputSchema: {
        id: z.number().int().positive().describe('PrunerrXT media item id of the show.'),
        season: z.number().int().min(0).optional().describe('Only this season number.'),
      },
      annotations: EXTERNAL_READ,
    },
    async ({ id, season }) => {
      const item = mediaItemsRepo.getById(id);
      if (!item) return fail(`Media item ${id} not found`);
      const sonarr = getSonarrService();
      if (!sonarr) return fail('Sonarr is not configured');
      if (item.type !== 'show' && item.type !== 'episode') return fail(`"${item.title}" is a ${item.type}, not a show`);

      const seriesId = await resolveSonarrSeriesId(item);
      if (!seriesId) return fail(`"${item.title}" is not matched to a series in Sonarr`);

      const series = await sonarr.getSeriesById(seriesId);
      const [episodes, files, queueResult] = await Promise.all([
        sonarr.getEpisodes(seriesId),
        sonarr.getEpisodeFiles(seriesId),
        sonarr.getQueue().catch(() => []),
      ]);

      episodeDeletionsRepo.pruneMissingEpisodes(id, episodes.map((e) => e.id));
      const queuedByEpisodeId = new Map<number, SonarrEpisodeQueued>(
        episodeDeletionsRepo.getPendingForItem(id).map((row) => [
          row.episode_id,
          { id: row.id, action: row.deletion_action, markedAt: row.marked_at, deleteAfter: row.delete_after },
        ])
      );

      const detail = buildSonarrSeriesDetail({ series, episodes, files, queue: queueResult, queuedByEpisodeId });
      const seasons = detail.seasons
        .filter((s) => season === undefined || s.seasonNumber === season)
        .map((s) => ({
          season: s.seasonNumber,
          monitored: s.monitored,
          episodes: s.episodes.length,
          episodesWithFiles: s.episodes.filter((e) => e.hasFile).length,
          size: formatBytes(s.episodes.reduce((sum, e) => sum + (e.file?.size ?? 0), 0)),
          sizeBytes: s.episodes.reduce((sum, e) => sum + (e.file?.size ?? 0), 0),
          episodeList: s.episodes.map((e) => ({
            episodeId: e.id,
            number: e.episodeNumber,
            title: e.title,
            airDate: e.airDateUtc ?? null,
            monitored: e.monitored,
            hasFile: e.hasFile,
            state: e.state,
            size: e.file ? formatBytes(e.file.size) : null,
            sizeBytes: e.file?.size ?? 0,
            quality: e.file?.quality ?? null,
            queued: e.queued ? { queueId: `ep-${e.queued.id}`, action: e.queued.action, deleteAfter: e.queued.deleteAfter } : null,
          })),
        }));

      const totalBytes = seasons.reduce((sum, s) => sum + s.sizeBytes, 0);
      return ok(
        {
          mediaItemId: id,
          title: item.title,
          sonarrSeriesId: seriesId,
          seriesStatus: detail.series.status,
          monitored: detail.series.monitored,
          totals: detail.totals,
          seasons,
        },
        `${item.title}: ${seasons.length} season(s), ${formatBytes(totalBytes)} on disk. Episode ids in episodeList are what queue_episodes_for_deletion takes.`
      );
    }
  );

  defineTool(
    server,
    {
      name: 'list_requesters',
      title: 'List requesters',
      description: 'Distinct Overseerr/Jellyseerr requester names seen in the library, for filtering search_library by requestedBy.',
      group: 'library',
      annotations: READ_ONLY,
    },
    async () => {
      const requesters = mediaItemsRepo.getDistinctRequesters();
      return ok({ requesters }, `${requesters.length} requester(s).`);
    }
  );

  defineTool(
    server,
    {
      name: 'list_libraries',
      title: 'List media-server libraries',
      description:
        'Library sections on the media server (Plex/Jellyfin/Emby) with their keys, types and whether PrunerrXT excludes them. Library keys are what rules\' libraryKeys refer to.',
      group: 'library',
      annotations: EXTERNAL_READ,
    },
    async () => {
      const mediaServer = getPlexService();
      if (!mediaServer) return fail(`${getMediaServerLabel()} is not configured`);
      const libraries = await mediaServer.getLibraries();
      let excludedKeys: string[] = [];
      try {
        const raw = settingsRepo.getValue('excluded_library_keys');
        excludedKeys = raw ? (JSON.parse(raw) as string[]) : [];
      } catch {
        excludedKeys = [];
      }
      const data = libraries.map((lib) => ({
        key: lib.key,
        title: lib.title,
        type: lib.type,
        excluded: excludedKeys.includes(lib.key),
      }));
      return ok({ mediaServer: getMediaServerLabel(), libraries: data }, `${data.length} library section(s) on ${getMediaServerLabel()}.`);
    }
  );
}
