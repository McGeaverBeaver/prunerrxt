import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { KeyRound, LogOut, UserRound, Users } from 'lucide-react';

import { Badge } from '@/components/common/Badge';
import { Button } from '@/components/common/Button';
import { useToast } from '@/components/common/Toast';
import { useAuthSettings, useLoginSessions, useRevokeSession } from '@/hooks/useApi';
import { formatRelativeTime } from '@/lib/utils';

import { PanelSection } from '../../components/PanelSection';
import { SettingsCard } from '../../components/SettingsCard';
import { SettingsEmptyState } from '../../components/SettingsEmptyState';
import type { PanelProps } from '../../types';

/**
 * Settings → System → Users & sessions: who is signed in right now, with
 * what role, since when, and a way to sign any of them out. Roles come from
 * the identity provider's groups (or the local account), so there is nothing
 * to edit here; the audit log has every login.
 */
export function SessionsSection({ registerSection }: { registerSection: PanelProps['registerSection'] }) {
  const { t } = useTranslation('settings');
  const { addToast } = useToast();
  const { data: info } = useAuthSettings();
  const enabled = Boolean(info?.enabled);
  const { data: sessions, isLoading } = useLoginSessions(enabled);
  const revoke = useRevokeSession();

  const roleLabel = (role: string): string =>
    role === 'admin' ? t('login.roles.admin', 'Administrator') : role === 'operator' ? t('login.roles.operator', 'Operator') : t('login.roles.viewer', 'Viewer');

  return (
    <PanelSection
      id="sessions"
      register={registerSection}
      title={t('sessions.title', 'Users & sessions')}
      description={t('sessions.description', 'Everyone signed in right now. Roles come from your identity provider; every login and sign-out is in the audit log.')}
      action={
        <Link to="/audit?kind=auth." className="btn-ghost inline-flex items-center gap-1.5 px-3 py-2 text-sm">
          {t('sessions.auditLink', 'Login history')}
        </Link>
      }
    >
      <SettingsCard className="p-4">
        {!enabled ? (
          <SettingsEmptyState title={t('sessions.disabledTitle', 'Login is off')} body={t('sessions.disabledBody', 'With login disabled there are no users or sessions to show. Set AUTH_ENABLED=true to turn it on.')} />
        ) : isLoading ? (
          <p className="text-[12.5px] text-surface-400">{t('sessions.loading', 'Loading…')}</p>
        ) : !sessions || sessions.length === 0 ? (
          <SettingsEmptyState title={t('sessions.emptyTitle', 'Nobody is signed in')} body={t('sessions.emptyBody', 'Sessions appear here as people sign in.')} />
        ) : (
          <ul className="divide-y divide-surface-800">
            {sessions.map((s) => (
              <li key={s.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-800">
                  {s.provider === 'local' ? <KeyRound className="h-4 w-4 text-surface-300" /> : <UserRound className="h-4 w-4 text-surface-300" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[13px] font-medium text-surface-50">{s.displayName || s.username}</span>
                    <Badge variant={s.role === 'admin' ? 'accent' : s.role === 'operator' ? 'emerald' : 'muted'} size="sm">{roleLabel(s.role)}</Badge>
                    <Badge variant="muted" size="sm">{s.provider === 'oidc' ? t('sessions.sso', 'SSO') : t('sessions.local', 'local')}</Badge>
                    {s.current && <Badge variant="success" size="sm">{t('sessions.you', 'you')}</Badge>}
                  </div>
                  <p className="text-[11.5px] text-surface-500 mt-0.5">
                    {s.email ? `${s.email} · ` : ''}
                    {t('sessions.signedIn', 'signed in {{time}}', { time: formatRelativeTime(s.createdAt) })} · {t('sessions.lastSeen', 'active {{time}}', { time: formatRelativeTime(s.lastSeenAt) })}
                    {s.groups.length > 0 ? ` · ${s.groups.join(', ')}` : ''}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={revoke.isPending}
                  onClick={() =>
                    revoke.mutate(s.id, {
                      onSuccess: () => addToast({ type: 'success', title: t('sessions.revokedTitle', 'Signed out'), message: t('sessions.revokedMsg', '{{name}} has been signed out.', { name: s.displayName || s.username }) }),
                      onError: (err) => addToast({ type: 'error', title: t('sessions.revokeFailed', 'Could not sign out'), message: err instanceof Error ? err.message : String(err) }),
                    })
                  }
                  title={s.current ? t('sessions.signOutSelf', 'Sign yourself out') : t('sessions.signOut', 'Sign this session out')}
                >
                  <LogOut className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 flex items-center gap-1.5 text-[11.5px] text-surface-500">
          <Users className="h-3.5 w-3.5" />
          {t('sessions.footnote', 'To change who may sign in or their role, change the groups in your identity provider or the AUTH_* environment variables.')}
        </p>
      </SettingsCard>
    </PanelSection>
  );
}
