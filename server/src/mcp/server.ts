/**
 * Builds a Prunerr MCP server with every tool, resource and prompt registered.
 * One instance is created per client session; the registrations are cheap
 * closures over the shared repositories and services.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getAppVersion } from '../utils/version';
import { registerOverviewTools } from './tools/overview';
import { registerLibraryTools } from './tools/library';
import { registerActionTools } from './tools/actions';
import { registerQueueTools } from './tools/queue';
import { registerRuleTools } from './tools/rules';
import { registerCollectionTools } from './tools/collections';
import { registerScanTools } from './tools/scans';
import { registerHistoryTools } from './tools/history';
import { registerSystemTools } from './tools/system';
import { registerResources } from './resources';
import { registerPrompts } from './prompts';
import { allowsImmediateDeletion } from './config';

export const MCP_SERVER_NAME = 'prunerr';

function buildInstructions(): string {
  const immediate = allowsImmediateDeletion();
  return [
    'Prunerr manages a Plex/Jellyfin/Emby media library through Sonarr and Radarr: it finds content nobody watches and reclaims the space.',
    '',
    'How deletion works here: nothing is deleted directly. Items are *queued* with a grace period (queue_for_deletion, run_rule, trigger_scan); the queue is processed later, and anything in it can be removed again (remove_from_queue). Protected items — directly or via a protected collection — are never deleted.',
    '',
    'Working style:',
    '- Start with get_overview. Use search_library / get_media_item to look at specific titles.',
    '- Before queueing or changing rules, show the user what will be affected (preview_rule, search results) and get confirmation.',
    '- Prefer queueing with the default grace period over anything immediate.',
    `- Immediate deletion (delete_now, process_queue with dryRun=false, queue_episodes_for_deletion with immediate=true) is ${
      immediate ? 'enabled on this install, but still confirm explicitly with the user first' : 'DISABLED on this install; those calls will be refused'
    }.`,
    '- Sizes are given both human-readable and in bytes; ids are Prunerr ids, not Plex/Sonarr ids, unless named otherwise.',
    '- Read describe_rule_fields (or the prunerr://rules/schema resource) before writing a rule.',
  ].join('\n');
}

export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, title: 'Prunerr', version: getAppVersion() },
    {
      capabilities: { logging: {} },
      instructions: buildInstructions(),
    }
  );

  registerOverviewTools(server);
  registerLibraryTools(server);
  registerActionTools(server);
  registerQueueTools(server);
  registerRuleTools(server);
  registerCollectionTools(server);
  registerScanTools(server);
  registerHistoryTools(server);
  registerSystemTools(server);
  registerResources(server);
  registerPrompts(server);

  return server;
}
