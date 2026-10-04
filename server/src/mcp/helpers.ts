/**
 * Shared plumbing for MCP tools: registration with a catalogue, result
 * envelopes, and the compact media shapes an assistant reads best.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';
import type { MediaItem } from '../types';
import { formatBytes } from '../utils/format';
import { parseWatchState } from '../services/watchState';
import { describeReasons, holdState, parseAvailability } from '../services/availabilityVerdict';
import { IMMEDIATE_DELETION_REFUSED, allowsImmediateDeletion } from './config';
import { isRole, type Role } from '../auth/config';
import { ROLE_RANK } from '../auth/roles';

// ============================================================================
// Catalogue
// ============================================================================

export type ToolGroup =
  | 'overview'
  | 'library'
  | 'actions'
  | 'queue'
  | 'rules'
  | 'collections'
  | 'scans'
  | 'history'
  | 'folders'
  | 'system';

export interface ToolCatalogEntry {
  name: string;
  title: string;
  description: string;
  group: ToolGroup;
  readOnly: boolean;
  destructive: boolean;
  /** Needs the "allow immediate deletion" opt-in before it will act. */
  requiresImmediateDeletion: boolean;
  minRole: Role;
}

const catalog: ToolCatalogEntry[] = [];

/** Every registered tool, in registration order. Used by the Settings panel and docs. */
export function getToolCatalog(): readonly ToolCatalogEntry[] {
  return catalog;
}

type Shape = Record<string, z.ZodTypeAny>;

interface ToolDefinition<InputShape extends Shape | undefined> {
  name: string;
  title: string;
  description: string;
  group: ToolGroup;
  inputSchema?: InputShape;
  annotations?: ToolAnnotations;
  /** Refuse unless the immediate-deletion opt-in is on. */
  requiresImmediateDeletion?: boolean;
  /**
   * Lowest role that may call the tool. Defaults: read-only tools → viewer,
   * system tools → admin, everything else → operator. The API key is admin.
   */
  minRole?: Role;
}

type Handler<InputShape extends Shape | undefined> = InputShape extends Shape
  ? (args: z.output<z.ZodObject<InputShape>>) => Promise<CallToolResult> | CallToolResult
  : () => Promise<CallToolResult> | CallToolResult;

/**
 * Register a tool, record it in the catalogue, and wrap its handler so a thrown
 * error becomes a tool error the assistant can read instead of a protocol
 * failure. Registration is idempotent per server instance, which is what lets
 * the connector create one server per session.
 */
export function defineTool<InputShape extends Shape | undefined = undefined>(
  server: McpServer,
  definition: ToolDefinition<InputShape>,
  handler: Handler<InputShape>
): void {
  const readOnly = definition.annotations?.readOnlyHint === true;
  const destructive = definition.annotations?.destructiveHint === true;

  if (!catalog.some((entry) => entry.name === definition.name)) {
    catalog.push({
      name: definition.name,
      title: definition.title,
      description: definition.description,
      group: definition.group,
      readOnly,
      destructive,
      requiresImmediateDeletion: definition.requiresImmediateDeletion === true,
      minRole: definition.minRole ?? (definition.group === 'system' ? 'admin' : readOnly ? 'viewer' : 'operator'),
    });
  }

  const minRole: Role = definition.minRole ?? (definition.group === 'system' ? 'admin' : readOnly ? 'viewer' : 'operator');

  const run = async (args: unknown, extra?: { authInfo?: { extra?: Record<string, unknown> } }): Promise<CallToolResult> => {
    const rawRole = extra?.authInfo?.extra?.['role'];
    const role: Role = isRole(rawRole) ? rawRole : 'admin';
    if (ROLE_RANK[role] < ROLE_RANK[minRole]) {
      return fail(`Your role (${role}) cannot use ${definition.name}; it needs ${minRole}. Ask a Prunerr admin to change your group mapping.`);
    }
    if (definition.requiresImmediateDeletion && !allowsImmediateDeletion()) {
      return fail(IMMEDIATE_DELETION_REFUSED);
    }
    try {
      return await (handler as (a: unknown) => Promise<CallToolResult> | CallToolResult)(args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail(message);
    }
  };

  const config = {
    title: definition.title,
    description: definition.description,
    annotations: { title: definition.title, ...definition.annotations },
    ...(definition.inputSchema ? { inputSchema: definition.inputSchema } : {}),
  };

  // The SDK's generics distinguish "no input" from "object input"; both land
  // on the same runtime registration, so the cast here is on the type level only.
  if (definition.inputSchema) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server.registerTool as any)(definition.name, config, (args: unknown, extra: unknown) => run(args, extra as { authInfo?: { extra?: Record<string, unknown> } }));
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server.registerTool as any)(definition.name, config, (extra: unknown) => run({}, extra as { authInfo?: { extra?: Record<string, unknown> } }));
  }
}

