import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import safeRegex from 'safe-regex';
import rulesRepo from '../../db/repositories/rules';
import mediaItemsRepo from '../../db/repositories/mediaItems';
import { logActivity } from '../../db/repositories/activity';
import { CreateRuleSchema, UpdateRuleSchema, type Rule, type UpdateRuleInput } from '../../types';
import { evaluateNode, evaluateRuleConditions, upgradeToV2 } from '../../rules/engine';
import { buildEvaluationContext } from '../../rules/context';
import { ruleScopeMatches } from '../../rules/scope';
import type { ConditionNode } from '../../rules/types';
import { queueItemForDeletion, notifyItemsQueued, type QueuedMatch } from '../../scheduler/tasks';
import { buildRuleSuggestions } from '../../services/ruleSuggestions';
import { formatBytes } from '../../utils/format';
import { RULE_SCHEMA_DOC } from '../ruleSchema';
import { MUTATING, READ_ONLY, clampLimit, defineTool, fail, ok, summarizeMediaItem } from '../helpers';

/** Reject catastrophic regexes anywhere in a condition tree. Returns the bad pattern or null. */
function findUnsafeRegex(node: unknown, depth = 0): string | null {
  if (!node || typeof node !== 'object') return null;
  if (depth > 40) throw new Error('Condition tree exceeds maximum nesting depth');
  const n = node as Record<string, unknown>;
  if (n['kind'] === 'condition') {
    if (n['operator'] === 'regex_match') {
      const pattern = String(n['value'] ?? '');
      if (!safeRegex(pattern)) return pattern;
    }
    return null;
  }
  if (n['kind'] === 'group' && Array.isArray(n['children'])) {
    for (const child of n['children'] as unknown[]) {
      const bad = findUnsafeRegex(child, depth + 1);
      if (bad) return bad;
    }
  }
  return null;
}

function toClientRule(rule: Rule) {
  let conditions: unknown;
  try {
    conditions = upgradeToV2(JSON.parse(rule.conditions));
  } catch {
    conditions = { version: 2, root: { kind: 'group', logic: 'AND', children: [] } };
  }
  return {
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled,
    mediaType: rule.media_type === 'show' ? 'tv' : rule.media_type || 'all',
    libraryKeys: rule.library_keys ?? [],
    action: rule.action,
    gracePeriodDays: rule.grace_period_days,
    deletionAction: rule.deletion_action,
    resetOverseerr: rule.reset_overseerr,
    priority: rule.priority,
    profileId: rule.profile_id,
    conditions,
    createdAt: rule.created_at,
    updatedAt: rule.updated_at,
  };
}

const ConditionLeaf: z.ZodType<unknown> = z.object({
  kind: z.literal('condition'),
  field: z.string().min(1),
  operator: z.string().min(1),
  value: z.unknown().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
});
const ConditionGroup: z.ZodType<unknown> = z.lazy(() =>
  z.object({
    kind: z.literal('group'),
    logic: z.enum(['AND', 'OR', 'NOT']),
    children: z.array(z.union([ConditionLeaf, ConditionGroup])),
  })
);
const ConditionNodeSchema = z.union([ConditionLeaf, ConditionGroup]).describe(
  'A v2 condition node: {"kind":"condition","field","operator","value"} or {"kind":"group","logic":"AND|OR|NOT","children":[...]}. See describe_rule_fields.'
);

const LegacyConditionSchema = z.object({
  field: z.string(),
  operator: z.string(),
  value: z.unknown(),
  params: z.record(z.string(), z.unknown()).optional(),
});

