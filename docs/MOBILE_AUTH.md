# AI Connect Mobile Auth Broker (Life Hack Protocol)

The mobile auth broker lets the **Life Hack Protocol mobile app** authenticate a
WordPress/MemberPress user and read their membership status **without the app
ever talking to WordPress** — no JWT plugin, no MemberPress API key, no WordPress
credentials or cookies on the device. AI Connect brokers everything
server-to-server and hands the app a short-lived, AI-Connect-signed token.

## What it does

The app POSTs a username + password to AI Connect. AI Connect:

1. Verifies the credentials against WordPress using the **real login path**
   (`wp_authenticate()`), via the AI Connect WordPress plugin.
2. Reads the user's **active MemberPress memberships** in the same call.
3. Issues an **AI-Connect-signed JWT** (HS256, AI Connect's own secret) encoding
   the user id, email, membership tiers, active flag, and expiry.
4. Returns the token plus the membership summary.

The app stores the token and, from then on, calls `/validate` to check it's
still good and to refresh it. `/validate` re-reads MemberPress on a short TTL so
a **revoked or expired membership stops working within ~15 minutes**, without the
user re-entering a password.

The app never sees: the WordPress password round-trip details, the plugin token,
any MemberPress key. Those stay server-side in AI Connect's env + Supabase Vault.

## Why this password path (`wp_authenticate`, not `mp/v1`)

We investigated the MemberPress `mp/v1` REST API first, as the brief asked.
Findings:

- **`mp/v1` is an admin CRUD API keyed by `MEMBERPRESS-API-KEY`. It does not
  verify user passwords.** `mp/v1/me` only tells you whether the *API key* is
  valid; `mp/v1/members` is a key-authed member lookup. `POST /mp/v1/validate-login`
  *does* exist on the live site (Developer Tools addon 1.3.9) but is gated by the
  API key and its password-checking behavior is undocumented and unverifiable
  without the key — not something to build an auth boundary on.
- **WordPress Application Passwords do not accept a real login password.** Core's
  `wp_authenticate_application_password()` checks only generated app-password
  usermeta (and strips non-alphanumerics first), so `wp/v2/users/me` + Basic auth
  can't verify what a mobile user actually types.
- **`wp_authenticate()` is the correct path.** It runs WordPress's full
  `authenticate` filter chain, so it honors password hashing, disabled accounts,
  and 2FA / SSO / login-lockout plugins — exactly what the login form respects.

So the broker calls a new token-gated route on the **AI Connect WordPress plugin**
(already installed and live on lifehackprotocol.com) that runs `wp_authenticate()`
and returns the active MemberPress membership ids in one response. This needs **no
MemberPress API key at all** and is one round trip instead of two.

## Architecture

### Components

**1. AI Connect WordPress plugin** — `wp-plugin/ai-connect/` (v1.1.0+). Two new
token-gated routes under the existing `ai-connect/v1` namespace, authenticated by
the same `X-AI-Connect-Token` header as the rest of the plugin:

- `POST /wp-json/ai-connect/v1/validate-login` — `wp_authenticate(username,
  password)`, then active MemberPress tiers. Generic 401 on any failure. The
  application-password authenticator is unhooked for this call so **only the real
  login password** is accepted.
- `GET /wp-json/ai-connect/v1/membership-status?user_id=<id>` — re-reads a user's
  active tiers with no password, for the refresh path.

Source: `wp-plugin/ai-connect/includes/mobile-auth.php`.

**2. AI Connect backend** — `apps/api/`:

- `routes/mobileAuth.ts` — the two public endpoints, rate-limited.
- `lib/mobile/mobileToken.ts` — pure sign/verify of the AI-Connect token (jose).
- `lib/mobile/lhpSiteConfig.ts` — resolves the site URL (env) + plugin token
  (Vault).
- `lib/integrations/lhpAuthClient.ts` — outbound client to the plugin routes.

### Communication

```
  Mobile app                AI Connect API                 WordPress (lifehackprotocol.com)
  ──────────                ──────────────                 ────────────────────────────────
  POST /login  ───────────▶ getLhpSiteConfig()
  {username,password}       (env URL + Vault token)
                            POST ai-connect/v1/validate-login ───▶ wp_authenticate()
                            X-AI-Connect-Token: <plugin token>     + active MemberPress tiers
                            ◀─── { user, active, tiers } ──────────
                            sign HS256 token (AI Connect secret)
  ◀── { token, membership, user }

  POST /validate ─────────▶ verify token (signature + expiry)
  {token}                   if membership snapshot > 15 min old:
                              GET ai-connect/v1/membership-status ─▶ active tiers (no password)
                              ◀─── { active, tiers } ──────────────
                            re-sign refreshed token
  ◀── { token, membership }
```

### Configuration (site-config entry for lifehackprotocol.com)

Three env vars on the AI Connect API (`apps/api/src/lib/env.ts`). The plugin
**token value lives only in Supabase Vault**; env holds just the Vault secret id
pointing at it — the same indirection the `integrations` table uses. Nothing here
is ever sent to the app.

| Env var | Meaning |
|---|---|
| `MOBILE_JWT_SIGNING_KEY` | HMAC secret AI Connect signs mobile tokens with. Dedicated, high-entropy, not reused from `MASTER_KEY`. `openssl rand -hex 32`. |
| `LHP_SITE_URL` | WordPress base URL. Defaults to `https://lifehackprotocol.com`. |
| `LHP_WP_TOKEN_SECRET_ID` | Supabase Vault secret id (uuid) holding the `ai-connect` plugin token (the `X-AI-Connect-Token` value from WP Admin → Settings → AI Connect). |

To store the plugin token in Vault (run against the AI Connect DB, value from the
WP admin screen — never commit it):

```sql
select vault.create_secret('<PLUGIN_TOKEN>', 'ai-connect:site:lifehackprotocol.com:plugin-token', 'LHP mobile auth broker');
-- put the returned uuid in LHP_WP_TOKEN_SECRET_ID
```

## Endpoints

Base URL (production): `https://aiconnect.macrotechtitan.com`
Base URL (local dev): `http://localhost:8080`

Both endpoints are **public** (no Auth0) — the caller is a WordPress member, not
an AI Connect user. Both are rate-limited per IP.

---

### `POST /api/mobile/lhp/login`

Verify a WordPress login and issue a token.

**Request**

```
Content-Type: application/json
```
```json
{ "username": "member@example.com", "password": "the-user-password" }
```

`username` accepts a WordPress username or email (whatever `wp_authenticate`
accepts). Both fields required, 1–256 chars.

**200 — success**

```json
{
  "token": "<AI-Connect JWT>",
  "membership": { "active": true, "tiers": ["1234", "5678"] },
  "user": { "email": "member@example.com", "displayName": "Jane Member" }
}
```

- `membership.tiers` — active MemberPress membership (product) ids as strings.
  Empty array when the user has no active membership.
- `membership.active` — `true` iff `tiers` is non-empty.

**401 — bad credentials** (also returned for malformed input, so the boundary
can't be probed):

```json
{ "error": "invalid_credentials", "message": "Incorrect username or password." }
```

**429 — rate limited**

```json
{ "error": "too_many_requests", "message": "Too many login attempts. Try again later." }
```

**502 — upstream problem** (WordPress unreachable, plugin token wrong, plugin not
updated). This is an AI Connect/WordPress config issue, never a wrong user
password:

```json
{ "error": "upstream_error", "reason": "…" }
```

**500 — broker not configured** (`MOBILE_JWT_SIGNING_KEY` or the Vault token
missing): `{ "error": "mobile_broker_not_configured" }`

---

### `POST /api/mobile/lhp/validate`

Verify a token and return current membership. This is also the **refresh path**:
every successful call returns a fresh token with a new expiry, so the app extends
its session by calling `/validate` rather than re-prompting for a password.

**Request**

```json
{ "token": "<AI-Connect JWT>" }
```

**200 — valid**

```json
{
  "token": "<refreshed AI-Connect JWT>",
  "membership": { "active": true, "tiers": ["1234"] }
}
```

If the token's membership snapshot is older than the re-check TTL (15 min),
AI Connect re-reads MemberPress before responding, so a revoked/expired
membership shows up as `active: false` here even while the token is otherwise
still valid. Within the TTL, the cached snapshot is returned and the token is
simply re-stamped (no WordPress round trip).

**401 — token invalid or expired**

```json
{ "error": "token_expired" }
```
or `{ "error": "invalid_token" }`

**429 / 500 / 502** — same shapes as `/login`.

## Token shape

AI-Connect-signed JWT, `HS256`, signed with `MOBILE_JWT_SIGNING_KEY`. Claims:

| Claim | Meaning |
|---|---|
| `sub` | WordPress user id |
| `email`, `display_name` | user identity |
| `tiers` | active MemberPress membership ids (`string[]`) |
| `active` | `tiers.length > 0` |
| `mtc` | unix seconds when MemberPress was last read (drives the re-check TTL) |
| `iss` / `aud` | `ai-connect` / `lhp-mobile` |
| `iat` / `exp` | issued-at / expiry (1 hour) |

The mobile app should treat the token as opaque and rely on `/validate` for
truth. Tune lifetimes in `lib/mobile/mobileToken.ts`:

- `ACCESS_TOKEN_TTL_SECONDS` (default `3600`) — access-token lifetime.
- `MEMBERSHIP_RECHECK_TTL_SECONDS` (default `900`) — how stale a membership
  snapshot may get before `/validate` re-reads MemberPress.

## Security notes

- **API key / plugin token only from Vault**, never in code, never sent to the
  app. `LHP_WP_TOKEN_SECRET_ID` is a pointer; the value lives in Supabase Vault.
- **Tokens signed with a dedicated secret** (`MOBILE_JWT_SIGNING_KEY`), not
  reused from `MASTER_KEY` or any other purpose — same hygiene rule as
  `GITHUB_STATE_SIGNING_KEY`.
- **No user enumeration.** Bad username, wrong password, malformed body, locked
  out, and disabled account all return the identical generic 401.
- **Rate limiting.** Login is capped at 10 attempts / IP / 15 min; validate at
  60 / IP / 5 min. WordPress's own login-lockout plugins also apply, since we go
  through `wp_authenticate()`.
- **Short access-token TTL with `/validate` as the refresh path**, so a revoked
  membership can't linger longer than the re-check TTL.
- **Passwords are never logged.** The audit line records username length and the
  active flag only.

## Verification

No test runner is wired in this repo yet (see `CLAUDE.md`). The pure token logic
and the client's 401-disambiguation (a wrong plugin token must NOT read as a login
failure) were exercised against a fake WordPress server during development. A
live smoke checklist:

1. **Config** — set the three env vars; store the plugin token in Vault.
2. **Plugin** — confirm `GET /wp-json/ai-connect/v1/ping` with the token returns
   200, and that the site runs plugin **v1.1.0+** (older builds lack the routes).
3. **Login (bad)** — `curl` with a wrong password → `401 invalid_credentials`.
4. **Login (good)** — real member → `200` with a token and the expected tiers.
5. **Validate** — POST the token back → `200`; wait past the re-check TTL (or
   lower it) and confirm a cancelled membership flips `active` to `false`.
6. **Rate limit** — 11 rapid bad logins from one IP → the 11th returns `429`.

### curl — login

```bash
curl -sS -X POST https://aiconnect.macrotechtitan.com/api/mobile/lhp/login \
  -H "Content-Type: application/json" \
  -d '{"username":"member@example.com","password":"the-user-password"}'
```

### curl — validate

```bash
curl -sS -X POST https://aiconnect.macrotechtitan.com/api/mobile/lhp/validate \
  -H "Content-Type: application/json" \
  -d '{"token":"<TOKEN FROM LOGIN>"}'
```
