# Sprint 7 Smoke Test Plan

Sprint 7 ships OpenClaw integration via local mode. This is the end-to-end smoke test plan to verify on Joseph's Mac mini before declaring Sprint 7 done.

## Prerequisites

- Mac mini with OpenClaw v2026.2.6-3 (or later) at `/opt/homebrew/bin/openclaw`
- Gateway running on ws://localhost:18789
- maximus-bridge cloned to `/Users/tycoon/dev/maximus-bridge/` (or equivalent)
- AI Connect repo cloned locally
- DATABASE_URL from Render dashboard (production AI Connect Supabase)
- Local `apps/api/.env.local` configured per `docs/LOCAL_MODE.md`

## Test sequence

### A. Cloud mode behavior (run on aiconnect.macrotechtitan.com)

A1. Sign into cloud AI Connect with jgelet@macrotechtitan.com
A2. Settings → Integrations → "Add Integration" dropdown — confirm "OpenClaw" option is DISABLED (greyed out)
A3. Hover the disabled option — confirm tooltip says "OpenClaw integrations require AI Connect running locally. See LOCAL_MODE.md."

✓ Pass criteria: OpenClaw is visibly NOT usable in cloud mode.

### B. Local mode startup (run on Mac mini)

B1. From AI-Connect/ directory: `pnpm --filter @ai-connect/api dev`
   ✓ Pass: server starts on http://localhost:8080 (or the `PORT` you set), no errors in console
B2. From AI-Connect/ directory in second terminal: `pnpm --filter @ai-connect/web dev`
   ✓ Pass: Vite starts on http://localhost:5173, no errors
B3. Visit http://localhost:5173 → sign in with jgelet@macrotechtitan.com
   ✓ Pass: redirected to integrations dashboard
B4. Open browser dev tools → console → run `fetch('http://localhost:8080/health').then(r => r.json()).then(console.log)`
   ✓ Pass: response includes `local_mode: true` (note: the route is `/health`, not `/api/health`, and must be hit on the API origin — there is no Vite proxy)

### C. Local mode shared database verification

C1. In local AI Connect Integrations panel — confirm the existing WordPress integration row (lifehackprotocol.com from Sprint 6) appears
   ✓ Pass: proves local AI Connect is reading from prod Supabase

### D. OpenClaw wizard flow

D1. Settings → Integrations → "Add Integration" — confirm "OpenClaw" option is now ENABLED in local mode
D2. Select OpenClaw, click "Connect OpenClaw" — confirm wizard modal opens with Step 1 (Welcome + Security)
D3. Click "I Understand — Continue" → confirm Step 2 (Bridge path) appears
D4. Enter `/Users/tycoon/dev/maximus-bridge/index.mjs` (or your bridge path) → Continue
D5. Step 3 (Discover) — wait ~5-10s for the spawn + agent listing
   ✓ Pass: agents list returned, wizard auto-advances to Step 4
   - If timeout/error: check OpenClaw Gateway is running
D6. Step 4 (Pick agent) — confirm "main" agent shown with identity "Tycoon" and model "openai/gpt-5.1-codex"
D7. Select "main" → Continue
D8. Step 5 (Test message) — click Send on the prefilled "reply OK"
   ✓ Pass: reply appears within ~10s, Continue button enables
D9. Click Continue → Step 6 (Success) shows bridge path, default agent, identity, model
D10. Click "Manage Agents"
   ✓ Pass: wizard closes, OpenClawAgentManager opens for the new integration

### E. Agent manager flow

E1. Confirm "Agents" pane on left shows "main" agent with full details
E2. Confirm right pane shows "Send a message — main" with empty messages area
E3. Type a real prompt (e.g., "What's 2+2?") → click Send
   ✓ Pass: user message appears immediately, agent reply appears within ~10s
E4. Send a second message ("List 3 colors")
   ✓ Pass: message history shows both exchanges in order
E5. (Optional) Exercise the timeout/error path. There is no app-level timeout
    override — the bridge timeouts are fixed (30s handshake / 60s call). The
    realistic way to see the error UI is to stop the OpenClaw Gateway mid-call
    (covered in G2), which surfaces the bridge_timeout / bridge_exited copy.
   ✓ Pass: a friendly error entry appears in the conversation rather than a crash

### F. Cloud mode list gating

F1. Open aiconnect.macrotechtitan.com in another browser tab
F2. Sign in with same account
F3. Settings → Integrations → confirm the new OpenClaw integration appears in the list (proving cloud reads it from shared DB)
F4. Confirm OpenClaw row shows "Local mode only" badge
F5. Confirm "Manage Agents" (and "Test Connection") buttons are disabled with tooltip explaining local-only

### G. Validation error coverage (local mode)

G1. In the Add Integration wizard, in Step 2 enter a bogus path like `/tmp/nonexistent.mjs`
   ✓ Pass: Step 3 fails with "Bridge not found" error message, Retry available
G2. Enter a valid path but stop the OpenClaw Gateway before continuing
   ✓ Pass: Step 3 fails with a bridge_timeout-style error
G3. Restart Gateway, retry → success

## Sprint 7 acceptance

Sprint 7 ships when:
- All Sprint 7 commits (1-8) merged to master via PR
- Sections A-F of this smoke test plan pass
- Section G partially tested (at least G1 to confirm error mapping works)
- SPRINT_LOG.md entry committed direct-to-master (post-merge)
