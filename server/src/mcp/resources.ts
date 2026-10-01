/**
 * MCP resources: read-only documents an assistant can pull into context
 * without calling a tool. Each mirrors a tool so clients that prefer one
 * mechanism over the other get the same data.
 */
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import mediaItemsRepo from '../db/repositories/mediaItems';
import rulesRepo from '../db/repositories/rules';
import collectionsRepo from '../db/repositories/collections';
import { getDashboardStats } from '../services/dashboardStats';
import { getAllQueueItems, summarizeQueue } from '../services/deletionQueue';
import { upgradeToV2 } from '../rules/engine';
import { formatBytes } from '../utils/format';
import { RULE_SCHEMA_DOC } from './ruleSchema';
import { describeMediaItem } from './helpers';
import { getToolCatalog } from './helpers';

function json(uri: string, data: unknown) {
  return {
    contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }],
  };
}

export function registerResources(server: McpServer): void {
  server.registerResource(
    'overview',
    'prunerr://overview',
    {
      title: 'Library overview',
      description: 'Dashboard statistics: library size and counts, queue summary, disk pressure, active rules.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const stats = await getDashboardStats();
      const queue = summarizeQueue(getAllQueueItems());
      return json(uri.href, { ...stats, totalStorageFormatted: formatBytes(stats.totalStorage), queue });
    }
  );

  server.registerResource(
    'queue',
    'prunerr://queue',
    {
      title: 'Deletion queue',
      description: 'Every item and episode waiting to be deleted, soonest first.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const items = getAllQueueItems();
      return json(uri.href, { summary: summarizeQueue(items), items });
    }
  );

  server.registerResource(
    'rules',
    'prunerr://rules',
    {
      title: 'Cleanup rules',
      description: 'All rules with their v2 condition trees.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const rules = rulesRepo.rules.getAll().map((rule) => {
        let conditions: unknown;
        try {
          conditions = upgradeToV2(JSON.parse(rule.conditions));
        } catch {
          conditions = null;
        }
        return { ...rule, conditions };
      });
      return json(uri.href, { rules });
    }
  );

  server.registerResource(
    'rule-schema',
    'prunerr://rules/schema',
    {
      title: 'Rule schema reference',
      description: 'Condition fields, operators, deletion actions and example rules.',
      mimeType: 'application/json',
    },
    async (uri) => json(uri.href, RULE_SCHEMA_DOC)
  );

  server.registerResource(
    'collections',
    'prunerr://collections',
    {
      title: 'Collections',
      description: 'Radarr collections with protection state.',
      mimeType: 'application/json',
    },
    async (uri) => json(uri.href, { collections: collectionsRepo.findAll() })
  );

  server.registerResource(
    'tool-catalog',
    'prunerr://tools',
    {
      title: 'Tool catalogue',
      description: 'Every tool this server offers, grouped, with read-only/destructive flags.',
      mimeType: 'application/json',
    },
    async (uri) => json(uri.href, { tools: getToolCatalog() })
  );

  server.registerResource(
    'media-item',
    new ResourceTemplate('prunerr://media/{id}', {
      list: undefined,
      complete: {
        id: async (value) => {
          const needle = value.trim();
          if (!needle) return [];
          const result = mediaItemsRepo.getAll({ search: needle, limit: 10, offset: 0, excludeDeleted: true });
          return result.data.map((item) => String(item.id));
        },
      },
    }),
    {
      title: 'Media item',
      description: 'Full details of one movie or show by Prunerr id.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const id = Number(variables['id']);
      const item = Number.isInteger(id) ? mediaItemsRepo.getById(id) : null;
      if (!item) {
        return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: `Media item ${variables['id']} not found` }] };
      }
      return json(uri.href, describeMediaItem(item));
    }
  );
}