// ============================================================================
// Result envelopes
// ============================================================================

/**
 * A successful result: a short human summary first, then the data as JSON in
 * both the text stream (for clients that only read text) and
 * `structuredContent` (for clients that prefer data).
 */
export function ok(data: unknown, summary?: string): CallToolResult {
  const json = JSON.stringify(data, null, 2);
  const text = summary ? `${summary}\n\n${json}` : json;
  const structured =
    data !== null && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : { result: data };
  return {
    content: [{ type: 'text', text }],
    structuredContent: structured,
  };
}

export function fail(message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
  };
}

// ============================================================================
// Shapes
// ============================================================================

export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** Changes Prunerr's own state but deletes nothing. */
export const MUTATING: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

/** Can remove files or records that cannot be brought back. */
export const DESTRUCTIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

/** Reaches out to Plex, Sonarr, Radarr or another service. */
export const EXTERNAL_READ: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

export function clientMediaType(type: string): 'movie' | 'tv' | 'episode' {
  if (type === 'show') return 'tv';
  if (type === 'episode') return 'episode';
  return 'movie';
}

export function daysSince(iso: string | null | undefined, now: Date = new Date()): number | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  return Math.floor((now.getTime() - then) / (1000 * 60 * 60 * 24));
}

export function clientStatus(status: string): string {
  if (status === 'pending_deletion') return 'queued';
  if (status === 'monitored') return 'active';
  return status;
}

export interface MediaSummary {
  id: number;
  title: string;
  type: 'movie' | 'tv' | 'episode';
  year: number | null;
  status: string;
  size: string;
  sizeBytes: number;
  isProtected: boolean;
  protectionReason: string | null;
  playCount: number;
  lastWatchedAt: string | null;
  daysSinceWatched: number | null;
  addedAt: string | null;
  daysSinceAdded: number | null;
  requestedBy: string | null;
  resolution: string | null;
  rating: number | null;
  /** Someone started it, has not finished, and played it within the in-progress window. */
  inProgress: boolean;
  /** 0-100 share watched; null when unknown. */
  watchCompletion: number | null;
  queuedForDeletionAt?: string | null;
  deleteAfter?: string | null;
}

/** The compact shape search results use: enough to decide, small enough to list. */
export function summarizeMediaItem(item: MediaItem, now: Date = new Date()): MediaSummary {
  const base: MediaSummary = {
    id: item.id,
    title: item.title,
    type: clientMediaType(item.type),
    year: item.year,
    status: clientStatus(item.status),
    size: formatBytes(item.file_size || 0),
    sizeBytes: item.file_size || 0,
    isProtected: Boolean(item.is_protected),
    protectionReason: item.is_protected ? item.protection_reason : null,
    playCount: item.play_count,
    lastWatchedAt: item.last_watched_at,
    daysSinceWatched: daysSince(item.last_watched_at, now),
    addedAt: item.added_at ?? item.created_at,
    daysSinceAdded: daysSince(item.added_at ?? item.created_at, now),
    requestedBy: item.requested_by,
    resolution: item.resolution,
    rating: item.rating_imdb ?? item.rating_tmdb ?? null,
    inProgress: Boolean(item.in_progress),
    watchCompletion: item.watch_completion === null || item.watch_completion === undefined ? null : Math.round(item.watch_completion * 100),
  };
  if (item.status === 'pending_deletion') {
    base.queuedForDeletionAt = item.marked_at;
    base.deleteAfter = item.delete_after;
  }
  return base;
}

