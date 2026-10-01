/**
 * MCP prompts: reusable starting points a client can offer as slash commands.
 * Each one lays out the safe order of operations for a common job.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

function text(content: string) {
  return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: content } }] };
}

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'review_queue',
    {
      title: 'Review the deletion queue',
      description: 'Walk through what is about to be deleted and flag anything that looks like a mistake.',
    },
    async () =>
      text(
        [
          'Review my Prunerr deletion queue.',
          '1. Call list_queue and get_overview.',
          '2. For anything surprising (recently added, high rating, requested by someone, watched recently, part of a collection), call get_media_item and explain why it might be a mistake.',
          '3. Summarise: how many items, how much space, how many are ready for deletion now, and which ones you recommend removing from the queue with remove_from_queue (ask me before removing).',
          'Do not call delete_now or process_queue with dryRun=false.',
        ].join('\n')
      )
  );

  server.registerPrompt(
    'reclaim_space',
    {
      title: 'Find space to reclaim',
      description: 'Find the best candidates to free a target amount of disk space, safely.',
      argsSchema: {
        targetGB: z.string().describe('How many gigabytes to free, e.g. "500".'),
        mediaType: z.string().optional().describe('movie, tv or all (default all).'),
      },
    },
    async ({ targetGB, mediaType }) =>
      text(
        [
          `I want to free about ${targetGB} GB on my media server${mediaType && mediaType !== 'all' ? ` from ${mediaType} content` : ''}.`,
          '1. Call get_overview, then get_recommendations with a generous limit, and search_library sorted by size for large unwatched items.',
          '2. Skip anything protected, anything requested by someone else unless it is very stale, and anything already queued.',
          '3. Propose a list that reaches the target, with title, size, last watched and why. Ask me to confirm.',
          '4. Only after I confirm, call queue_for_deletion with the ids (use the default grace period so I can still change my mind). Never call delete_now.',
        ].join('\n')
      )
  );

  server.registerPrompt(
    'build_rule',
    {
      title: 'Build a cleanup rule',
      description: 'Turn a plain-English cleanup policy into a tested Prunerr rule.',
      argsSchema: {
        policy: z.string().describe('The policy in plain English, e.g. "delete movies nobody has watched in a year that are over 10 GB".'),
      },
    },
    async ({ policy }) =>
      text(
        [
          `Create a Prunerr rule for this policy: "${policy}".`,
          '1. Call describe_rule_fields to get the exact fields and operators.',
          '2. Draft a v2 condition tree and call preview_rule to see how many items match and the space it would free. Show me a few sample matches.',
          '3. Adjust until the matches look right, then ask me to confirm the rule name, grace period and deletion action.',
          '4. Only after I confirm, call create_rule. Leave it enabled unless I say otherwise; the scheduled scan will apply it.',
        ].join('\n')
      )
  );

  server.registerPrompt(
    'health_check',
    {
      title: 'Health check',
      description: 'Check every connection and the scheduler, and explain anything that is wrong.',
    },
    async () =>
      text(
        [
          'Run a health check on my Prunerr install.',
          'Call get_system_health, list_scheduled_tasks and get_scan_status. Report which services are unreachable, when the last scan and library sync ran and whether they succeeded, and what to look at if something is off.',
        ].join('\n')
      )
  );
}
