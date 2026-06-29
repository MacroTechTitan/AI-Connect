# Sprint 7 — OpenClaw Integration (Local Mode)

Branch: sprint/7-openclaw-integration
Start date: 2026-06-22
Estimated work: 5-7 days
Product positioning: "AI Connect drives your local OpenClaw agents. Run the same AI Connect locally as you run in the cloud — UI for managing agents, sending messages, and viewing replies all in one place."

## Context

Sprint 4-5.7 shipped Project Genesis. Sprint 6 shipped the integration foundation + WordPress gated apps. Sprint 7 adds the FIRST integration that requires AI Connect to run on the same host as the target system — OpenClaw.

OpenClaw runs locally on the user's Mac mini (or any host). The maximus-bridge MCP server (already built, v0.2.0, MIT-licensed, in repo MacroTechTitan/maximus-bridge) connects MCP clients to OpenClaw via stdio + the `openclaw agent --json` CLI. This sprint builds the AI Connect side of that integration.

Critical architectural constraint: stdio is a local transport. AI Connect cannot drive OpenClaw across the network. Therefore, Sprint 7 ships a "local mode" of AI Connect — the same TypeScript codebase, running locally on the user's host, against the same production Supabase database.

The cloud AI Connect (api.aiconnect.macrotechtitan.com) continues to handle WordPress, SendGrid, OpenAI, Anthropic. It cannot validate or use OpenClaw integrations — when a user tries, the UI shows a clear "OpenClaw integrations require AI Connect running locally" message with a link to the local mode docs.

## What ships in Sprint 7

In order of priority (ship-by-priority — if we run out of runway, cut from the end):

### 1. Database migration 0008 — extend integration_type CHECK constraint

Sprint 6 created the integrations table with a CHECK constraint allowing 'sendgrid', 'openai', 'anthropic', 'wordpress'. Sprint 7 extends it to include 'openclaw'.

Single ALTER TABLE:
- Drop the existing CHECK constraint integrations_integration_type_check
- Re-add it with the additional 'openclaw' value

### 2. OpenClaw types and validator

- New IntegrationType extended with 'openclaw'
- New config shape OpenClawConfig: { bridge_path: string, default_agent: string }
- New apps/api/src/lib/integrations/validators/openclaw.ts
- Validator spawns the maximus-bridge as a child process (Node, stdio), lists tools via MCP, confirms 'list_agents' and 'send_message' are present
- Returns valid=true with identity { default_agent, agent_count, openclaw_version } on success
- Returns valid=false with actionable messages on these failure modes:
  - bridge_path doesn't exist → "Bridge not found at {path}. Set OPENCLAW_BIN or clone from github.com/MacroTechTitan/maximus-bridge."
  - bridge spawns but exits immediately → "Bridge exited unexpectedly. Run `node {bridge_path}` manually to see the error."
  - bridge doesn't return list_agents → "Bridge is missing list_agents tool. Update to v0.2.0+."
  - bridge times out (30s) → "Bridge did not respond within 30 seconds. Check that openclaw is installed and the Gateway is running."

### 3. OpenClaw client wrapper

- New apps/api/src/lib/integrations/openclawClient.ts
- Two methods: listAgents(bridgePath) and sendMessage(bridgePath, agentName, message)
- Both spawn the bridge per-call (stateless, no long-lived connection in v1)
- Per-call timeout (60s default, configurable via env)
- Errors returned as typed OpenClawError with status codes (e.g., 'bridge_not_found', 'bridge_timeout', 'agent_not_found', 'agent_error')

### 4. OpenClaw routes

- New routes in apps/api/src/routes/integrations.ts (or new file apps/api/src/routes/openclaw.ts if it grows beyond ~150 lines):
  - GET /api/integrations/:id/agents → calls openclawClient.listAgents, returns array of agents
  - POST /api/integrations/:id/messages → body { agent_name, message }, calls openclawClient.sendMessage, returns the reply
- Both require integration type === 'openclaw' and status === 'validated'
- Both add a "local-only" header check: if the request comes from cloud AI Connect (detected via env CLOUD_MODE=true or absence of OPENCLAW_BIN), return 503 with error "openclaw_local_only" and a helpful message

### 5. Cloud vs local mode detection

- New apps/api/src/lib/mode.ts exports isLocalMode(): boolean
- True if process.env.OPENCLAW_BIN is set OR process.env.AICONNECT_LOCAL_MODE === 'true'
- False otherwise (production / cloud deployment on Render)
- The OpenClaw routes use this to gate themselves
- The integrations validator uses this too — calling openclaw validate from cloud mode returns immediately with "openclaw_local_only" error rather than attempting to spawn the bridge

### 6. Frontend OpenClaw wizard

- New apps/web/src/components/OpenClawWizard.tsx — five-step modal, parallel to WordPressWizard
- Step 1: Welcome with EXPLICIT security warning ("Connecting OpenClaw grants AI Connect full local powers through the agent. This is irreversible without disconnection. Only proceed on a machine you control.")
- Step 2: Bridge path. Auto-detect by trying `which maximus-bridge` and `node --version`. If auto-detect fails, manual path input with a "Browse for index.mjs" hint.
- Step 3: Test connection. AI Connect spawns the bridge, lists tools, confirms list_agents present.
- Step 4: Pick default agent from the list returned by list_agents.
- Step 5: Send test message ("reply OK") to confirm full round-trip. Show reply.
- Step 6: Success. Show "Manage Agents" button → opens OpenClawAgentManager.

### 7. Frontend OpenClaw agent manager

