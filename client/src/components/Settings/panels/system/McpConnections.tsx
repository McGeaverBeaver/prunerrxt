import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { KeyRound, Link2, Link2Off, Loader2, Radio, Trash2 } from 'lucide-react';

import { Badge } from '@/components/common/Badge';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import { useToast } from '@/components/common/Toast';
import { useForgetMcpClient, useMcpConnections, useRevokeMcpConnection } from '@/hooks/useApi';
import { formatRelativeTime } from '@/lib/utils';
import type { McpGrant } from '@/services/api';

/**
 * Settings → System → AI assistant: who is connected. OAuth grants grouped by
 * the client that registered (claude.ai, Claude Desktop, …), each with the
 * user it acts as, when it was approved, when it was last used and whether a
 * session is open right now; Disconnect revokes one grant, Forget drops the
 * client and everything it holds. Key-based clients are listed from the API
 * key's usage log: they hold no token, so the key card is where they are
 * cut off.
 */
export function McpConnections({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation('settings');
  const { addToast } = useToast();
  const { data, isLoading } = useMcpConnections(enabled);
  const revoke = useRevokeMcpConnection();
  const forget = useForgetMcpClient();
  const [confirmForget, setConfirmForget] = useState<{ clientId: string; name: string; grants: number } | null>(null);

  const byClient = useMemo(() => {
    const map = new Map<string, { clientId: string; name: string; grants: McpGrant[] }>();
    for (const g of data?.grants ?? []) {
      const entry = map.get(g.clientId) ?? { clientId: g.clientId, name: g.clientName ?? t('mcp.connections.unnamed', 'Unnamed client'), grants: [] };
      entry.grants.push(g);
      map.set(g.clientId, entry);
    }
    return [...map.values()];
  }, [data?.grants, t]);

  const roleLabel = (role: McpGrant['role']): string =>
    role === 'admin' ? t('login.roles.admin', 'Administrator') : role === 'operator' ? t('login.roles.operator', 'Operator') : t('login.roles.viewer', 'Viewer');

  const keySessions = (data?.sessions ?? []).filter((s) => s.kind === 'apiKey');
  const nothing = !isLoading && byClient.length === 0 && (data?.apiKey.clients.length ?? 0) === 0 && keySessions.length === 0;

  const onRevoke = (g: McpGrant) =>
    revoke.mutate(g.pairId, {
      onSuccess: (r) =>
        addToast({
          type: 'success',
          title: t('mcp.connections.revokedTitle', 'Disconnected'),
          message: t('mcp.connections.revokedMsg', '{{client}} no longer acts as {{user}}. It will have to ask for permission again.', { client: g.clientName ?? g.clientId, user: g.username, count: r.sessionsClosed }),
        }),
      onError: (err) => addToast({ type: 'error', title: t('mcp.connections.revokeFailed', 'Could not disconnect'), message: err instanceof Error ? err.message : String(err) }),
    });

  const onForget = () => {
    if (!confirmForget) return;
    forget.mutate(confirmForget.clientId, {
      onSuccess: () => {
        addToast({ type: 'success', title: t('mcp.connections.forgottenTitle', 'Client forgotten'), message: t('mcp.connections.forgottenMsg', '{{client}} and every permission it held are gone.', { client: confirmForget.name }) });
        setConfirmForget(null);
      },
      onError: (err) => addToast({ type: 'error', title: t('mcp.connections.forgetFailed', 'Could not forget client'), message: err instanceof Error ? err.message : String(err) }),
    });
  };

  return (
    <div className="flex flex-col gap-2 rounded-xl bg-surface-800/45 px-3.5 py-3">
      <div className="flex items-center justify-between gap-3">
        <p className="font-display text-[12.5px] font-semibold text-surface-200 flex items-center gap-2">
          <Link2 className="h-3.5 w-3.5 text-accent-text" aria-hidden />
          {t('mcp.connections.title', 'Connected clients')}
        </p>
        {data && (
          <span className="text-[11px] text-surface-500">
            {t('mcp.connections.liveCount', '{{count}} session(s) open now', { count: data.sessions.length })}
          </span>
        )}
      </div>
      <p className="text-[11.5px] text-surface-400">
        {t('mcp.connections.body', 'Every assistant that may act on this library. Disconnect one and it is signed out at once and must ask for permission again; forget a client to drop its registration too.')}
      </p>

      {!enabled ? (
        <p className="text-[11.5px] text-surface-500">{t('mcp.connections.off', 'The connector is off, so nothing can connect.')}</p>
      ) : isLoading ? (
        <p className="text-[11.5px] text-surface-500">{t('mcp.connections.loading', 'Loading…')}</p>
      ) : nothing ? (
        <p className="text-[11.5px] text-surface-500">{t('mcp.connections.empty', 'Nothing is connected yet. Clients appear here after they sign in or use the API key at the endpoint below.')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {byClient.map((client) => (
            <li key={client.clientId} className="rounded-lg border border-surface-700/60 bg-surface-900/40 px-3 py-2.5">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 flex items-center gap-2">
                  <span className="truncate text-[12.5px] font-semibold text-surface-50">{client.name}</span>
                  <Badge variant="muted" size="sm">{t('mcp.connections.oauth', 'signed in')}</Badge>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={forget.isPending}
                  onClick={() => setConfirmForget({ clientId: client.clientId, name: client.name, grants: client.grants.length })}
                  title={t('mcp.connections.forget', 'Forget this client')}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
              <ul className="mt-1.5 divide-y divide-surface-800">
                {client.grants.map((g) => (
                  <li key={g.pairId} className="flex items-center gap-3 py-1.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap text-[12px]">
                        <span className="font-medium text-surface-100">{g.username}</span>
                        <Badge variant={g.role === 'admin' ? 'accent' : g.role === 'operator' ? 'emerald' : 'muted'} size="sm">{roleLabel(g.role)}</Badge>
                        {g.live && (
                          <Badge variant="success" size="sm">
                            <Radio className="mr-1 inline h-3 w-3" aria-hidden />
                            {t('mcp.connections.live', 'live')}
                          </Badge>
                        )}
                      </div>
                      <p className="text-[11px] text-surface-500 mt-0.5">
                        {t('mcp.connections.granted', 'approved {{time}}', { time: formatRelativeTime(g.grantedAt) })}
                        {' · '}
                        {g.lastUsedAt
                          ? t('mcp.connections.lastUsed', 'last used {{time}}', { time: formatRelativeTime(g.lastUsedAt) })
                          : t('mcp.connections.neverUsed', 'never used')}
                        {' · '}
                        {t('mcp.connections.expires', 'expires {{time}}', { time: formatRelativeTime(g.refreshExpiresAt) })}
                      </p>
                    </div>
                    <Button variant="secondary" size="sm" disabled={revoke.isPending} onClick={() => onRevoke(g)} title={t('mcp.connections.disconnectTitle', 'Sign this client out and withdraw its permission')}>
                      {revoke.isPending && revoke.variables === g.pairId ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Link2Off className="h-3.5 w-3.5" />}
                      <span className="ml-1.5">{t('mcp.connections.disconnect', 'Disconnect')}</span>
                    </Button>
                  </li>
                ))}
              </ul>
            </li>
          ))}

          {(data?.apiKey.clients.length ?? 0) + keySessions.length > 0 && (
            <li className="rounded-lg border border-surface-700/60 bg-surface-900/40 px-3 py-2.5">
              <div className="flex items-center gap-2">
                <KeyRound className="h-3.5 w-3.5 text-surface-300" aria-hidden />
                <span className="text-[12.5px] font-semibold text-surface-50">{t('mcp.connections.apiKeyTitle', 'Using the API key')}</span>
                {keySessions.length > 0 && (
                  <Badge variant="success" size="sm">
                    <Radio className="mr-1 inline h-3 w-3" aria-hidden />
                    {t('mcp.connections.liveN', '{{count}} live', { count: keySessions.length })}
                  </Badge>
                )}
              </div>
              <ul className="mt-1.5 divide-y divide-surface-800">
                {(data?.apiKey.clients ?? []).map((c, i) => (
                  <li key={`${c.userAgent ?? ''}|${c.ip ?? ''}|${i}`} className="py-1.5 text-[11.5px]">
                    <span className="text-surface-200">{c.userAgent ?? t('mcp.connections.unknownAgent', 'Unknown client')}</span>
                    <span className="text-surface-500">
                      {c.ip ? ` · ${c.ip}` : ''} · {t('mcp.connections.requests', '{{count}} request(s)', { count: c.requests })} · {t('mcp.connections.lastUsed', 'last used {{time}}', { time: formatRelativeTime(c.lastUsedAt) })}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-[11px] text-surface-500">
                {t('mcp.connections.apiKeyHint', 'Key-based clients hold no token to revoke. Switch the key off or regenerate it in the API key card above to cut them off.')}
              </p>
            </li>
          )}
        </ul>
      )}

      <Modal isOpen={Boolean(confirmForget)} onClose={() => !forget.isPending && setConfirmForget(null)} title={t('mcp.connections.forgetTitle', 'Forget this client?')}>
        <div className="space-y-4">
          <p className="text-sm text-surface-200">
            {t('mcp.connections.forgetBody', '{{client}} will be signed out everywhere, its {{count}} permission(s) withdrawn, and its registration removed. It can register again from scratch and will ask you to approve it anew.', {
              client: confirmForget?.name ?? '',
              count: confirmForget?.grants ?? 0,
            })}
          </p>
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="secondary" onClick={() => setConfirmForget(null)} disabled={forget.isPending}>
              {t('actions.cancel', 'Cancel')}
            </Button>
            <Button variant="danger" onClick={onForget} disabled={forget.isPending}>
              {forget.isPending ? t('mcp.connections.forgetting', 'Forgetting…') : t('mcp.connections.forget', 'Forget this client')}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
