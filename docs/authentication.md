# Login and access control

Prunerr can require a login, with **single sign-on through any OpenID Connect
provider** (written and tested against [Authentik](https://goauthentik.io)) and
**roles mapped from the provider's groups**, plus an optional **local account**
as a fallback. Everything is configured by environment variables, so the whole
setup lives in your compose file and nothing has to be clicked through in the
UI.

Login is **off by default** so existing installs are unaffected. While it is
off, Prunerr behaves exactly as before: anyone who can reach the address can
use it, the API key still guards external calls, and the
[MCP connector](mcp.md) stays disabled.

## Quick start (Authentik)

1. In Authentik, create an **OAuth2/OpenID Provider**:
   - Client type **Confidential**, note the client ID and secret
   - Redirect URI: `https://prunerr.example.com/api/auth/oidc/callback`
     (strict match; use whatever URL you open Prunerr at)
   - Scopes: `openid`, `profile`, `email` (the defaults). Authentik's `profile`
     scope mapping includes the `groups` claim, which is what the roles use.
   - Signing key: any RSA or EC key
2. Create an **Application** for it and note the slug. The issuer is
   `https://auth.example.com/application/o/<slug>/`.
3. Add the environment to Prunerr and restart:

```yaml
environment:
  - AUTH_ENABLED=true
  - OIDC_ISSUER_URL=https://auth.example.com/application/o/prunerr/
  - OIDC_CLIENT_ID=...
  - OIDC_CLIENT_SECRET=...
  - OIDC_ADMIN_GROUPS=prunerr-admins
  - OIDC_OPERATOR_GROUPS=media-ops
  - OIDC_VIEWER_GROUPS=family
  # Optional break-glass account that does not depend on Authentik being up
  - AUTH_LOCAL_ENABLED=true
  - AUTH_LOCAL_USERNAME=admin
  - AUTH_LOCAL_PASSWORD_HASH=scrypt$$16384$$8$$1$$...   # see below
```

Open Prunerr: you get a login page with **Continue with Authentik** and, if
enabled, the local form. **Settings → System → Login & access** shows what is
in force, whether the provider is reachable, and any misconfiguration
warnings.

## Roles

A user's groups (from the configured claim) decide their role. The highest
match wins; users in none of the mapped groups get `OIDC_DEFAULT_ROLE`, which
is `none` by default — they can sign in at Authentik but Prunerr refuses them.

| Role | May |
|---|---|
| **admin** | everything, including Settings (service credentials), the API key, backup/restore and the MCP connector configuration |
| **operator** | run the library day to day: search, queue and protect items, remove from the queue, run and edit rules, scans, library sync, collections. No Settings. |
| **viewer** | read-only: every page except Settings, no changes |

The **API key** always acts as admin, with or without login. Scripts, nzb360,
Home Assistant and the MCP connector keep working unchanged.

## All environment variables

| Variable | Default | Meaning |
|---|---|---|
| `AUTH_ENABLED` | `false` | Require a login. Off keeps the historical open behaviour and disables MCP. |
| `OIDC_ISSUER_URL` | — | The provider's issuer. Discovery is read from `<issuer>/.well-known/openid-configuration`. |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | — | From the provider. All three OIDC_* above are required for SSO. |
| `OIDC_REDIRECT_URI` | derived | Fixed callback URL. Otherwise built from `APP_URL`, or from the request's host and scheme. |
| `OIDC_SCOPES` | `openid profile email` | Space- or comma-separated. `openid` is always included. |
| `OIDC_GROUPS_CLAIM` | `groups` | Claim holding the user's groups. Dotted paths work (`realm_access.roles` for Keycloak). Read from the ID token, then from userinfo. |
| `OIDC_ADMIN_GROUPS` | — | Comma-separated group names → admin. Case-insensitive. |
| `OIDC_OPERATOR_GROUPS` | — | → operator |
| `OIDC_VIEWER_GROUPS` | — | → viewer |
| `OIDC_DEFAULT_ROLE` | `none` | Role for users in no mapped group: `none`, `viewer`, `operator` or `admin`. |
| `OIDC_USERNAME_CLAIM` | `preferred_username` | Claim shown as the username. |
| `OIDC_PROVIDER_NAME` | guessed | Label on the login button (Authentik is recognised from the issuer). |
| `OIDC_AUTO_LOGIN` | `false` | Skip the login page and go straight to the provider when SSO is the only method. |
| `OIDC_TOKEN_AUTH_METHOD` | `client_secret_basic` | Or `client_secret_post`, for providers that want the secret in the body. |
| `AUTH_LOCAL_ENABLED` | `false` | Enable the built-in account. |
| `AUTH_LOCAL_USERNAME` | — | Its username. |
| `AUTH_LOCAL_PASSWORD` | — | Its password, in plain text. Or: |
| `AUTH_LOCAL_PASSWORD_HASH` | — | A scrypt hash from `node scripts/hash-password.mjs`. Preferred. In compose files write every `$` as `$$`. |
| `AUTH_LOCAL_ROLE` | `admin` | Role of the local account. |
| `AUTH_SESSION_TTL_HOURS` | `168` | How long a login lasts (7 days). |
| `AUTH_SESSION_SECRET` | generated | Signs the session cookie. Generated and stored in the database when unset; set it to share sessions across a restore, or rotate it to log everyone out. |
| `AUTH_COOKIE_SECURE` | `auto` | `auto` marks the cookie `Secure` when the request came over HTTPS (directly or via `X-Forwarded-Proto`); `true`/`false` force it. |
| `APP_URL` | — | Public base URL, e.g. `https://prunerr.example.com`. Used for the OIDC redirect URI and the MCP endpoint shown in Settings. |

Only `AUTH_ENABLED`, one login method and (for SSO) a group mapping are
needed; everything else has a sensible default. Misconfigurations are logged
at startup and shown in **Settings → System → Login & access**.

## How it works

- **Authorization code flow with PKCE.** State, nonce and the PKCE verifier are
  kept server-side for ten minutes; the callback rejects anything it did not
  start.
- **ID tokens are verified** against the provider's JWKS (RS/PS/ES/EdDSA
  algorithms; `none` and HMAC are refused), including issuer, audience, expiry
  and nonce. Key rotation is handled by refetching the key set once on an
  unknown `kid`.
- **Sessions** are rows in the database; the browser holds a signed session id
  in an `HttpOnly`, `SameSite=Lax` cookie. Expired sessions are purged hourly.
  Cross-site mutations are additionally refused by `Sec-Fetch-Site`.
- **Local login** compares in constant time and locks an address out for
  fifteen minutes after ten failures.
- The Docker health check (`/api/health`), `/api/health/ping|live|ready|version`
  and the login endpoints themselves stay public; everything else under
  `/api` needs a session or the API key.

## Other providers

Anything OpenID Connect works. Known-good hints:

- **Authelia**: issuer `https://auth.example.com`, groups arrive in the `groups`
  claim with the `groups` scope — add it: `OIDC_SCOPES=openid profile email groups`.
- **Keycloak**: issuer `https://kc.example.com/realms/<realm>`; map a groups
  mapper to a claim, or use `OIDC_GROUPS_CLAIM=realm_access.roles` for realm
  roles.
- **Pocket ID**: issuer is the base URL; groups are in the `groups` claim.

## Reverse proxies

Prunerr reads `X-Forwarded-Proto` and `X-Forwarded-Host` to build the redirect
URI and to decide whether cookies are `Secure`. Set `APP_URL` if the proxy does
not send them. If you already protect Prunerr with the proxy's own login
(Authelia/Authentik forward auth), you can leave `AUTH_ENABLED=false` — but
then the MCP connector stays off, by design.
