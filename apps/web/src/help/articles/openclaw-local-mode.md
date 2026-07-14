# OpenClaw local mode

AI Connect normally runs as a cloud service. Most integrations — WordPress, SendGrid, OpenAI, Anthropic — work fine there because they're network APIs the cloud backend can call.

Some integrations need to run **locally**, on the same host as the system they're talking to. The first one is **OpenClaw**.

OpenClaw runs on your local machine. Its bridge (maximus-bridge) uses MCP over stdio — a local-only transport, no network. So AI Connect can only drive OpenClaw if AI Connect *itself* is running on the same host as OpenClaw.

That's what "local mode" means: AI Connect's TypeScript codebase running on your machine, with environment variables that tell it to enable local-only integrations.

> Local mode is for self-hosters running AI Connect from source. If you use the hosted cloud service, OpenClaw appears with a "local mode only" badge and its actions are disabled.

## When to use it

Use local mode when:
- You want to use the OpenClaw integration
- You want to use any future local-only integration

You do **not** need local mode for:
- WordPress (cloud handles this)
- SendGrid, OpenAI, Anthropic (cloud handles all)
- Project Genesis provisioning (cloud handles this)
- Most AI Connect work

Cloud and local AI Connect can share the same database, so integrations you create in either mode are visible everywhere. Cloud just refuses to actually *call* OpenClaw-type integrations — it shows a "local mode only" badge and disables the action buttons for them.

## Prerequisites

Before setting up local mode you need:

1. **Node.js 20+** installed (the AI Connect API server is TypeScript/Node; production runs Node 24).
2. **pnpm** installed (`npm install -g pnpm` if needed). The repo pins pnpm 9 via `packageManager`.
3. **OpenClaw** installed and a Gateway running. Verify with:
   ```
   openclaw --version
   ```
   If it's not installed, see the [OpenClaw docs](https://docs.openclaw.dev).
4. **maximus-bridge** cloned:
   ```
   git clone https://github.com/MacroTechTitan/maximus-bridge.git
   cd maximus-bridge
   npm install
   ```
   Note the absolute path to `maximus-bridge/index.mjs` — you'll need it.
5. **AI Connect** cloned locally:
   ```
   git clone https://github.com/MacroTechTitan/AI-Connect.git
   cd AI-Connect
   pnpm install
   ```

## Setup

### Step 1 — Configure your database

Local mode needs a Postgres database. Point `DATABASE_URL` at your own Supabase project (or any Postgres instance). Use the **IPv4 session-pooler** connection string from your Supabase project settings.

Keep this connection string out of version control — treat it like a password.

### Step 2 — Create a local `.env` file

In the AI Connect repo, create `apps/api/.env.local`:

```
# Required — your own database
DATABASE_URL=<your Supabase session-pooler connection string>

# Required — your own Auth0 tenant
AUTH0_ISSUER_BASE_URL=https://yourtenant.us.auth0.com/
AUTH0_AUDIENCE=https://api.your-domain.com
NODE_ENV=development

# Required for OpenClaw — points at your maximus-bridge install
OPENCLAW_BIN=/Users/yourname/dev/maximus-bridge/index.mjs

# Required to opt into local mode
AICONNECT_LOCAL_MODE=true

# Optional — the port the API server listens on (default 8080)
PORT=8080

# Optional — only if you want to decrypt/use BYOAI provider keys locally
# (Anthropic/OpenAI integrations). 32-byte hex. OpenClaw itself does not
# need this. Supabase Vault is reached through DATABASE_URL, so there are
# no separate SUPABASE_* / VAULT_KEY vars.
# MASTER_KEY=<your 32-byte hex master key>
```

The two vars specific to local mode are:
- `OPENCLAW_BIN` — absolute path to `maximus-bridge/index.mjs`
- `AICONNECT_LOCAL_MODE=true`

Either one triggers `isLocalMode()` to return true. Set both to be explicit.

### Step 3 — Create the frontend env

In `apps/web/.env.local`:

```
VITE_API_BASE_URL=http://localhost:8080
VITE_AUTH0_DOMAIN=yourtenant.us.auth0.com
VITE_AUTH0_CLIENT_ID=<your Auth0 SPA app's client ID>
VITE_AUTH0_AUDIENCE=https://api.your-domain.com
```

