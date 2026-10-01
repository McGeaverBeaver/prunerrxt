import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import historyRepo from '../../db/repositories/history';
import activityRepo, { getActivityByItemId, type ActivityActorType, type ActivityEventType, type ActivityLogEntry } from '../../db/repositories/activity';
import plexUsersRepo from '../../db/repositories/plexUsers';
import { syncMediaServerUsers } from '../../services/mediaServerUsers';
import {
  createConfiguredMediaServer,
  createMediaServerUsers,
  getMediaServerCredentials,
  getMediaServerLabel,
} from '../../services/mediaServer';
import { formatBytes } from '../../utils/format';
import { EXTERNAL_READ, READ_ONLY, clampLimit, defineTool, fail, ok } from '../helpers';

const EVENT_TYPES = ['scan', 'deletion', 'rule_match', 'protection', 'manual_action', 'error', 'disk_pressure'] as const;
const ACTOR_TYPES = ['scheduler', 'user', 'rule'] as const;

function parseMeta(entry: ActivityLogEntry) {
  let metadata: Record<string, unknown> | null = null;
  if (entry.metadata) {
    try {
      metadata = JSON.parse(entry.metadata) as Record<string, unknown>;
    } catch {
      metadata = null;
    }
  }
  return {
    id: entry.id,
    at: entry.createdAt,
    event: entry.eventType,
    action: entry.action,
    actor: { type: entry.actorType, id: entry.actorId, name: entry.actorName },
    target: { type: entry.targetType, id: entry.targetId, title: entry.targetTitle },
    metadata,
  };
}

export function registerHistoryTools(server: McpServer): void {
  defineTool(
    server,
    {
      name: 'list_deletion_history',
      title: 'Deletion history',
      description: 'What Prunerr has deleted, newest first, with sizes and the rule responsible, plus totals.',
      group: 'history',
      inputSchema: {
        search: z.string().optional().describe('Title substring.'),
        dateRange: z.enum(['7d', '30d', '90d', 'all']).optional().describe('Default all.'),
        page: z.number().int().min(1).optional(),
        limit: z.number().int().min(1).max(100).optional().describe('Default 25.'),
      },
      annotations: READ_ONLY,
    },
    async ({ search, dateRange, page, limit }) => {
      const result = historyRepo.getHistory({ search, dateRange, page: page ?? 1, limit: clampLimit(limit, 25, 100) });
      return ok(
        {
          total: result.total,
          page: result.page,
          pageSize: result.limit,
          stats: {
            totalDeleted: result.stats.totalDeleted,
            totalSpaceReclaimed: formatBytes(result.stats.totalSpaceReclaimed),
            totalSpaceReclaimedBytes: result.stats.totalSpaceReclaimed,
          },
          items: result.items.map((i) => ({ ...i, sizeFormatted: formatBytes(i.size ?? 0) })),
        },
        `${result.total} deletion(s) in range; ${result.stats.totalDeleted} all-time, ${formatBytes(result.stats.totalSpaceReclaimed)} reclaimed all-time.`
      );
    }
  );

  defineTool(
    server,
    {
      name: 'list_activity',
      title: 'Activity log',
      description: 'The unified activity log: scans, rule matches, queueing, protection changes, deletions, errors and disk-pressure events, newest first.',
      group: 'history',
      inputSchema: {
        eventTypes: z.array(z.enum(EVENT_TYPES)).optional(),
        actorTypes: z.array(z.enum(ACTOR_TYPES)).optional(),
        dateRange: z.enum(['24h', '7d', '30d', 'all']).optional().describe('Default 7d.'),
        search: z.string().optional(),
        page: z.number().int().min(1).optional(),
        limit: z.number().int().min(1).max(100).optional().describe('Default 25.'),
      },
      annotations: READ_ONLY,
    },
    async ({ eventTypes, actorTypes, dateRange, search, page, limit }) => {
      const result = activityRepo.getActivityLog({
        eventTypes: eventTypes as ActivityEventType[] | undefined,
        actorTypes: actorTypes as ActivityActorType[] | undefined,
        dateRange: dateRange ?? '7d',
        search,
        page: page ?? 1,
        limit: clampLimit(limit, 25, 100),
      });
      return ok(
        { total: result.total, page: result.page, items: result.items.map(parseMeta) },
        `${result.total} event(s) in range; showing ${result.items.length}.`
      );
    }
  );

  defineTool(
    server,
    {
      name: 'get_item_activity',
      title: 'Activity for one item',
      description: 'Every logged event for one media item — when it was queued, by which rule, protected, deleted.',
      group: 'history',
      inputSchema: {
        id: z.number().int().positive(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      annotations: READ_ONLY,
    },
    async ({ id, limit }) => {
      const entries = getActivityByItemId(id, clampLimit(limit, 50, 200)).map(parseMeta);
      return ok({ mediaItemId: id, total: entries.length, events: entries }, `${entries.length} event(s) for item ${id}.`);
    }
  );

  defineTool(
    server,
    {
      name: 'list_users',
      title: 'List media-server users',
      description: 'Known user accounts on the media server (owner, home users, friends). Their usernames are what watched_by conditions match against.',
      group: 'history',
      annotations: READ_ONLY,
    },
    async () => {
      const users = plexUsersRepo.findAll().map((u) => ({
        id: u.id,
        username: u.username,
        email: u.email,
        isOwner: u.is_owner === 1,
        isHomeUser: u.is_home_user === 1,
        lastSyncedAt: u.last_synced_at,
      }));
      return ok({ users }, `${users.length} user(s).`);
    }
  );

  defineTool(
    server,
    {
      name: 'sync_users',
      title: 'Sync users from the media server',
      description: 'Refresh the list of user accounts from the media server.',
      group: 'history',
      annotations: { ...EXTERNAL_READ, readOnlyHint: false },
    },
    async () => {
      const credentials = getMediaServerCredentials();
      const mediaServer = createConfiguredMediaServer();
      if (!credentials || !mediaServer) return fail(`${getMediaServerLabel()} is not configured`);
      const provider = createMediaServerUsers(mediaServer, credentials.url, credentials.credential);
      const users = await syncMediaServerUsers(provider, getMediaServerLabel());
      return ok({ synced: users.length, users: users.map((u) => u.username) }, `Synced ${users.length} user(s) from ${getMediaServerLabel()}.`);
    }
  );
}
