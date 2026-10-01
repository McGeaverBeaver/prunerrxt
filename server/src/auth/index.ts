export { getAuthConfig, loadAuthConfig, setAuthConfigForTests, type AuthConfig, type OidcConfig, type LocalAuthConfig, type Role } from './config';
export { roleFromGroups, isAuthorized, roleAtLeast, ROLE_DESCRIPTIONS } from './roles';
export {
  createSession,
  readSession,
  deleteSession,
  deleteSessionsForUser,
  purgeExpiredSessions,
  sessionFromRequest,
  setSessionCookie,
  clearSessionCookie,
  type AuthSession,
  type SessionUser,
} from './sessions';
export { verifyLocalCredentials, hashPassword, verifyPasswordHash } from './local';
export { beginOidcLogin, completeOidcLogin, verifyJwt, OidcError } from './oidc';
export { default as authRouter } from './routes';
export { getRequestAuth, type RequestAuth } from './middleware';
