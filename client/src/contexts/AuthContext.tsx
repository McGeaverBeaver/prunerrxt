import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { authApi, UNAUTHENTICATED_EVENT, type AuthMethods, type AuthRole, type AuthState, type AuthUser } from '@/services/api';

interface AuthContextValue {
  /** 'loading' until the first /auth/me answer; the app renders nothing before that. */
  status: 'loading' | 'ready' | 'error';
  /** Whether this install requires a login at all (AUTH_ENABLED). */
  enabled: boolean;
  user: AuthUser | null;
  methods: AuthMethods;
  roles: Record<AuthRole, string>;
  mcpEnabled: boolean;
  /** True when the user may do what `required` needs (admin ≥ operator ≥ viewer). */
  can: (required: AuthRole) => boolean;
  isAdmin: boolean;
  refresh: () => Promise<void>;
  setUser: (user: AuthUser) => void;
  logout: () => Promise<void>;
}

const RANK: Record<AuthRole, number> = { viewer: 1, operator: 2, admin: 3 };

const EMPTY_METHODS: AuthMethods = {
  oidc: { enabled: false, providerName: null, autoLogin: false },
  local: { enabled: false },
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [state, setState] = useState<AuthState | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await authApi.me();
      setState(next);
      setStatus('ready');
    } catch {
      // A server that predates the auth endpoints, or is unreachable: behave
      // as an open install so the rest of the UI can still report the error.
      setState((prev) => prev ?? { enabled: false, methods: EMPTY_METHODS, roles: { admin: '', operator: '', viewer: '' }, mcpEnabled: false, user: null });
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The API client fires this when a request comes back 401 AUTH_REQUIRED.
  useEffect(() => {
    const onUnauthenticated = () => {
      setState((prev) => (prev && prev.enabled ? { ...prev, user: null } : prev));
    };
    window.addEventListener(UNAUTHENTICATED_EVENT, onUnauthenticated);
    return () => window.removeEventListener(UNAUTHENTICATED_EVENT, onUnauthenticated);
  }, []);

  const setUser = useCallback((user: AuthUser) => {
    setState((prev) => (prev ? { ...prev, user } : prev));
  }, []);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } finally {
      setState((prev) => (prev ? { ...prev, user: null } : prev));
      // Nothing cached belongs to the next person who signs in.
      queryClient.clear();
    }
  }, [queryClient]);

  const value = useMemo<AuthContextValue>(() => {
    const enabled = state?.enabled ?? false;
    const user = state?.user ?? null;
    // With login disabled everyone is an admin, as they always were.
    const effectiveRole: AuthRole | null = enabled ? user?.role ?? null : 'admin';
    return {
      status,
      enabled,
      user,
      methods: state?.methods ?? EMPTY_METHODS,
      roles: state?.roles ?? { admin: '', operator: '', viewer: '' },
      mcpEnabled: state?.mcpEnabled ?? false,
      can: (required) => (effectiveRole ? RANK[effectiveRole] >= RANK[required] : false),
      isAdmin: effectiveRole === 'admin',
      refresh,
      setUser,
      logout,
    };
  }, [state, status, refresh, setUser, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