const RULE_INPUT = {
  name: z.string().min(1).max(120),
  mediaType: z.enum(['all', 'movie', 'tv']).optional().describe('Default all.'),
  libraryKeys: z.array(z.string().min(1)).max(100).optional().describe('Restrict to these media-server library keys (see list_libraries). Empty = all.'),
  action: z.enum(['delete', 'flag']).optional().describe('delete queues matches for deletion after the grace period; flag only marks them for review. Default delete.'),
  root: ConditionNodeSchema.optional().describe('The v2 condition tree root. Provide this OR conditions.'),
  conditions: z.array(LegacyConditionSchema).optional().describe('Legacy flat list of conditions, ANDed together. Prefer root.'),
  gracePeriodDays: z.number().int().min(0).max(365).optional(),
  deletionAction: z.enum(['unmonitor_only', 'delete_files_only', 'unmonitor_and_delete', 'full_removal']).optional(),
  resetOverseerr: z.boolean().optional(),
  enabled: z.boolean().optional().describe('Default true. Disabled rules are kept but never run.'),
  priority: z.number().int().min(0).max(100).optional(),
};

function conditionsPayload(args: { root?: unknown; conditions?: unknown[] }): unknown {
  if (args.root) return { version: 2, root: args.root };
  if (args.conditions) return args.conditions;
  return undefined;
}

