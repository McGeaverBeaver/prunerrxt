import { useCallback, useMemo, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Bot, Check, ChevronDown, Copy, ShieldAlert } from 'lucide-react';

import { useMcpInfo, useUpdateMcp } from '@/hooks/useApi';
import { useToast } from '@/components/common/Toast';
import { cn } from '@/lib/utils';
import type { McpToolGroup, McpToolInfo } from '@/services/api';

import { PanelSection } from '../../components/PanelSection';
import { SettingsCard } from '../../components/SettingsCard';
import { SettingsEmptyState } from '../../components/SettingsEmptyState';
import { Toggle } from '../../components/Toggle';
import type { PanelProps } from '../../types';

const GROUP_ORDER: McpToolGroup[] = ['overview', 'library', 'actions', 'queue', 'rules', 'collections', 'scans', 'history', 'system'];

function CopyButton({ value, label }: { value: string; label: string }) {
  const { t } = useTranslation('settings');
  const { addToast } = useToast();
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      addToast({ type: 'error', title: t('toasts.copyFailed', 'Failed to copy to clipboard') });
    }
  }, [value, addToast, t]);

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={label}
      className={cn(
        'inline-flex min-h-[36px] shrink-0 items-center gap-1.5 rounded-[10px] border border-surface-600/80 px-2.5',
        'text-[11.5px] font-semibold text-surface-200 transition-colors hover:bg-surface-700/60 hover:text-surface-50',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60'
      )}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-text" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
      {copied ? t('mcp.copied', 'Copied') : t('mcp.copy', 'Copy')}
    </button>
  );
}

function Snippet({ title, code, hint }: { title: string; code: string; hint?: string }) {
  const { t } = useTranslation('settings');
  return (
    <div className="flex flex-col gap-2 rounded-xl bg-surface-800/45 px-3.5 py-3">
      <div className="flex items-center justify-between gap-3">
        <p className="font-display text-[12.5px] font-semibold text-surface-200">{title}</p>
        <CopyButton value={code} label={t('mcp.copySnippet', 'Copy {{title}} snippet', { title })} />
      </div>
      {hint && <p className="text-[11.5px] text-surface-400">{hint}</p>}
      <pre className="overflow-x-auto whitespace-pre rounded-lg border border-surface-700/50 bg-surface-900/50 px-3 py-2 font-mono text-[11px] leading-relaxed text-surface-300">
        {code}
      </pre>
    </div>
  );
}

/**
 * Settings → System → AI assistant (MCP). Status, the two switches, the
 * endpoint, ready-to-paste client configs and the tool catalogue.
 *
 * `apiKey` is the revealed key when the user has clicked "Reveal" in the API
 * key card above; snippets use a placeholder otherwise so the page never
 * shows the secret unasked.
 */
