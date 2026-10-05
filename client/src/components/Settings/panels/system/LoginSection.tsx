import { useTranslation } from 'react-i18next';
import { CheckCircle2, CircleAlert, KeyRound, LockOpen, ShieldCheck } from 'lucide-react';

import { useAuthSettings } from '@/hooks/useApi';
import { cn } from '@/lib/utils';
import type { AuthRole } from '@/services/api';

import { PanelSection } from '../../components/PanelSection';
import { SettingsCard } from '../../components/SettingsCard';
import type { PanelProps } from '../../types';

function Row({ label, children, mono = false }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-4">
      <dt className="shrink-0 text-[11.5px] font-semibold uppercase tracking-wide text-surface-500 sm:w-40">{label}</dt>
      <dd className={cn('min-w-0 break-all text-[12.5px] text-surface-200', mono && 'font-mono text-[11.5px]')}>{children}</dd>
    </div>
  );
}

function GroupList({ groups }: { groups: string[] }) {
  const { t } = useTranslation('settings');
  if (groups.length === 0) return <span className="text-surface-500">{t('login.none', 'none')}</span>;
  return (
    <span className="flex flex-wrap gap-1.5">
      {groups.map((g) => (
        <code key={g} className="rounded bg-surface-700/50 px-1.5 py-0.5 font-mono text-[11px] text-surface-200">
          {g}
        </code>
      ))}
    </span>
  );
}

const ENV_EXAMPLE = `AUTH_ENABLED=true
OIDC_ISSUER_URL=https://auth.example.com/application/o/prunerr/
OIDC_CLIENT_ID=...
OIDC_CLIENT_SECRET=...
OIDC_ADMIN_GROUPS=prunerr-admins
OIDC_OPERATOR_GROUPS=media-ops
OIDC_VIEWER_GROUPS=family
# optional fallback account
AUTH_LOCAL_ENABLED=true
AUTH_LOCAL_USERNAME=admin
AUTH_LOCAL_PASSWORD_HASH=scrypt$...   # node scripts/hash-password.mjs`;

/**
 * Settings → System → Login & access. Read-only: everything here comes from
 * the container environment, so this card explains what is in force and
 * what to change where.
 */
