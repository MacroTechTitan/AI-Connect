# AI Connect — Local Mode

## What is local mode?

AI Connect normally runs as a cloud service at `api.aiconnect.macrotechtitan.com` (backend on Render) + `aiconnect.macrotechtitan.com` (frontend on Vercel). Most integrations — WordPress, SendGrid, OpenAI, Anthropic — work fine in cloud mode because they're network APIs the cloud backend can call.

Some integrations need to run LOCALLY on the same host as the system they're talking to. The first one is **OpenClaw**.

OpenClaw runs on your local machine. Its bridge (maximus-bridge) uses MCP over stdio — a local-only transport, no network. So AI Connect can only drive OpenClaw if AI Connect ITSELF is running on the same host as OpenClaw.

That's what "local mode" means: AI Connect's same TypeScript codebase running on your machine instead of (or alongside) the cloud deployment, with environment variables that tell it to enable local-only integrations.

## When to use it

Use local mode when:
- You want to use OpenClaw integration
- You want to use any future local-only integration (Sprint 7+ may add more)

You do NOT need local mode for:
- WordPress integration (cloud handles this)
- SendGrid, OpenAI, Anthropic (cloud handles all)
- Project Genesis provisioning (cloud handles this)
- Most AI Connect work

Cloud and local AI Connect share the same Supabase database. Integrations you create in either mode are visible everywhere. Cloud just refuses to actually CALL OpenClaw-type integrations — it shows a "local mode only" badge and disables the action buttons for them.

## Prerequisites

Before setting up local mode you need:

