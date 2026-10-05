import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { EXTERNAL_READ, defineTool, fail, ok } from '../helpers';
import { acknowledge, unacknowledge } from '../../services/insights/acknowledgements';
import { getStackHealth } from '../../services/insights/stackHealth';
import { getLibraryQuality } from '../../services/insights/libraryQuality';
import { getWatchPatterns } from '../../services/insights/watchPatterns';
import { getPlaybackFriction } from '../../services/insights/playbackFriction';
import { getInsightHistory } from '../../services/insights/snapshots';

const SECTIONS = ['stack', 'library', 'watching', 'playback', 'all'] as const;

/**
 * The Insights page for an assistant: the same four reports the UI renders,
 * so "how is my server doing?" has a real answer with the findings, their
 * severity and what to do about each.
 */
export function registerInsightTools(server: McpServer): void {
  defineTool(
    server,
    {
      name: 'get_insights',
      title: 'Insights: stack health, library quality, watch patterns, playback friction',
      description:
        'How the whole setup is doing. "stack": every problem across PrunerrXT, the media server, Sonarr, Radarr and the watch history provider, with severity and next step. "library": resolution and codec mix, HDR, items below their quality cutoff, low-resolution titles nobody played. "watching": plays per week, viewers, most played titles, never-played and quiet share of the library. "playback": transcode rate by client and title, abandoned plays (Tautulli only). "all" returns the four together. Pass refresh=true to bypass the one-to-five-minute caches.',
      group: 'overview',
      inputSchema: {
        section: z.enum(SECTIONS).default('all').describe('Which block to read; "all" for every block.'),
        refresh: z.boolean().default(false).describe('Re-query the connected apps instead of using the cached report.'),
      },
      annotations: EXTERNAL_READ,
    },
    async ({ section, refresh }) => {
      const opts = { refresh };
      if (section === 'stack') {
        const stack = await getStackHealth(opts);
        return ok(stack, summariseStack(stack));
      }
      if (section === 'library') {
        const library = await getLibraryQuality(opts);
        return ok(library, `${library.totals.items} titles; ${library.items.length} finding(s).`);
      }
      if (section === 'watching') {
        const watching = await getWatchPatterns(opts);
        return ok(watching, `${watching.last30.plays} plays by ${watching.last30.users} viewers in the last 30 days (${watching.provider}); ${watching.items.length} finding(s).`);
      }
      if (section === 'playback') {
        const playback = await getPlaybackFriction(opts);
        return ok(playback, playback.available ? `${playback.decisions.total} plays, ${playback.decisions.transcode} transcoded; ${playback.items.length} finding(s).` : playback.note ?? 'Not available.');
      }
      const [stack, library, watching, playback] = await Promise.all([getStackHealth(opts), getLibraryQuality(opts), getWatchPatterns(opts), getPlaybackFriction(opts)]);
      const findings = stack.items.length + library.items.length + watching.items.length + playback.items.length;
      return ok({ stack, library, watching, playback }, `${summariseStack(stack)} ${findings} finding(s) across the four blocks.`);
    }
  );

  defineTool(
    server,
    {
      name: 'acknowledge_insight',
      title: 'Acknowledge a stack-health finding',
      description:
        'Hide one stack-health finding (by its id from get_insights) from the counts until it is unacknowledged or escalates to a higher severity. For findings that are true but accepted, such as "Allowed Hosts is not configured" on a LAN-only install. Pass undo=true to bring it back.',
      group: 'overview',
      inputSchema: {
        id: z.string().min(1).describe('The finding id, e.g. sonarr.health.AllowedHostsCheck'),
        undo: z.boolean().default(false).describe('true to unacknowledge'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id, undo }) => {
      if (undo) {
        unacknowledge(id);
        const stack = await getStackHealth();
        return ok({ id, acknowledged: false, stack: { overall: stack.overall, counts: stack.counts, acknowledgedCount: stack.acknowledgedCount } }, `Unacknowledged ${id}. ${summariseStack(stack)}`);
      }
      const current = await getStackHealth();
      const item = current.items.find((i) => i.id === id);
      if (!item) return fail(`No current finding with id ${id}. Call get_insights with section "stack" for the ids.`);
      acknowledge(item);
      const stack = await getStackHealth();
      return ok({ id, acknowledged: true, stack: { overall: stack.overall, counts: stack.counts, acknowledgedCount: stack.acknowledgedCount } }, `Acknowledged "${item.title}". ${summariseStack(stack)}`);
    }
  );

  defineTool(
    server,
    {
      name: 'get_insight_trends',
      title: 'Insight trends',
      description:
        'One row per day of the Insights numbers (stack problems, library size and SD count, never-played share, plays and viewers in the trailing 30 days, transcode rate), for reading how things move over time after rules run or settings change.',
      group: 'overview',
      inputSchema: { days: z.number().int().min(1).max(365).default(90) },
      annotations: EXTERNAL_READ,
    },
    async ({ days }) => {
      const rows = getInsightHistory(days);
      return ok({ days, rows }, `${rows.length} daily snapshot(s) in the last ${days} days.`);
    }
  );
}

function summariseStack(stack: Awaited<ReturnType<typeof getStackHealth>>): string {
  const acked = stack.acknowledgedCount > 0 ? ` ${stack.acknowledgedCount} acknowledged.` : '';
  if (stack.items.length - stack.acknowledgedCount === 0) return `Stack: nothing needs attention.${acked}`;
  return `Stack: ${stack.counts.critical} critical, ${stack.counts.warning} warning, ${stack.counts.info} info.${acked}`;
}