export function LoginSection({ registerSection }: { registerSection: PanelProps['registerSection'] }) {
  const { t } = useTranslation('settings');
  const { data: info, isLoading } = useAuthSettings();

  const roleLabel = (role: AuthRole | 'none'): string => {
    switch (role) {
      case 'admin':
        return t('login.roles.admin', 'Administrator');
      case 'operator':
        return t('login.roles.operator', 'Operator');
      case 'viewer':
        return t('login.roles.viewer', 'Viewer');
      default:
        return t('login.roles.none', 'No access');
    }
  };

  return (
    <PanelSection
      id="login"
      register={registerSection}
      title={t('nav.sub.login', 'Login & access')}
      description={t('login.description', 'Who can open PrunerrXT, and what each role may do. Configured by environment variables.')}
    >
      <SettingsCard className="flex flex-col gap-3.5 px-[18px] py-4">
        {isLoading || !info ? (
          <p className="text-[12.5px] text-surface-400">{t('login.loading', 'Loading…')}</p>
        ) : (
          <>
            <div className="flex items-start gap-3">
              {info.enabled ? (
                <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-text" aria-hidden />
              ) : (
                <LockOpen className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" aria-hidden />
              )}
              <div className="min-w-0">
                <p className="font-display text-[13.5px] font-semibold text-surface-50">
                  {info.enabled ? t('login.enabledTitle', 'Login required') : t('login.disabledTitle', 'Login disabled')}
                </p>
                <p className="mt-0.5 text-[12.5px] leading-relaxed text-surface-400">
                  {info.enabled
                    ? t('login.enabledBody', 'Every page and API call needs a signed-in user or the API key. Sessions last {{hours}} hours; {{sessions}} active now.', {
                        hours: info.sessionTtlHours,
                        sessions: info.activeSessions,
                      })
                    : t(
                        'login.disabledBody',
                        'Anyone who can reach this address can use PrunerrXT, and the MCP connector stays off. Fine on a trusted LAN or behind a reverse proxy that handles login; set AUTH_ENABLED=true to turn on single sign-on or a local account.'
                      )}
                </p>
              </div>
            </div>

            {info.warnings.length > 0 && (
              <ul className="flex flex-col gap-1.5 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-3 text-xs text-amber-200">
                {info.warnings.map((warning) => (
                  <li key={warning} className="flex items-start gap-2">
                    <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                    <span>{warning}</span>
                  </li>
                ))}
              </ul>
            )}

            {info.oidc.enabled && (
              <dl className="flex flex-col gap-2 rounded-xl bg-surface-800/45 px-3.5 py-3">
                <p className="font-display text-[12.5px] font-semibold text-surface-200 flex items-center gap-2">
                  {info.oidc.provider.reachable ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-text" aria-hidden />
                  ) : (
                    <CircleAlert className="h-3.5 w-3.5 text-ruby-text" aria-hidden />
                  )}
                  {t('login.ssoTitle', 'Single sign-on · {{provider}}', { provider: info.oidc.providerName })}
                </p>
                {!info.oidc.provider.reachable && (
                  <p className="text-[11.5px] text-ruby-text">
                    {t('login.ssoUnreachable', 'The identity provider could not be reached: {{error}}', { error: info.oidc.provider.error ?? '' })}
                  </p>
                )}
                <Row label={t('login.issuer', 'Issuer')} mono>
                  {info.oidc.issuer}
                </Row>
                <Row label={t('login.clientId', 'Client ID')} mono>
                  {info.oidc.clientId}
                </Row>
                <Row label={t('login.redirectUri', 'Redirect URI')} mono>
                  {info.oidc.redirectUri ?? `${window.location.origin}/api/auth/oidc/callback`}
                </Row>
                <Row label={t('login.scopes', 'Scopes')} mono>
                  {info.oidc.scopes.join(' ')}
                </Row>
                <Row label={t('login.groupsClaim', 'Groups claim')} mono>
                  {info.oidc.groupsClaim}
                </Row>
                <Row label={roleLabel('admin')}>
                  <GroupList groups={info.oidc.adminGroups} />
                </Row>
                <Row label={roleLabel('operator')}>
                  <GroupList groups={info.oidc.operatorGroups} />
                </Row>
                <Row label={roleLabel('viewer')}>
                  <GroupList groups={info.oidc.viewerGroups} />
                </Row>
                <Row label={t('login.defaultRole', 'Everyone else')}>{roleLabel(info.oidc.defaultRole)}</Row>
              </dl>
            )}

            {info.local.enabled && (
              <dl className="flex flex-col gap-2 rounded-xl bg-surface-800/45 px-3.5 py-3">
                <p className="font-display text-[12.5px] font-semibold text-surface-200 flex items-center gap-2">
                  <KeyRound className="h-3.5 w-3.5 text-accent-text" aria-hidden />
                  {t('login.localTitle', 'Local account')}
                </p>
                <Row label={t('login.username', 'Username')} mono>
                  {info.local.username}
                </Row>
                <Row label={t('login.role', 'Role')}>{roleLabel(info.local.role)}</Row>
                <Row label={t('login.password', 'Password')}>
                  {info.local.usesHash ? t('login.passwordHashed', 'scrypt hash (AUTH_LOCAL_PASSWORD_HASH)') : t('login.passwordPlain', 'plain text in the environment (AUTH_LOCAL_PASSWORD)')}
                </Row>
              </dl>
            )}

            <div className="flex flex-col gap-2 rounded-xl bg-surface-800/45 px-3.5 py-3">
              <p className="font-display text-[12.5px] font-semibold text-surface-200">{t('login.rolesTitle', 'Roles')}</p>
              <ul className="flex flex-col gap-1 text-[12px] text-surface-300">
                <li>
                  <span className="font-semibold text-surface-100">{roleLabel('admin')}</span> — {t('login.roleAdminDesc', 'everything, including Settings, the API key, backups and the MCP connector')}
                </li>
                <li>
                  <span className="font-semibold text-surface-100">{roleLabel('operator')}</span> — {t('login.roleOperatorDesc', 'queue, protect, rules, scans and collections; no Settings')}
                </li>
                <li>
                  <span className="font-semibold text-surface-100">{roleLabel('viewer')}</span> — {t('login.roleViewerDesc', 'read-only')}
                </li>
              </ul>
              <p className="text-[11.5px] text-surface-400">
                {t('login.apiKeyNote', 'The API key always acts as an administrator, with or without login.')}
              </p>
            </div>

            {!info.enabled && (
              <div className="flex flex-col gap-2 rounded-xl bg-surface-800/45 px-3.5 py-3">
                <p className="font-display text-[12.5px] font-semibold text-surface-200">{t('login.howTo', 'Turning it on (Authentik example)')}</p>
                <pre className="overflow-x-auto whitespace-pre rounded-lg border border-surface-700/50 bg-surface-900/50 px-3 py-2 font-mono text-[11px] leading-relaxed text-surface-300">
                  {ENV_EXAMPLE}
                </pre>
                <p className="text-[11.5px] text-surface-400">
                  {t('login.howToHint', 'Add these to the container environment and restart. Full details in docs/authentication.md.')}
                </p>
              </div>
            )}
          </>
        )}
      </SettingsCard>
    </PanelSection>
  );
}