`VITE_API_BASE_URL` tells the frontend to talk to your local API server (it must match the API's `PORT`). The `VITE_AUTH0_*` vars are required for sign-in — without them the Auth0 SDK won't initialize.

> Vite only exposes vars prefixed with `VITE_`. The exact name `VITE_API_BASE_URL` matters — `VITE_API_URL` (or any other name) is silently ignored, which leaves every API call pointing at `undefined`.

### Step 4 — Run it

In two separate terminal tabs:

```
# Terminal 1 — API server
cd /path/to/AI-Connect
pnpm --filter @ai-connect/api dev
```

```
# Terminal 2 — Frontend
pnpm --filter @ai-connect/web dev
```

Visit `http://localhost:5173` (the default Vite port) and sign in with your Auth0 credentials. Your existing integrations should appear in the Integrations panel — proving local AI Connect is sharing your database.

### Step 5 — Verify local mode is on

The API's health route is `/health` (no `/api` prefix) and there's no Vite dev proxy, so check it against the API origin directly. From the browser dev-tools console on the `http://localhost:5173` tab (an allowed CORS origin):

```
fetch('http://localhost:8080/health').then(r => r.json()).then(console.log)
```

It should return `{ status: 'ok', ..., local_mode: true }`. If `local_mode: false`, your env vars aren't being picked up — verify `.env.local` is in `apps/api/` (not the repo root) and restart `pnpm dev`.

## Adding an OpenClaw integration

Once local mode is verified:

1. Settings → Integrations → **Add Integration** → **OpenClaw** (now enabled — cloud mode disables it)
2. The wizard walks you through:
   - A security warning
   - Bridge path (enter the absolute path to `maximus-bridge/index.mjs`)
   - Agent discovery (AI Connect spawns the bridge and lists your agents)
   - Pick a default agent
   - Send a test message ("reply OK")
   - Success
3. From the Integrations panel, click **Manage Agents** on the OpenClaw row to send real messages to your agent

## Security notes

Local mode is more powerful than cloud mode — that's the whole point. Treat it accordingly:

- **The OpenClaw integration gives AI Connect the agent's full local powers** (file system, shell, tools) *through* the agent. Only enable it on a machine you control.
- **`MAXIMUS_READONLY=true` is enforced at every bridge spawn.** AI Connect cannot accidentally call mutating tools, even with a code bug — the bridge refuses them at the server level.
- **Don't expose your local AI Connect to the network.** It's not designed for that. Keep it on `localhost`.
- **Your `apps/api/.env.local` contains your `DATABASE_URL`.** Treat that file like a password. The repo's `.gitignore` already excludes `.env` / `.env.local` patterns.

## Troubleshooting

### "OpenClaw" is greyed out in the Integrations panel

`AICONNECT_LOCAL_MODE` isn't being picked up. Check:
1. `apps/api/.env.local` exists and has `AICONNECT_LOCAL_MODE=true`
2. The API server was restarted after you created the file
3. `fetch('http://localhost:8080/health')` from the browser shows `local_mode: true`
4. `VITE_API_BASE_URL` points at the port the API is actually listening on — the panel reads `local_mode` from `${VITE_API_BASE_URL}/health`, so a wrong base URL also leaves OpenClaw disabled

### Discover fails with "bridge_not_found"

The path you entered doesn't point at a valid file. Check:
1. The path is absolute (starts with `/` on Mac/Linux or `C:\` on Windows)
2. The file exists: `ls -la /path/to/maximus-bridge/index.mjs`
3. Use the `OPENCLAW_BIN` value from your `.env.local` if you set it there

### Discover fails with "bridge_timeout"

The bridge spawned but didn't respond before the timeout (30s for the MCP handshake, 60s for the agent listing). Check:
1. OpenClaw is installed: `which openclaw`
2. The Gateway is running: `openclaw gateway status`
3. Run `node /path/to/maximus-bridge/index.mjs` manually to see startup errors

### Sign-in redirects to your production URL

Your Auth0 app might have callbacks configured only for the production URL. Either:
1. Add `http://localhost:5173` to the Auth0 app's allowed callback URLs (Auth0 dashboard → Applications → your app → Settings). The SDK uses `window.location.origin` as the redirect URI, so the origin itself must be allowed.
2. Or sign into production first, then refresh localhost

### "Integration not found" after the wizard completes

The wizard created the integration but the page didn't refresh. Hit refresh in the browser; the OpenClaw row should appear.

## How it works

Key points:
- **Stateless bridge calls** — the bridge is spawned per request and killed after the response. No long-lived connection in v1.
- **Cloud mode short-circuits** OpenClaw calls with a `503 openclaw_local_only` before any spawn attempt.
- **`isLocalMode()`** returns true if `AICONNECT_LOCAL_MODE=true` *or* `OPENCLAW_BIN` is set.
- **The frontend learns the mode from `/health`**, which returns `local_mode` (a pure env read — `/health` stays DB-free).