function parseWatchedBy(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** Per-viewer watch state for `get_media_item`, or null until a sync with a watch history provider. */
function describeWatchState(item: MediaItem): Record<string, unknown> | null {
  const state = parseWatchState(item.watch_state);
  if (!state) return null;
  return {
    inProgressBy: state.inProgressUsers,
    completedBy: state.completedBy,
    startedBy: state.startedBy,
    lastPlayedByUser: state.lastPlayedByUser,
    episodesWatched: state.episodesWatched,
    episodesTotal: state.episodesTotal,
    completionPercent: state.completion === null ? null : Math.round(state.completion * 100),
    computedAt: state.computedAt,
  };
}

/** The full shape `get_media_item` returns. */
export function describeMediaItem(item: MediaItem, now: Date = new Date()): Record<string, unknown> {
  const itemAny = item as unknown as Record<string, unknown>;
  return {
    ...summarizeMediaItem(item, now),
    watchedBy: parseWatchedBy(item.watched_by),
    watchState: describeWatchState(item),
    genres: item.genres ?? [],
    tags: item.tags ?? [],
    studio: item.studio,
    contentRating: item.content_rating,
    originalLanguage: item.original_language,
    runtimeMinutes: item.runtime_minutes,
    seasonCount: item.season_count,
    episodeCount: item.episode_count,
    seriesStatus: item.series_status,
    ratings: { imdb: item.rating_imdb, tmdb: item.rating_tmdb, rottenTomatoes: item.rating_rt },
    video: { codec: item.video_codec ?? item.codec, audioCodec: item.audio_codec, hdr: item.hdr, bitrate: item.bitrate },
    filePath: item.file_path,
    libraryKey: item.library_key ?? null,
    ids: {
      plex: item.plex_id,
      sonarr: item.sonarr_id,
      radarr: item.radarr_id,
      tmdb: item.tmdb_id,
      tvdb: item.tvdb_id,
      imdb: item.imdb_id,
    },
    queue:
      item.status === 'pending_deletion'
        ? {
            queuedAt: item.marked_at,
            deleteAfter: item.delete_after,
            deletionAction: itemAny['deletion_action'] ?? null,
            resetOverseerr: Boolean(itemAny['reset_overseerr']),
            matchedRuleId: itemAny['matched_rule_id'] ?? null,
          }
        : null,
    archive: describeArchive(item),
    deletedAt: item.deleted_at,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
  };
}

/** Archive: the stored re-acquisition verdict, the hold and whether the item is archived. */
export function describeArchive(item: MediaItem): Record<string, unknown> {
  const report = parseAvailability(item.availability);
  const hold = item.status === 'pending_deletion' ? holdState(item) : null;
  return {
    archived: Boolean(item.archived_at),
    archivedAt: item.archived_at ?? null,
    availability: report
      ? {
          verdict: report.verdict,
          reasons: report.reasons,
          detail: describeReasons(report),
          checkedAt: report.checkedAt,
          releases: report.releases,
          usenet: report.usenet,
          torrents: report.torrents,
          maxSeeders: report.maxSeeders,
          best: report.best,
          current: report.current,
          indexers: report.indexers,
          seasons: report.seasons ?? null,
          error: report.error ?? null,
        }
      : null,
    held: hold?.held ?? false,
    heldReason: hold?.reason ?? null,
    deleteAnyway: item.availability_decision === 'delete',
  };
}

/** Clamp a requested page size to something a context window can hold. */
export function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(limit)));
}

export const GiB = 1024 * 1024 * 1024;