export function registerRuleTools(server: McpServer): void {
  defineTool(
    server,
    {
      name: 'list_rules',
      title: 'List rules',
      description: 'All cleanup rules with their scope, action, grace period and full condition tree, highest priority first.',
      group: 'rules',
      inputSchema: { enabledOnly: z.boolean().optional() },
      annotations: READ_ONLY,
    },
    async ({ enabledOnly }) => {
      const rules = (enabledOnly ? rulesRepo.rules.getEnabled() : rulesRepo.rules.getAll()).map(toClientRule);
      return ok({ total: rules.length, rules }, `${rules.length} rule(s), ${rules.filter((r) => r.enabled).length} enabled.`);
    }
  );

  defineTool(
    server,
    {
      name: 'get_rule',
      title: 'Get a rule',
      description: 'One rule in full.',
      group: 'rules',
      inputSchema: { id: z.number().int().positive() },
      annotations: READ_ONLY,
    },
    async ({ id }) => {
      const rule = rulesRepo.rules.getById(id);
      if (!rule) return fail(`Rule ${id} not found`);
      return ok(toClientRule(rule));
    }
  );

  defineTool(
    server,
    {
      name: 'describe_rule_fields',
      title: 'Rule fields and operators reference',
      description:
        'Read this before writing a rule: every condition field with its type and valid operators, the deletion actions, and complete example rules in the exact JSON shape create_rule and preview_rule accept.',
      group: 'rules',
      annotations: READ_ONLY,
    },
    async () => ok(RULE_SCHEMA_DOC, RULE_SCHEMA_DOC.summary)
  );

  defineTool(
    server,
    {
      name: 'preview_rule',
      title: 'Preview a rule',
      description:
        'Dry-run a condition tree against the library before saving it: how many items would match, how many would be queued vs. skipped as protected, the space it would free, and a sample of the largest matches. Always preview before create_rule or run_rule.',
      group: 'rules',
      inputSchema: {
        mediaType: RULE_INPUT.mediaType,
        libraryKeys: RULE_INPUT.libraryKeys,
        root: RULE_INPUT.root,
        conditions: RULE_INPUT.conditions,
        sampleLimit: z.number().int().min(1).max(50).optional().describe('How many sample matches to include (default 10).'),
        sampleOffset: z.number().int().min(0).optional(),
      },
      annotations: READ_ONLY,
    },
    async (args) => {
      const payload = conditionsPayload(args);
      if (!payload) return fail('Provide root (v2 tree) or conditions (legacy list)');
      let v2: { version: 2; root: ConditionNode };
      try {
        v2 = upgradeToV2(payload) as { version: 2; root: ConditionNode };
      } catch (error) {
        return fail(`Invalid conditions: ${error instanceof Error ? error.message : String(error)}`);
      }
      const unsafe = findUnsafeRegex(v2.root);
      if (unsafe) return fail(`Unsafe regex pattern rejected: ${unsafe}`);

      const allItems = mediaItemsRepo.fetchAll({ excludeDeleted: true });
      const normalizedType = args.mediaType === 'tv' ? 'show' : args.mediaType;
      const typeFiltered = !normalizedType || normalizedType === 'all' ? allItems : allItems.filter((i) => i.type === normalizedType);
      const items =
        args.libraryKeys && args.libraryKeys.length > 0
          ? typeFiltered.filter((i) => i.library_key != null && args.libraryKeys!.includes(i.library_key))
          : typeFiltered;

      const ctx = buildEvaluationContext();
      const allMatching = items.filter((item) => evaluateNode(v2.root, item, ctx));
      const alreadyPending = allMatching.filter((i) => i.status === 'pending_deletion').length;
      const matching = allMatching.filter((i) => i.status !== 'pending_deletion');
      const wouldSkipProtected = matching.filter((i) => i.is_protected).length;
      const queueable = matching.filter((i) => !i.is_protected);
      const totalBytes = queueable.reduce((sum, i) => sum + (i.file_size || 0), 0);

      const sampleLimit = clampLimit(args.sampleLimit, 10, 50);
      const sampleOffset = args.sampleOffset ?? 0;
      const samples = [...queueable]
        .sort((a, b) => (b.file_size || 0) - (a.file_size || 0))
        .slice(sampleOffset, sampleOffset + sampleLimit)
        .map((i) => summarizeMediaItem(i));

      return ok(
        {
          evaluated: items.length,
          totalMatches: matching.length,
          wouldQueue: queueable.length,
          wouldSkipProtected,
          alreadyPending,
          reclaimable: formatBytes(totalBytes),
          reclaimableBytes: totalBytes,
          sampleTotal: queueable.length,
          sampleOffset,
          samples,
        },
        `${matching.length} match(es) of ${items.length} evaluated: ${queueable.length} would be queued (${formatBytes(totalBytes)}), ${wouldSkipProtected} protected would be skipped, ${alreadyPending} already in the queue.`
      );
    }
  );

  defineTool(
    server,
    {
      name: 'create_rule',
      title: 'Create a rule',
      description:
        'Save a new cleanup rule. Rules run on the scheduled scan (and via run_rule). A delete rule only queues matches — the grace period still applies and protected items are always skipped. Preview first and confirm the rule with the user.',
      group: 'rules',
      inputSchema: RULE_INPUT,
      annotations: MUTATING,
    },
    async (args) => {
      const payload = conditionsPayload(args);
      if (!payload) return fail('Provide root (v2 tree) or conditions (legacy list)');
      const unsafe = findUnsafeRegex(args.root ?? { kind: 'group', logic: 'AND', children: (args.conditions ?? []).map((c) => ({ kind: 'condition', ...c })) });
      if (unsafe) return fail(`Unsafe regex pattern rejected: ${unsafe}`);

      const parsed = CreateRuleSchema.safeParse({
        name: args.name,
        type: 'custom',
        mediaType: args.mediaType ?? 'all',
        libraryKeys: args.libraryKeys ?? null,
        conditions: payload,
        action: args.action ?? 'delete',
        enabled: args.enabled ?? true,
        gracePeriodDays: args.gracePeriodDays,
        deletionAction: args.deletionAction,
        resetOverseerr: args.resetOverseerr,
        priority: args.priority ?? 0,
      });
      if (!parsed.success) return fail(`Invalid rule: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);

      const rule = rulesRepo.rules.create(parsed.data);
      return ok(toClientRule(rule), `Created rule #${rule.id} "${rule.name}" (${rule.enabled ? 'enabled' : 'disabled'}).`);
    }
  );

  defineTool(
    server,
    {
      name: 'update_rule',
      title: 'Update a rule',
      description: 'Change any part of an existing rule. Only the fields provided are changed. Providing root or conditions replaces the whole condition tree.',
      group: 'rules',
      inputSchema: {
        id: z.number().int().positive(),
        ...Object.fromEntries(Object.entries(RULE_INPUT).map(([k, v]) => [k, (v as z.ZodTypeAny).optional()])),
      } as { id: z.ZodNumber } & { [K in keyof typeof RULE_INPUT]: z.ZodOptional<z.ZodTypeAny> },
      annotations: MUTATING,
    },
    async (args) => {
      const existing = rulesRepo.rules.getById(args.id);
      if (!existing) return fail(`Rule ${args.id} not found`);

      const payload = conditionsPayload(args as { root?: unknown; conditions?: unknown[] });
      if (payload) {
        const unsafe = findUnsafeRegex((payload as { root?: unknown }).root ?? { kind: 'group', logic: 'AND', children: (payload as unknown[]).map((c) => ({ kind: 'condition', ...(c as object) })) });
        if (unsafe) return fail(`Unsafe regex pattern rejected: ${unsafe}`);
      }

      const parsed = UpdateRuleSchema.safeParse({
        ...(args.name !== undefined ? { name: args.name } : {}),
        ...(args.mediaType !== undefined ? { mediaType: args.mediaType } : {}),
        ...(args.libraryKeys !== undefined ? { libraryKeys: args.libraryKeys } : {}),
        ...(payload !== undefined ? { conditions: payload } : {}),
        ...(args.action !== undefined ? { action: args.action } : {}),
        ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
        ...(args.gracePeriodDays !== undefined ? { gracePeriodDays: args.gracePeriodDays } : {}),
        ...(args.deletionAction !== undefined ? { deletionAction: args.deletionAction } : {}),
        ...(args.resetOverseerr !== undefined ? { resetOverseerr: args.resetOverseerr } : {}),
        ...(args.priority !== undefined ? { priority: args.priority } : {}),
      });
      if (!parsed.success) return fail(`Invalid rule: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);

      const rule = rulesRepo.rules.update(args.id, parsed.data as UpdateRuleInput);
      if (!rule) return fail(`Rule ${args.id} not found`);
      return ok(toClientRule(rule), `Updated rule #${rule.id} "${rule.name}".`);
    }
  );

  defineTool(
    server,
    {
      name: 'set_rule_enabled',
      title: 'Enable or disable a rule',
      description: 'Turn a rule on or off without changing it. Disabled rules are skipped by scans.',
      group: 'rules',
      inputSchema: { id: z.number().int().positive(), enabled: z.boolean() },
      annotations: MUTATING,
    },
    async ({ id, enabled }) => {
      const rule = rulesRepo.rules.update(id, { enabled });
      if (!rule) return fail(`Rule ${id} not found`);
      return ok(toClientRule(rule), `Rule "${rule.name}" ${enabled ? 'enabled' : 'disabled'}.`);
    }
  );

  defineTool(
    server,
    {
      name: 'delete_rule',
      title: 'Delete a rule',
      description: 'Permanently delete a rule. Items it already queued stay in the queue. Confirm with the user first.',
      group: 'rules',
      inputSchema: { id: z.number().int().positive() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ id }) => {
      const rule = rulesRepo.rules.getById(id);
      if (!rule) return fail(`Rule ${id} not found`);
      rulesRepo.rules.delete(id);
      return ok({ id, name: rule.name, deleted: true }, `Deleted rule "${rule.name}".`);
    }
  );

  defineTool(
    server,
    {
      name: 'run_rule',
      title: 'Run a rule now',
      description:
        'Evaluate one rule against the whole library right now and apply its action: a delete rule queues every match for deletion after its grace period (nothing is deleted immediately); a flag rule marks matches. Protected items are skipped. Works on disabled rules too. Preview first.',
      group: 'rules',
      inputSchema: { id: z.number().int().positive() },
      annotations: MUTATING,
    },
    async ({ id }) => {
      const rule = rulesRepo.rules.getById(id);
      if (!rule) return fail(`Rule ${id} not found`);

      const mediaItems = mediaItemsRepo.fetchAll({ excludeDeleted: true });
      const inScope = mediaItems.filter((item) => ruleScopeMatches(rule, item));
      const ctx = buildEvaluationContext();
      const matching = inScope.filter((item) => {
        if (item.is_protected) return false;
        try {
          return evaluateRuleConditions(rule.conditions, item, ctx);
        } catch {
          return false;
        }
      });

      const markedAt = new Date().toISOString();
      const queuedMatches: QueuedMatch[] = [];
      const results: Array<{ id: number; title: string; action: string }> = [];
      let failed = 0;

      for (const item of matching) {
        try {
          if (rule.action === 'delete') {
            const { deleteAfter } = queueItemForDeletion(item, rule);
            queuedMatches.push({ item, rule, deleteAfter });
            results.push({ id: item.id, title: item.title, action: 'queued' });
          } else if (rule.action === 'flag') {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            mediaItemsRepo.update(item.id, { status: 'flagged', marked_at: markedAt, matched_rule_id: rule.id } as any);
            logActivity({
              eventType: 'rule_match',
              action: 'item_flagged',
              actorType: 'rule',
              actorId: String(rule.id),
              actorName: rule.name,
              targetType: 'media_item',
              targetId: item.id,
              targetTitle: item.title,
            });
            results.push({ id: item.id, title: item.title, action: 'flagged' });
          } else {
            results.push({ id: item.id, title: item.title, action: 'notified' });
          }
        } catch {
          failed++;
        }
      }

      await notifyItemsQueued(queuedMatches);

      return ok(
        {
          rule: { id: rule.id, name: rule.name, action: rule.action },
          summary: { scanned: inScope.length, matched: matching.length, processed: results.length, failed },
          results: results.slice(0, 200),
        },
        `Rule "${rule.name}": ${matching.length} match(es) of ${inScope.length} in scope; ${results.length} ${rule.action === 'delete' ? 'queued for deletion' : 'flagged'}, ${failed} failed.`
      );
    }
  );

  defineTool(
    server,
    {
      name: 'get_rule_suggestions',
      title: 'Suggested rules',
      description:
        'Ready-made rule ideas computed from this library (never watched, watched once, large files, stale content, low quality, …) with how many items each would match and the space it would free. Each comes with legacy-format conditions you can pass straight to preview_rule or create_rule.',
      group: 'rules',
      annotations: READ_ONLY,
    },
    async () => {
      const result = buildRuleSuggestions();
      const top = result.suggestions.slice(0, 3).map((s) => `${s.name} (${s.matchCount}, ${s.totalSizeFormatted})`);
      return ok(result, `${result.suggestions.length} suggestion(s). Biggest: ${top.join('; ') || 'none'}.`);
    }
  );

  // --- Profiles -------------------------------------------------------------

  defineTool(
    server,
    {
      name: 'list_profiles',
      title: 'List rule profiles',
      description: 'Rule profiles group rules; one profile is active at a time.',
      group: 'rules',
      annotations: READ_ONLY,
    },
    async () => {
      const profiles = rulesRepo.profiles.getAll();
      return ok({ profiles }, `${profiles.length} profile(s), active: ${profiles.find((p) => p.is_active)?.name ?? 'none'}.`);
    }
  );

  defineTool(
    server,
    {
      name: 'activate_profile',
      title: 'Activate a rule profile',
      description: 'Make a profile the active one.',
      group: 'rules',
      inputSchema: { id: z.number().int().positive() },
      annotations: MUTATING,
    },
    async ({ id }) => {
      const profile = rulesRepo.profiles.setActive(id);
      if (!profile) return fail(`Profile ${id} not found`);
      return ok(profile, `Profile "${profile.name}" is now active.`);
    }
  );
}
