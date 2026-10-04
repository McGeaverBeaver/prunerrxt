import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { EXTERNAL_READ, defineTool, ok } from '../helpers';
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
        'How the whole setup is doing. "stack": every problem across Prunerr, the media server, Sonarr, Radarr and the watch history provider, with severity and next step. "library": resolution and codec mix, HDR, items below their quality cutoff, low-resolution titles nobody played. "watching": plays per week, viewers, most played titles, never-played and quiet share of the library. "playback": transcode rate by client and title, abandoned plays (Tautulli only). "all" returns the four together. Pass refresh=true to bypass the one-to-five-minute caches.',
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
  if (stack.items.length === 0) return 'Stack: nothing needs attention.';
  return `Stack: ${stack.counts.critical} critical, ${stack.counts.warning} warning, ${stack.counts.info} info.`;
}