- New apps/web/src/components/OpenClawAgentManager.tsx
- Lists configured agents (from /api/integrations/:id/agents)
- "Send message" interface: textarea + agent dropdown + "Send" button → shows reply
- Recent messages section (last 10, in-memory only — not persisted in v1)
- Each agent row shows: name, identity, workspace, model, default badge

### 8. Cloud-mode UI gating

- The Integrations panel adds a small badge to the OpenClaw integration row when running in cloud mode: "Local mode only" with a link to docs/LOCAL_MODE.md
- The "Add Integration" form's OpenClaw option is greyed out in cloud mode with a tooltip explaining why

### 9. Local mode documentation

- New docs/LOCAL_MODE.md
- Sections: Why local mode exists, prereqs (Node 18+, OpenClaw installed, maximus-bridge cloned), step-by-step setup (clone AI Connect repo, install deps, set env vars including AICONNECT_LOCAL_MODE=true and OPENCLAW_BIN, point to prod Supabase via DATABASE_URL, run pnpm dev), security notes, troubleshooting
- New docs/sprints/SPRINT_7_TESTING.md — smoke test procedure for OpenClaw integration

## Architecture decisions

### Stateless bridge calls (no long-lived MCP connection)
v1 spawns the bridge per call. Adds latency (~1-2s per request to spawn Node and load the bridge module) but eliminates connection management complexity. Acceptable for v1 where most calls are user-initiated (not high-frequency). Sprint 8+ can add a connection pool.

### Bridge runs as child process, not as a service
The bridge is a stdio MCP server. AI Connect spawns it with `child_process.spawn('node', [bridgePath])`, writes MCP JSON-RPC to stdin, reads from stdout, kills it after the response. No daemon, no background process.

### Cloud mode rejects OpenClaw calls immediately
Cloud AI Connect on Render cannot spawn OpenClaw (it's not installed there, and even if it were, OPENCLAW_BIN isn't set). The validator and the agents/messages routes both check isLocalMode() and return 503 in cloud mode. Cleaner than silently failing or trying to spawn something that doesn't exist.

### Same Supabase database in both modes
The local AI Connect instance points at the same prod DATABASE_URL. Integration rows created locally are visible everywhere. Cloud mode just refuses to actually call openclaw functions for those rows.

### Per-call stateless = per-call security
Every spawn re-reads OPENCLAW_BIN from process.env and the bridge_path from the integration's config. No long-lived process holding privileges. If the user removes the integration or stops AI Connect, the powers go with the process.

### MAXIMUS_READONLY=true enforced at the bridge
Sprint 7 sets MAXIMUS_READONLY=true in the spawn env always. The bridge refuses non-read tools at the server level. AI Connect cannot accidentally call mutating tools even with a code bug.

## Commit plan

In execution order:

1. Sprint 7 spec doc (this file) — direct commit on branch
2. Database migration 0008 — extend integration_type CHECK constraint to include 'openclaw'
3. OpenClaw types + validator + local mode detection
4. OpenClaw client (listAgents + sendMessage)
5. OpenClaw routes (/agents, /messages, both with local-mode gating)
6. Frontend OpenClaw wizard
7. Frontend OpenClaw agent manager + cloud-mode UI gating
8. docs/LOCAL_MODE.md + docs/sprints/SPRINT_7_TESTING.md

Each step gets its own commit. Branch + PR + merge same as Sprint 6.

## Deferred to Sprint 7.5+

Captured here so they don't get lost:

- Long-lived MCP connection (connection pool, faster repeated calls)
- Network transport for the bridge (SSH/HTTPS so cloud AI Connect can drive remote OpenClaw)
- Multi-account OpenClaw integrations (one per agent host) — needs multi-account support landed first
- Message history persistence (currently in-memory only)
- OpenClaw skill discovery and per-skill UI
- Spawn-and-keep-alive option for the bridge (env flag)
- Auto-detect OpenClaw across common install locations
- Read-write mode (MAXIMUS_READONLY=false) — only when there's a deliberate security review

## Smoke test plan

Sprint 7 smoke test will verify (on the user's Mac mini, local AI Connect running):

1. Clone the AI Connect repo locally, set up env vars per docs/LOCAL_MODE.md, run pnpm dev
2. Confirm local AI Connect responds at http://localhost:3000 (or whichever port)
3. Sign in to local AI Connect with the same Auth0 (jgelet@macrotechtitan.com)
4. Confirm existing WordPress/SendGrid/etc integrations show up (proves same DB)
5. Settings → Integrations → Add Integration → OpenClaw
6. Wizard step 1: read security warning, click Continue
7. Wizard step 2: enter or auto-detect bridge_path
8. Wizard step 3: AI Connect spawns the bridge, lists tools, sees list_agents + send_message
9. Wizard step 4: pick default agent (e.g., "main")
10. Wizard step 5: send "reply OK" test message, see reply
11. Wizard step 6: success screen, click "Manage Agents"
12. Agent manager loads, shows the agent list (including identity "Tycoon", model gpt-5.1-codex)
13. Send a real message ("What's 2+2?"), see the reply
14. Switch to cloud AI Connect in another tab (aiconnect.macrotechtitan.com)
15. Confirm the OpenClaw integration row shows "Local mode only" badge
16. Confirm clicking "Manage Agents" in cloud mode shows the local-only message

End-to-end OpenClaw integration VERIFIED across both modes.

## Acceptance criteria

Sprint 7 ships when:

- All 8 commits land on master via PR
- Smoke test plan completes end-to-end on Joseph's Mac mini
- Cloud AI Connect correctly refuses OpenClaw calls with helpful messages
- Sprint 7 SPRINT_LOG entry committed (direct-to-master post-merge)