export function McpSection({ registerSection, apiKey }: { registerSection: PanelProps['registerSection']; apiKey: string | null }) {
  const { t } = useTranslation('settings');
  const { addToast } = useToast();
  const { data: info, isLoading, isError } = useMcpInfo();
  const update = useUpdateMcp();
  const [catalogOpen, setCatalogOpen] = useState(false);

  const keyForSnippets = apiKey ?? '<your-api-key>';
  const endpoint = info?.endpoint ?? `${window.location.origin}/mcp`;

  const snippets = useMemo(
    () => ({
      claudeCode: `claude mcp add --transport http prunerr ${endpoint} --header "Authorization: Bearer ${keyForSnippets}"`,
      json: JSON.stringify(
        {
          mcpServers: {
            prunerr: {
              url: endpoint,
              headers: { Authorization: `Bearer ${keyForSnippets}` },
            },
          },
        },
        null,
        2
      ),
      claudeDesktop: JSON.stringify(
        {
          mcpServers: {
            prunerr: {
              command: 'npx',
              args: ['-y', 'mcp-remote', endpoint, '--header', `Authorization: Bearer ${keyForSnippets}`],
            },
          },
        },
        null,
        2
      ),
    }),
    [endpoint, keyForSnippets]
  );

  const onToggle = useCallback(
    (body: { enabled?: boolean; allowImmediateDeletion?: boolean }) => {
      update.mutate(body, {
        onError: () => addToast({ type: 'error', title: t('mcp.updateFailed', 'Could not change that setting') }),
      });
    },
    [update, addToast, t]
  );

  const grouped = useMemo(() => {
    const map = new Map<McpToolGroup, McpToolInfo[]>();
    for (const tool of info?.tools ?? []) {
      const list = map.get(tool.group) ?? [];
      list.push(tool);
      map.set(tool.group, list);
    }
    return GROUP_ORDER.filter((g) => map.has(g)).map((g) => ({ group: g, tools: map.get(g)! }));
  }, [info?.tools]);

  const groupLabel = (group: McpToolGroup): string => {
    switch (group) {
      case 'overview':
        return t('mcp.groups.overview', 'Overview');
      case 'library':
        return t('mcp.groups.library', 'Library');
      case 'actions':
        return t('mcp.groups.actions', 'Item actions');
      case 'queue':
        return t('mcp.groups.queue', 'Deletion queue');
      case 'rules':
        return t('mcp.groups.rules', 'Rules');
      case 'collections':
        return t('mcp.groups.collections', 'Collections');
      case 'scans':
        return t('mcp.groups.scans', 'Scans & sync');
      case 'history':
        return t('mcp.groups.history', 'History & users');
      case 'system':
        return t('mcp.groups.system', 'System');
    }
  };

  const disabledReasonCopy =
    info?.disabledReason === 'auth_disabled'
      ? t(
          'mcp.offBecauseAuth',
          'Off because login is disabled. An AI connector on an install anyone on the network can open is one exposure too many, so set AUTH_ENABLED=true (see Login & access below) to turn it on.'
        )
      : info?.disabledReason === 'env'
        ? t('mcp.offBecauseEnv', 'Turned off for this container by MCP_ENABLED=false. This switch cannot override it.')
        : null;

  return (
    <PanelSection
      id="mcp"
      register={registerSection}
      title={t('nav.sub.mcp', 'AI assistant (MCP)')}
      description={t(
        'mcp.description',
        'Let Claude, Cursor or any Model Context Protocol client read your library, review the queue and build rules with you.'
      )}
    >
      <SettingsCard className="flex flex-col gap-3.5 px-[18px] py-4">
        {isError ? (
          <SettingsEmptyState
            title={t('mcp.unavailableTitle', 'MCP connector not available')}
            body={t('mcp.unavailableBody', 'This server does not expose the MCP connector.')}
          />
        ) : (
          <>
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="font-display text-[13.5px] font-semibold text-surface-50 flex items-center gap-2">
                  <Bot className="h-4 w-4 text-accent-text" aria-hidden />
                  {t('mcp.enableTitle', 'MCP connector')}
                </p>
                <p className="mt-0.5 text-[12.5px] leading-relaxed text-surface-400">
                  {t(
                    'mcp.enableBody',
                    'Serves the Model Context Protocol over HTTP at the endpoint below. Clients authenticate with your API key, and every call is logged in the activity log like a manual action.'
                  )}
                </p>
                {info && (
                  <p className="mt-1.5 text-[11.5px] text-surface-500">
                    {t('mcp.counts', '{{tools}} tools · {{resources}} resources · {{prompts}} prompts · {{sessions}} connected now', {
                      tools: info.tools.length,
                      resources: info.resources.length,
                      prompts: info.prompts.length,
                      sessions: info.activeSessions,
                    })}
                  </p>
                )}
              </div>
              <Toggle
                checked={Boolean(info?.enabled)}
                onChange={(enabled) => onToggle({ enabled })}
                disabled={isLoading || !info || info.disabledReason === 'auth_disabled' || info.disabledReason === 'env' || update.isPending}
                label={t('mcp.enableTitle', 'MCP connector')}
              />
            </div>

            {disabledReasonCopy && (
              <p className="rounded-xl border border-surface-700/80 bg-surface-800/50 px-3.5 py-3 text-xs text-surface-400">{disabledReasonCopy}</p>
            )}

            <div className="flex items-start justify-between gap-4 rounded-xl border border-surface-700/80 bg-surface-800/40 px-3.5 py-3">
              <div className="min-w-0">
                <p className="font-display text-[12.5px] font-semibold text-surface-100 flex items-center gap-2">
                  <ShieldAlert className="h-3.5 w-3.5 text-ruby-text" aria-hidden />
                  {t('mcp.immediateTitle', 'Allow immediate deletion')}
                </p>
                <p className="mt-0.5 text-[11.5px] leading-relaxed text-surface-400">
                  {t(
                    'mcp.immediateBody',
                    'Off by default. An assistant can always queue items (they wait out the grace period and can be removed from the queue), but "delete now" and processing the queue for real are refused unless this is on.'
                  )}
                </p>
              </div>
              <Toggle
                checked={Boolean(info?.allowImmediateDeletion)}
                onChange={(allowImmediateDeletion) => onToggle({ allowImmediateDeletion })}
                disabled={isLoading || !info || update.isPending}
                label={t('mcp.immediateTitle', 'Allow immediate deletion')}
              />
            </div>

            <div className="flex flex-col gap-2 rounded-xl bg-surface-800/45 px-3.5 py-3">
              <div className="flex items-center justify-between gap-3">
                <p className="font-display text-[12.5px] font-semibold text-surface-200">{t('mcp.endpoint', 'Endpoint')}</p>
                <CopyButton value={endpoint} label={t('mcp.copyEndpoint', 'Copy endpoint URL')} />
              </div>
              <code className="overflow-x-auto whitespace-nowrap rounded-lg border border-surface-700/50 bg-surface-900/50 px-3 py-2 font-mono text-[11.5px] text-surface-300">
                {endpoint}
              </code>
              <p className="text-[11.5px] text-surface-400">
                <Trans i18nKey="mcp.endpointHint" ns="settings">
                  Streamable HTTP transport. Send your API key as <code className="rounded bg-surface-700/50 px-1.5 py-0.5 font-mono text-[11px] text-accent-text">Authorization: Bearer</code> or <code className="rounded bg-surface-700/50 px-1.5 py-0.5 font-mono text-[11px] text-accent-text">X-Api-Key</code>. Reveal the key above to have it filled into the snippets.
                </Trans>
              </p>
            </div>

            <div className="flex flex-col gap-2 rounded-xl bg-surface-800/45 px-3.5 py-3">
              <p className="font-display text-[12.5px] font-semibold text-surface-200">
                {t('mcp.hostedTitle', 'Claude.ai and other hosted clients')}
              </p>
              <p className="text-[11.5px] text-surface-400">
                {t(
                  'mcp.hostedBody',
                  'Add the endpoint above as a custom connector. No key needed: the client registers itself, sends you to the Prunerr login, asks once for permission, and then acts as you with your role. Make sure Prunerr knows its public address (APP_URL, or X-Forwarded-Proto/Host from the proxy).'
                )}
              </p>
            </div>

            <Snippet
              title={t('mcp.snippetClaudeCode', 'Claude Code')}
              code={snippets.claudeCode}
              hint={t('mcp.snippetClaudeCodeHint', 'Run once in a terminal; adds Prunerr to your user-level MCP servers.')}
            />
            <Snippet
              title={t('mcp.snippetJson', 'Cursor, Windsurf, VS Code and other HTTP clients')}
              code={snippets.json}
              hint={t('mcp.snippetJsonHint', 'Paste into the client’s mcp.json (the key is usually "mcpServers" or "servers").')}
            />
            <Snippet
              title={t('mcp.snippetClaudeDesktop', 'Claude Desktop (via mcp-remote)')}
              code={snippets.claudeDesktop}
              hint={t('mcp.snippetClaudeDesktopHint', 'Claude Desktop only launches local commands; mcp-remote bridges it to the HTTP endpoint. Needs Node.js on that machine.')}
            />

            {info && info.tools.length > 0 && (
              <div className="rounded-xl border border-surface-700/80 bg-surface-800/40">
                <button
                  type="button"
                  onClick={() => setCatalogOpen((open) => !open)}
                  aria-expanded={catalogOpen}
                  className="flex w-full items-center justify-between gap-3 px-3.5 py-3 text-left"
                >
                  <span className="font-display text-[12.5px] font-semibold text-surface-200">
                    {t('mcp.catalogTitle', 'What the assistant can do ({{count}} tools)', { count: info.tools.length })}
                  </span>
                  <ChevronDown className={cn('h-4 w-4 text-surface-400 transition-transform', catalogOpen && 'rotate-180')} aria-hidden />
                </button>
                {catalogOpen && (
                  <div className="flex flex-col gap-4 border-t border-surface-700/60 px-3.5 py-3">
                    {grouped.map(({ group, tools }) => (
                      <div key={group} className="flex flex-col gap-1.5">
                        <p className="text-[11px] font-semibold uppercase tracking-wider text-surface-500">{groupLabel(group)}</p>
                        <ul className="flex flex-col gap-1.5">
                          {tools.map((tool) => (
                            <li key={tool.name} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[12px]">
                              <code className="font-mono text-[11px] text-accent-text">{tool.name}</code>
                              {tool.destructive && (
                                <span className="rounded bg-ruby-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ruby-text">
                                  {tool.requiresImmediateDeletion ? t('mcp.badgeImmediate', 'needs opt-in') : t('mcp.badgeDestructive', 'destructive')}
                                </span>
                              )}
                              {tool.readOnly && (
                                <span className="rounded bg-surface-700/60 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-surface-400">
                                  {t('mcp.badgeReadOnly', 'read-only')}
                                </span>
                              )}
                              <span className="basis-full text-surface-400">{tool.description}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </SettingsCard>
    </PanelSection>
  );
}