1. **Node.js 20+** installed (production runs Node 24.15.0; the AI Connect API server is TypeScript/Node).
2. **pnpm** installed (`npm install -g pnpm` if needed). The repo pins pnpm 9 via `packageManager`.
3. **OpenClaw** installed and a Gateway running. Verify with:
   ```
   openclaw --version
   ```
   If not installed, see [OpenClaw docs](https://docs.openclaw.dev).
4. **maximus-bridge** cloned. Get it from:
   ```
   git clone https://github.com/MacroTechTitan/maximus-bridge.git
   cd maximus-bridge
   npm install
   ```
   Note the absolute path to `maximus-bridge/index.mjs` — you'll need it.
5. **AI Connect repo** cloned locally:
   ```
   git clone https://github.com/MacroTechTitan/AI-Connect.git
   cd AI-Connect
   pnpm install
   ```

## Setup

### Step 1 — Get the prod Supabase connection string

AI Connect local mode points at the SAME Supabase database the cloud uses (so your integrations are visible everywhere). Get the `DATABASE_URL` from the Render dashboard:

1. Go to `https://dashboard.render.com`
2. Find the `ai-connect-api` service
3. Settings → Environment → copy the value of `DATABASE_URL`

This is sensitive. Keep it out of version control.

> Use the IPv4 session-pooler connection string (the one Render already has). It works locally too.

### Step 2 — Create a local `.env` file

In the AI Connect repo, create `apps/api/.env.local`:

```
# Required — same as production
DATABASE_URL=<paste DATABASE_URL from Render>
AUTH0_ISSUER_BASE_URL=https://macrotechtitandev.us.auth0.com/
AUTH0_AUDIENCE=https://api.aiconnect.macrotechtitan.com
NODE_ENV=development

# Required for OpenClaw — points at your maximus-bridge install
OPENCLAW_BIN=/Users/yourname/dev/maximus-bridge/index.mjs

# Required to opt into local mode
AICONNECT_LOCAL_MODE=true

# Optional — port the API server listens on (default 8080)
PORT=8080

# Optional — only needed if you want to decrypt/use BYOAI provider keys
# locally (Anthropic/OpenAI integrations). 32-byte hex; copy from Render.
# OpenClaw itself does not need this. Supabase Vault is reached through
# DATABASE_URL, so there are no separate SUPABASE_* / VAULT_KEY vars.
MASTER_KEY=<copy from Render if you need provider-key decryption>
```

The two new vars for local mode are:
- `OPENCLAW_BIN` — absolute path to `maximus-bridge/index.mjs`
- `AICONNECT_LOCAL_MODE=true`

Either one triggers `isLocalMode()` to return true. Set both to be explicit.

### Step 3 — Create the frontend env

In `apps/web/.env.local`:

```
VITE_API_BASE_URL=http://localhost:8080
VITE_AUTH0_DOMAIN=macrotechtitandev.us.auth0.com
VITE_AUTH0_CLIENT_ID=<copy from the Vercel project's env or Auth0 app settings>
VITE_AUTH0_AUDIENCE=https://api.aiconnect.macrotechtitan.com
```

`VITE_API_BASE_URL` tells the frontend to talk to your local API server (it must match the API's `PORT`). The `VITE_AUTH0_*` vars are required for sign-in — without them the Auth0 SDK won't initialize.

> Vite only exposes vars prefixed with `VITE_`. The exact name `VITE_API_BASE_URL` matters — `VITE_API_URL` (or any other name) is silently ignored, which leaves every API call pointing at `undefined`.

### Step 4 — Run it

In two separate terminal tabs:

```
# Terminal 1 — API server
cd /path/to/AI-Connect   # or C:\Dev\ai-connect on Windows
pnpm --filter @ai-connect/api dev
```

```
# Terminal 2 — Frontend
pnpm --filter @ai-connect/web dev
```

Visit `http://localhost:5173` (default Vite port). Sign in with your normal Auth0 credentials. Your existing cloud integrations (WordPress, SendGrid, etc.) should appear in the Integrations panel — proving local AI Connect is sharing the cloud's Supabase data.

### Step 5 — Verify local mode is on

The API's health route is `/health` (no `/api` prefix) and there is no Vite dev proxy, so check it against the API origin directly. From the browser dev tools console on the `http://localhost:5173` tab (an allowed CORS origin):

```
fetch('http://localhost:8080/health').then(r => r.json()).then(console.log)
```

Should return `{ status: 'ok', ..., local_mode: true }`. If `local_mode: false`, your env vars aren't being picked up — verify the `.env.local` file is in `apps/api/` (not the repo root) and restart `pnpm dev`.

## Adding an OpenClaw integration

Once local mode is verified:

1. Settings → Integrations → Add Integration → OpenClaw (now enabled — cloud mode disables it)
2. Wizard walks you through:
   - Security warning
   - Bridge path (enter the absolute path to `maximus-bridge/index.mjs`)
   - Agent discovery (AI Connect spawns the bridge, lists your agents)
   - Pick default agent
   - Send test message ("reply OK")
   - Success
3. From the Integrations panel, click "Manage Agents" on the OpenClaw row to send real messages to your agent

## Security notes

Local mode is more powerful than cloud mode — that's the whole point. Treat it accordingly:

- **OpenClaw integration gives AI Connect the agent's full local powers** (file system, shell, tools) THROUGH the agent. Only enable on a machine you control.
- **`MAXIMUS_READONLY=true` is enforced at every bridge spawn.** AI Connect cannot accidentally call mutating tools, even with a code bug. The bridge refuses them at the server level.
- **The discover endpoint (`POST /api/integrations/openclaw/discover`) lets any authenticated user in local mode spawn `node <arbitrary path>`.** This is consistent with the local-mode trust model — you own the host — but worth being aware of.
- **Don't expose your local AI Connect to the network.** It's not designed for that. Keep it on `localhost`.
- **Your `apps/api/.env.local` contains DATABASE_URL** which is your prod Supabase connection string. Treat that file like a password. `.gitignore` already excludes `.env`/`.env.local` patterns.

## Troubleshooting

### "OpenClaw" option is greyed out in the Integrations panel

`AICONNECT_LOCAL_MODE` not picked up. Check:
1. `apps/api/.env.local` exists and has `AICONNECT_LOCAL_MODE=true`
2. The API server was restarted after creating the file
3. `fetch('http://localhost:8080/health')` from the browser shows `local_mode: true`
4. `VITE_API_BASE_URL` points at the same port the API is actually listening on — the panel reads `local_mode` from `${VITE_API_BASE_URL}/health`, so a wrong base URL also leaves OpenClaw disabled

### Wizard step 3 (Discover) fails with "bridge_not_found"

The path you entered doesn't point at a valid file. Check:
1. The path is absolute (starts with `/` on Mac/Linux or `C:\` on Windows)
2. The file exists: `ls -la /path/to/maximus-bridge/index.mjs`
3. Use the `OPENCLAW_BIN` value from your `.env.local` if you set it there

### Wizard step 3 fails with "bridge_timeout"

The bridge spawned but didn't respond before the timeout (30s for the MCP handshake, 60s for the agent listing). Check:
1. OpenClaw is installed: `which openclaw`
2. The Gateway is running: `openclaw gateway status` (or wherever the equivalent lives)
3. Run `node /path/to/maximus-bridge/index.mjs` manually to see startup errors

### Sign-in redirects to production aiconnect.macrotechtitan.com

Your Auth0 app might have callbacks configured only for the production URL. Either:
1. Add `http://localhost:5173` to the Auth0 app's allowed callback URLs (Auth0 dashboard → Applications → AI Connect → Settings). The SDK uses `window.location.origin` as the redirect URI, so the origin itself must be allowed.
2. Or sign into production first, then refresh localhost

### "Integration not found" after wizard completes

The wizard created the integration but the page didn't refresh. Hit refresh in the browser; the OpenClaw row should appear in the Integrations panel.

## Architecture reference

See `docs/sprints/SPRINT_7_SPEC.md` for the full Sprint 7 spec including architecture decisions.

Key points:
- Stateless bridge calls — bridge is spawned per request, killed after response. No long-lived connection in v1.
- Cloud mode short-circuits OpenClaw calls with 503 `openclaw_local_only` before any spawn attempt.
- `isLocalMode()` lives in `apps/api/src/lib/mode.ts`. Returns true if `AICONNECT_LOCAL_MODE=true` OR `OPENCLAW_BIN` is set.
- The frontend learns the mode from `/health`, which returns `local_mode` (a pure env read — `/health` stays DB-free).
