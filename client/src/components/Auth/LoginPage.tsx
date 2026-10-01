import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { KeyRound, LogIn, Scissors, ShieldAlert } from 'lucide-react';
import { authApi } from '@/services/api';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { cn } from '@/lib/utils';

/** Map the `?error=` codes the server redirects with to readable copy. */
function useErrorMessage(code: string | null): string | null {
  const { t } = useTranslation('auth');
  return useMemo(() => {
    if (!code) return null;
    switch (code) {
      case 'no_role':
        return t('errors.noRole', 'Your account signed in, but it is not in any group that Prunerr grants access to. Ask an administrator to add you to one of the mapped groups.');
      case 'oidc_denied':
        return t('errors.denied', 'The identity provider refused the sign-in.');
      case 'oidc_state':
        return t('errors.state', 'That sign-in attempt expired or did not start here. Please try again.');
      case 'oidc_exchange':
        return t('errors.exchange', 'Prunerr could not exchange the login code with the identity provider. Check the client ID, secret and redirect URI.');
      case 'oidc_token':
        return t('errors.token', 'The identity provider returned a token Prunerr could not verify.');
      case 'oidc_provider':
        return t('errors.provider', 'Prunerr could not reach the identity provider.');
      case 'oidc_unavailable':
        return t('errors.unavailable', 'Single sign-on is not configured on this install.');
      default:
        return t('errors.generic', 'Sign-in failed. Please try again.');
    }
  }, [code, t]);
}

export default function LoginPage() {
  const { t } = useTranslation('auth');
  const { methods, setUser, status } = useAuth();
  const location = useLocation();

  const params = new URLSearchParams(location.search);
  const errorCode = params.get('error');
  const urlError = useErrorMessage(errorCode);

  // Where to go after the provider sends us back. Only paths inside the app.
  const returnTo = useMemo(() => {
    const path = location.pathname === '/login' ? params.get('returnTo') || '/' : location.pathname + location.search;
    return path.startsWith('/') && !path.startsWith('//') ? path : '/';
  }, [location.pathname, location.search, params]);

  const ssoHref = `/api/auth/oidc/start?returnTo=${encodeURIComponent(returnTo)}`;

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const hasLocal = methods.local.enabled;
  const hasSso = methods.oidc.enabled;
  const providerName = methods.oidc.providerName ?? t('sso', 'Single sign-on');

  // Auto-login: when SSO is the only way in and nothing went wrong, skip the page.
  useEffect(() => {
    if (status !== 'ready') return;
    if (hasSso && methods.oidc.autoLogin && !hasLocal && !errorCode) {
      window.location.assign(ssoHref);
    }
  }, [status, hasSso, hasLocal, methods.oidc.autoLogin, errorCode, ssoHref]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setFormError(null);
    try {
      const user = await authApi.loginLocal(username.trim(), password);
      setUser(user);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : t('errors.generic', 'Sign-in failed. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-surface-950 flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center gap-3 mb-8">
          <div className="w-14 h-14 bg-gradient-to-br from-accent-500 to-accent-600 rounded-2xl flex items-center justify-center shadow-lg shadow-accent-500/20">
            <Scissors className="w-7 h-7 text-amber-950" aria-hidden />
          </div>
          <div className="text-center">
            <h1 className="text-2xl font-display font-bold text-surface-50 tracking-tight">Prunerr</h1>
            <p className="text-sm text-surface-400 mt-1">{t('subtitle', 'Sign in to manage your library')}</p>
          </div>
        </div>

        <div className="rounded-2xl border border-surface-700/80 bg-surface-900/90 p-6 shadow-xl shadow-black/20 space-y-5">
          {urlError && (
            <div className="flex items-start gap-2.5 rounded-xl border border-ruby-500/30 bg-ruby-500/10 px-3.5 py-3 text-sm text-ruby-text">
              <ShieldAlert className="w-4 h-4 mt-0.5 shrink-0" aria-hidden />
              <span>{urlError}</span>
            </div>
          )}

          {!hasLocal && !hasSso && (
            <div className="rounded-xl border border-surface-700/80 bg-surface-800/50 px-3.5 py-3 text-sm text-surface-300">
              {t(
                'noMethods',
                'Login is enabled but no sign-in method is configured. Set OIDC_* or AUTH_LOCAL_* in the container environment, or set AUTH_ENABLED=false.'
              )}
            </div>
          )}

          {hasSso && (
            <a
              href={ssoHref}
              className={cn(
                'flex w-full items-center justify-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold',
                'bg-gradient-to-r from-accent-500 to-accent-600 text-amber-950',
                'hover:from-accent-400 hover:to-accent-500 hover:shadow-lg hover:shadow-accent-500/25',
                'transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-accent-500/50'
              )}
            >
              <LogIn className="w-4 h-4" aria-hidden />
              {t('continueWith', 'Continue with {{provider}}', { provider: providerName })}
            </a>
          )}

          {hasSso && hasLocal && (
            <div className="flex items-center gap-3 text-2xs uppercase tracking-widest text-surface-500">
              <span className="h-px flex-1 bg-surface-700/80" />
              {t('or', 'or')}
              <span className="h-px flex-1 bg-surface-700/80" />
            </div>
          )}

          {hasLocal && (
            <form onSubmit={submit} className="space-y-4">
              <Input
                name="username"
                label={t('username', 'Username')}
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
              />
              <Input
                name="password"
                type="password"
                label={t('password', 'Password')}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                error={formError ?? undefined}
              />
              <Button type="submit" variant={hasSso ? 'secondary' : 'primary'} className="w-full" isLoading={busy}>
                <KeyRound className="w-4 h-4" aria-hidden />
                {t('signIn', 'Sign in')}
              </Button>
            </form>
          )}
        </div>

        <p className="mt-6 text-center text-2xs text-surface-500">
          {t('footer', 'Access is configured by the server environment. See docs/authentication.md.')}
        </p>
      </div>
    </div>
  );
}
