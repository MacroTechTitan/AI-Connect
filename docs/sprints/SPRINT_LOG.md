# AI Connect Sprint Log

This file records the completion of every sprint in chronological order. Each sprint gets one entry, written after the sprint merges to `master` and the deploy is verified green.

The MTTBuild sprint template lives in [`../MTTBuild.md`](../MTTBuild.md) under "Sprint template (use for every sprint)."

## Format

```
## Sprint N — [Feature Name]

**Merged:** YYYY-MM-DD
**Branch:** [branch name]
**Owner:** [who executed the sprint]
**Files changed:** [count]

### What shipped
[1-3 sentences describing what landed]

### Deviations from plan
[Anything that changed during execution, or "None"]

### Open follow-ups
[Anything that needs a future sprint, or "None"]

### Verification
- [ ] Auto-deploy went green
- [ ] /health responds 200
- [ ] Smoke test of new feature passed
- [ ] Logs flowing for new code paths
```

---

## Sprints

## Sprint 0 — Phase 0 infrastructure
- Branch: sprint/0-phase-0-infra
- Merged to master: 2026-05-24 as commit 8cdafc1 (PR #2)
- Production verified: 2026-05-24 — /health and /api/admin/diagnostics responding 200 from master build at custom domains

### What shipped
- pnpm monorepo (apps/api Express+Drizzle+TS, apps/web Vite+React, packages/shared)
- API live: https://api.aiconnect.macrotechtitan.com/health
- Frontend live: https://aiconnect.macrotechtitan.com
- Drizzle schema: users + 3 logging tables (system_logs, user_audit_logs, dev_logs) with check constraint, FK, 6 indexes
- Manual migration to Supabase (per MTTBuild — no auto-apply)
- lib/logging.ts wrapper (logSystem, logUserAction transactional, logDev)
- Idempotent admin seed on boot
- GET /api/admin/diagnostics behind bearer-token auth (SHA-256 + timingSafeEqual)
- CLAUDE.md with project context, secret-handling rules, deferred services
- DNS at Cloudflare for both subdomains (DNS-only, grey cloud)

### Lessons learned
- Supabase auto-enables RLS on tables in the public schema. Without policies, the table is invisible to the pooler connection, surfacing as "relation does not exist" at runtime. Fix: ALTER TABLE ... DISABLE ROW LEVEL SECURITY for internal infrastructure tables; design RLS policies properly for user-facing tables in Sprint 1+.
- NODE_ENV=production causes pnpm install to skip devDependencies, breaking tsc build. Fix: --prod=false in install command.
- Render's free plan auto-suspends after idle period and recycles processes. Visible as SIGTERM in logs; not an error.
- Vercel build OOMs (exit 137) on naive monorepo installs from repo root. Fix: --filter @ai-connect/web... to install only what the web app needs.
- PowerShell's Out-File adds a UTF-8 BOM by default that breaks JSON parsers (Vercel rejected vercel.json with BOM). Fix: [System.IO.File]::WriteAllText with explicit BOM-less UTF-8 encoding.
- Inline secrets in CLI commands are a leak vector — they enter shell history, terminal output, and screenshots. Methodology now: use platform UI for first secret entry, env var substitution for scripting (encoded in CLAUDE.md secret-handling rules).
- Render CLI v2.17 services update accepts --branch but silently returns the pre-update JSON; verify via the dashboard rather than the CLI response.

### Deferred
Sentry, Infisical/Doppler, PostHog, external log aggregation, Cloudflare proxy in front of services, GitHub Copilot in Cursor, MCP-per-service architecture (first one Sprint 6+).

### Sprint 1 starting point
Auth0 wiring + first authenticated route + minimal user dashboard. Dependabot has two open PRs (drizzle-orm 0.45.2, vite 6.4.2) — review and merge before Sprint 1 begins.

## Sprint 1 — Auth0 wiring + /api/me (2026-05-25 / 2026-05-26)
- Branch: sprint/1-auth (merged) + direct-to-master hotfixes for production CORS + namespaced claim issues
- Merged to master: 2026-05-25 as commit 187f962 (PR #5)
- Production hotfixes on master: db341ee (CORS middleware), be1dd2c (namespaced email claim)
- Production verified: 2026-05-26 — partial smoke test passed: sign-up flow works end-to-end, /api/me returns user record with role, /api/me returns 401 without auth, audit log entry recorded, CORS works.

### What shipped
- Auth0 JWT middleware (apps/api/src/middleware/requireAuth.ts) using jose library, JWKS-based verification with trailing-slash issuer normalization, namespaced custom claim support
- GET /api/me endpoint: transactional upsert by email, lazy user creation, 400 on missing email claim, audit log fires post-commit, userProjection pattern prevents future column leaks
- Frontend Auth0 SDK integration (@auth0/auth0-react): Auth0Provider in main.tsx, sign-in/sign-out UI on landing page, fetches /api/me with bearer token, displays role
- CORS middleware enabling browser fetches from production origin + localhost dev
- Auth0 dashboard configured: Application URIs (callback, logout, web origins), API authorization grant, Post Login Action to add email to access tokens under https://aiconnect.macrotechtitan.com/email namespace

### Lessons learned
- pnpm strict resolution: declare module "express-serve-static-core" fails. Canonical pattern is declare global { namespace Express { ... } } — same behavior, pnpm-safe.
- TypeScript array narrowing: if (arr.length > 0) does not narrow arr[0]. Use destructuring const [x] = arr; if (x) { ... } to narrow correctly.
- Auth0 SDK uses window.location.origin as default redirect URI. Allowed Callback URLs must include the bare URL, not just /callback variants.
- CORS is silently missing on most Node Express setups. Always add cors middleware in Phase 0 going forward. Curl-based smoke tests do not catch this because curl does not enforce CORS.
- Auth0 access tokens do not include email by default. ID tokens do. For API endpoints reading user identity, use a Post Login Action to copy email into a namespaced custom claim on the access token. The middleware reads payload["https://<domain>/email"] not payload.email.
- Auth0 Applications must be explicitly authorized for each API (resource server) via the API's Application Access tab. Without this, login throws invalid_request: "Client is not authorized to access resource server".
- Auth0 tenant Post Login Actions run on ALL apps in the tenant. Existing actions (e.g., "Add roles to token" for OptimaQuant) continue to fire on AI Connect logins. Cross-app namespace separation is important; each app reads only its own namespaced claims.

### Deferred to Sprint 1.5 / housekeeping
- URL inconsistency: /health hardcoded URL, /api/me uses VITE_API_BASE_URL. Unify.
- Bundle size 332 KB raw — research Auth0 SDK code-splitting before Sprint 3-4 adds more SDKs.
- Branch protection rule on master triggers "Bypassed rule violations" on every push. Either disable rule for solo dev or use PRs consistently.
- 26 vulnerabilities flagged (2 high, 19 moderate, 5 low). Most are transitive deps. Triage during housekeeping pass.
- Sprint 1 smoke test partial — skipped re-login duplicate check and multi-user verification due to credential management friction. Logic verified via code review; manual testing if needed in future.

### Sprint 2 starting point
BYOAI provider abstraction: connect-your-own-AI-key flow, capture per-call cost (tokens × provider rate) as first-class data, support Claude + OpenAI + Ollama as first three providers. Per Sprint 0.5 architectural commitment (cost-aware AI routing).

## Sprint 2 — BYOAI provider abstraction (2026-06-02)
- Branch: sprint/2-byoai (merged) plus direct-to-master Sprint 2.5 production fixes
- Merged to master: 2026-06-02 as PR #6 merge commit
- Production hotfix on master: refreshed provider_pricing seed with current model IDs (Anthropic 2024 models had been deprecated by mid-2026)
- Production verified: 2026-06-02 — end-to-end smoke test passed: signed in, added Anthropic key, sent prompt, received response from claude-sonnet-4-6 with cost ($0.0003) and latency (~2s) populated correctly.

### What shipped
- Three new tables: provider_keys (vault_secret_id reference), provider_pricing (static rate table), prompts (every AI invocation logged with fingerprints + cost + latency).
- Provider abstraction layer with three implementations (Anthropic Messages API, OpenAI Chat Completions, Ollama generate). Pure fetch, no SDK dependencies, AbortController timeouts, latency via performance.now().
- POST/GET/DELETE /api/keys protected by requireAuth. Provider API keys encrypted at rest via Supabase Vault; DB holds vault_secret_id reference plus user-friendly metadata only.
- POST /api/prompt — resolves key + model, decrypts via Vault, calls provider, computes cost from tokens × pricing, logs the invocation, returns response. DB writes happen AFTER the provider call to avoid holding transactions during 30+ second network calls.
- Frontend settings panel accessible after login. Add/list/remove keys, test a prompt, see response + provider + model + tokens + cost + latency. Toggle visibility from the status block. Bundle: 337.75 KB raw / 105.43 KB gzipped.
- 9 pricing rows seeded (3 Anthropic, 3 OpenAI, 3 Ollama). Each provider has exactly one is_default = true row.
- 18-step smoke test procedure in docs/sprints/SPRINT_2_TESTING.md.

### Lessons learned
- Supabase auto-enables RLS on new tables in the public schema EVEN WHEN the migration explicitly disables it inline. The DISABLE ROW LEVEL SECURITY statements in the migration ran before Supabase's auto-enable hook completed. Workaround: run the same disable statements again manually after applying the migration. Going forward: every new-table migration needs a follow-up manual RLS-off step, OR project-level config to disable the auto-enable behavior.
- AI provider model IDs deprecate faster than expected. The Sprint 0.5 architectural commitment for cost-aware AI routing called for a static pricing table; this works for Sprint 2 but creates a maintenance hazard. Model IDs in the table must match exactly what each vendor accepts at the API today. Stale IDs return 404 with no useful error from the provider's perspective (the user sees a generic provider_error 502). Mitigation: add a CLAUDE.md or docs/ note about checking each vendor's deprecation page when refreshing the seed, AND consider Sprint 6's cost-aware routing including a "validate model is alive" check on key add.
- Supabase Vault works clean for storing user secrets. vault.create_secret + vault.decrypted_secrets gives us encrypted-at-rest with a simple read path; no separate KMS service to manage, no AWS lock-in, fits the self-hosting story we committed to in Sprint 0.5. The wrapper at apps/api/src/lib/vault.ts isolates the Vault-specific calls so swapping to AWS KMS or HashiCorp Vault later is one file change.
- "Never display API keys back" is the right default. Sprint 2's UI explicitly hides key values after entry — only label + provider + default badge appear in the list. Security side benefit beyond just hiding from shoulder-surfers: prevents leak via screenshot tooling, accessibility readers, browser extensions.
- The discriminated union pattern for ProviderInvocationResult (success vs error variant) makes the calling code's branching obvious and prevents the "did this call succeed?" guessing game that plagues fetch-based code. Worth keeping as a pattern for future external-API integrations (Stripe, Cloudflare, etc. in later sprints).

### Deferred to Sprint 2.5 / housekeeping
- A "validate key on add" feature: when a user adds a provider key, fire a tiny test call (e.g., 1-token completion) to confirm the key works AND the chosen default model is currently routable at the upstream API. Catches deprecated-model errors at key-add time instead of at first-prompt time.
- Streaming responses (deferred to whichever sprint adds conversational UI).
- Multi-tenant org-scoped key sharing (Sprint 3-4 multi-tenant work).
- Per-task cost routing rules (Sprint 6 — the cost-aware AI routing anchored concept).
- Token estimation BEFORE sending the prompt (cost preview UX). Currently we only learn token count from the provider's response — there's no way to warn "this will cost ~$0.20" before the user clicks Send.
- Add a TESTING.md note: when re-applying the pricing seed, validate the listed model IDs against each vendor's current docs first.
- Bundle size 337.75 KB raw — still within acceptable range but the Auth0 SDK + settings UI together are noticeable. Code-splitting research before Sprint 4 adds Project Genesis UI.

### Sprint 3 starting point
Multi-tenant data model: organizations table, projects table, users → organizations relationship, org-level isolation enforced at query layer. Per Sprint 0.5 architectural commitment ("organizations → projects → users → audit logs, AI usage" — not flat). Sprint 3 also includes refactoring provider_keys to be optionally org-scoped (so an organization can share an API key across users) — but only if Sprint 3 stays tight; otherwise that goes to Sprint 3.5.

## Sprint 3 — Multi-tenant data model (2026-06-03)
- Branch: sprint/3-multi-tenant (merged) plus direct-to-master Sprint 3.5 production polish
- Merged to master: 2026-06-03 as PR #7 merge
- Production polish on master: a3b2c6d (logUserAction populates organization_id + frontend handles Auth0 session expiry)
- Production verified: 2026-06-03 — smoke test passed end-to-end: lazy org creation on first sign-in, org name appears in status block, project CRUD works, audit log entries populate organization_id correctly (verified via SQL comparison of pre/post-3.5 rows).

### What shipped
- Two new tables: organizations (id, name, unique slug, created_by_user_id, timestamps) and projects (id, organization_id, name, slug unique-within-org, description, created_by_user_id, timestamps).
- Column additions: organization_id added to users, provider_keys, prompts, user_audit_logs, system_logs, dev_logs. project_id added to prompts and the three log tables.
- 10 new indexes including partial indexes on nullable columns.
- 11 foreign keys with appropriate ON DELETE semantics (cascade for owned data, restrict for ownership refs, set null for denormalization).
- One-time backfill SQL migration (apps/api/drizzle/seeds/0002_backfill_organizations.sql) assigning organization_id to existing users — admin gets MacroTechTitan org, others get personal "{email-prefix}'s workspace" orgs, plus denormalization fill into provider_keys, prompts, user_audit_logs.
- Lazy org creation in /api/me — new users get a personal org auto-created in the same transaction as their user row, with slug collision retry (-2 through -5, then fallback to slug-userIdPrefix).
- Query-layer org isolation via new apps/api/src/lib/orgScope.ts — AuthedUserContext type, orgScopeFilter SQL fragment, withOrgScope helper, assertOrgAccess defensive check. requireAuth middleware now hydrates req.user with full context; new requireHydratedUser middleware gates routes that need the user row.
- /api/keys, /api/prompt, /api/projects all filter by organization_id and populate it on insert.
- POST/GET/DELETE /api/projects endpoints with slug auto-derivation, collision handling, audit logging.
- Frontend: status block shows org name alongside email/role; new Projects subsection in settings panel above Provider keys; renamed "Manage provider keys" link to "Manage settings".
- Bundle: 341.73 KB raw / 106.15 KB gzipped (+4 KB raw / +0.7 KB gzipped from Sprint 2; +1 KB additional from Sprint 3.5 polish).

### Lessons learned
- Supabase auto-enables RLS on newly CREATEd tables despite in-migration DISABLE statements — but NOT on ALTERed tables. Sprint 2 caught the first; Sprint 3 confirmed the second behavior. New rule: every migration that creates a new table needs a follow-up manual DISABLE statement run separately in the SQL editor. Altering existing tables is fine.
- Adding new columns to existing user-scoped tables means existing INSERT/UPDATE paths may not populate them. Sprint 3 added organization_id to user_audit_logs but didn't update logUserAction — result: every new audit row had null org_id until Sprint 3.5 fixed it. Lesson: when adding a column to a table that has helper functions, audit every helper that writes to it as part of the same sprint, not as a follow-up.
- Spec deviation that improved the spec: my Commit 4 spec said requireAuth should 401 when the user row doesn't exist. Claude Code identified that this breaks /api/me's lazy-create flow (the route that creates the user can never run if it requires the user to exist). Split into req.jwt (always present after JWT verify) and req.user (only when row exists), with a separate requireHydratedUser middleware for routes that need the row. Cleaner contract; better separation of concerns.
- The chicken-and-egg of users.organization_id ↔ organizations.created_by_user_id was solved with a three-step transaction: insert user with org_id NULL, insert org with created_by pointing at user, then UPDATE user.org_id. The user row exists briefly inside the transaction with NULL org_id; no other queries see it until COMMIT. Cleaner than deferred constraints for this case.
- Auth0's silent token refresh can fail with "Missing Refresh Token" when offline_access wasn't in the original scope OR when the session is very stale. Old UX showed "Couldn't reach the server" — misleading. Sprint 3.5 added a structured session_expired error class with isSessionExpired predicate, and a SessionExpiredNotice component with one-click loginWithRedirect recovery.

### Deferred to Sprint 3.5 / housekeeping
- Validate-key-on-add UX (catch deprecated models at key-add rather than first prompt) — still deferred from Sprint 2.5.
- Bundle code-splitting for Auth0 SDK before Sprint 4 adds Project Genesis UI. Bundle is at 341.73 KB raw / 106.15 KB gzipped — still acceptable but the SDK + settings UI together account for most of it.
- Branch protection bypass continues to show "Bypassed rule violations" on every push. Either disable the rule for solo dev or commit to PRs consistently.
- 26 vulnerabilities flagged by Dependabot — still need triage pass.
- /api/me now does a JOIN to organizations. Was previously a single-table SELECT. Not a problem yet (one user per signin), but worth monitoring as the query path grows.
- Org-renaming endpoint (PATCH /api/organizations/:id) — out of scope for Sprint 3 but probably needed before Sprint 4 ships, since auto-generated workspace names aren't what users want long-term.
- Email validation regex for Auth0 emails that contain characters beyond [.+] — current slug derivation doesn't handle email addresses with unusual punctuation. Low priority but worth thinking about before Project Genesis demos.

### Sprint 4 starting point
Project Genesis MVP. Per Sprint 0.5 architectural commitment, this is when AI Connect becomes visible — sign up, click "Start new dev project," AI Connect provisions Vercel + Render + Supabase + Auth0 + DNS in ~10 minutes via real automation (not mocked). The signup wizard's Path A (custom build), not Path B (takeover existing — that's Sprint 5).

The data model is ready: projects exist (Sprint 3), provider keys exist (Sprint 2), audit logs scope by org/project (Sprints 2+3). Sprint 4 builds the provisioning automation layer on top.

## Sprint 4 — Project Genesis MVP (2026-06-04)
- Branch: sprint/4-project-genesis (not yet merged at time of writing)
- 7 commits on the branch: schema (c353c45), platform integration layer (f319be6), credentials endpoints (6ae73ad), credentials UI (b6947fc), orchestrator core 5a (f693a00), rollback 5b (b235abe), SSE streaming + UI 5c (last commit hash unknown until merge), docs (1c01e01).
- Migrations 0003 (platform_credentials + provisioning state + events) and 0004 (failed_to_rollback status) both applied to Supabase.
- Production verification: pending — Sprint 4 requires real platform tokens (Vercel, Render, GitHub, Supabase) for live smoke testing per docs/sprints/SPRINT_4_TESTING.md.

### What shipped
- Two new tables: platform_credentials (encrypted Vercel/Render/GitHub/Supabase tokens via Vault) and project_provisioning_events (per-step audit trail powering SSE progress). Plus provisioning_state column on projects with 5-state CHECK ('not_started' → 'provisioning' → 'provisioned' | 'failed' | 'rolled_back'), extended to 6 states in migration 0004 with 'failed_to_rollback' for partial-rollback events.
- Platform integration layer at apps/api/src/lib/platforms/ — strategy pattern with 4 implementations (Vercel, Render, GitHub, Supabase), pure fetch + AbortController + 30s timeouts, no SDK dependencies. Each client exposes validate(), createResource(), deleteResource(). Mirrors Sprint 2's provider abstraction approach.
- POST/GET/DELETE /api/platform-credentials endpoints with Vault encryption. Validation BEFORE storage — credentials are tested against the platform's API at registration time, catching bad/revoked tokens immediately rather than at genesis time. Identity from validate() (login/email/org) surfaced in POST response.
- POST /api/projects/:id/genesis endpoint — kicks off provisioning. Validates project state, checks all 4 platform credentials are registered, launches the orchestrator as a detached promise (Decision A1), returns 202 immediately with the project_id.
- Orchestrator at apps/api/src/lib/genesis/ — runs 7 sequential steps (create GitHub repo, Supabase project, Vercel project, Render service, plus 3 placeholder steps for Sprint 5+ DNS/Auth0 work and a verify_deployment step that polls the Render URL for up to 5 minutes). Each step writes pending → in_progress → succeeded/failed events to project_provisioning_events as standalone DB writes (not batched, so SSE consumers see partial progress).
- Rollback on step failure (Decision C2) — when a step fails, the orchestrator walks successful rollbackable steps in REVERSE order, calling each platform's deleteResource. Rollback events are written as step_name='rollback:<original>'. Rollback failures are SOFT (event marked 'failed_to_rollback' with manual_cleanup_url embedded in details for UI surfacing) — don't crash the orchestrator. Project terminal state branches on rollback success: clean rollback → 'rolled_back', partial → 'failed'.
- GET /api/projects/:id/provisioning-events SSE endpoint (Decision B1) — tails the events table with 1-second poll, dedupes by (id, status, started_at, completed_at) signature so in-place mutations re-emit, sends 15s heartbeats to defeat proxy idle-connection-killers, 15-minute hard timeout. Headers (Content-Type, Cache-Control: no-cache, no-transform, X-Accel-Buffering: no) configured to defeat Cloudflare/Render response buffering.
- Frontend GenesisProgress component — subscribes via fetch + ReadableStream (Option 3 from Decision B1; native EventSource doesn't support Authorization headers, fetch-based approach keeps JWT out of URLs/logs). Live-streaming step list with humanized names, color-coded status icons (○ pending, ◐ spinning, ● green/red/yellow/muted), live-ticking elapsed times, details (URLs, resource IDs, manual_cleanup_urls), error messages.
- Frontend PlatformCredentialsPanel — fourth subsection in settings panel (between Projects and Provider keys). Platform-specific token placeholders explaining where to generate each (vercel.com/account/tokens, github.com/settings/tokens, etc.) — key UX win for keeping users unstuck before genesis. Identity ("as joegelet") surfaced from validate() response, stored in session map.
- ProjectsPanel extended with provisioning state badge (color-coded) and Provision button (enabled for not_started/failed/rolled_back states).
- Bundle: 346.56 → 353.22 KB raw / 107.23 → 109.55 KB gzipped JS (+6.66 KB raw / +2.32 KB gzipped from 5c streaming UI); CSS 6.88 → 8.90 KB raw (+2.02 KB / +0.39 KB gzipped). Total Sprint 4 bundle delta: ~+15 KB raw, ~+4.5 KB gzipped across 4 commits with frontend changes (4, 5c).

### Lessons learned
- Splitting Commit 5 into 5a (orchestrator) → 5b (rollback) → 5c (SSE) was the right call. Each sub-commit was ~150-300 lines, independently reviewable, with clean revert points. Comparing to Sprint 3 Commit 4 (single ~500-line commit covering middleware + 4 route updates), the smaller units made spec deviations easier to catch and discuss. New rule of thumb: any single commit projected >400 lines should be considered for sub-commit split.
- Decision A1 (detached promise vs job queue) was the right pragmatic choice for Sprint 4 MVP but introduces process-crash risk that needs documenting. If the Render API process dies mid-genesis, the project stays stuck in 'provisioning'. Recovery query documented in docs/future-ideas.md. Real fix is Sprint 6+ job queue (BullMQ + Redis, or pg-boss).
- Decision B1 (SSE) and the EventSource-vs-fetch tradeoff — the native EventSource API doesn't support custom headers, so to preserve our Sprint 1 bearer-token auth model we implemented SSE parsing via fetch + ReadableStream. This is the right call but worth flagging that browsers' built-in auto-reconnect logic is now our responsibility. Sprint 4 doesn't implement reconnect; the frontend just closes the panel on terminal state. Future sprints with longer-running flows may need explicit reconnect with last-event-id support.
- Decision C2 (best-effort rollback) plus event dedup-by-signature were the two non-obvious-correctness wins. UUIDs aren't monotonic, so an id cursor alone wouldn't work for SSE replay — tracking (id, status, started_at, completed_at) signature correctly handles in-place row mutations as the orchestrator updates events from pending → in_progress → succeeded. Worth canonicalizing this pattern for any future event-stream endpoints.
- Render service creation auto-wires the GitHub webhook when you pass the repo URL in the create payload — so the 'wire_github_to_render' step is a no-op placeholder rather than an explicit webhook call. This was a useful discovery; it simplifies the orchestrator but means we're relying on Render's auto-wiring behavior. If Render changes this, the placeholder step becomes a real failure surface.
- Two no-op steps in the orchestrator (wire_github_to_render, inject_env_vars) feel awkward but were the right architectural call — they preserve the 7-step shape that the frontend and tests will eventually rely on, and Sprint 5+ can replace the no-ops with real implementations without changing the orchestrator's structure. The UX is honest about this ("env var injection deferred to Sprint 5").

### Deferred to Sprint 4.5 / housekeeping
- Process-crash recovery query for stuck 'provisioning' projects (documented; not yet operationalized).
- Resource cleanup on project DELETE — currently only deletes AI Connect's DB row, not the provisioned cloud resources. Sprint 5 should add an optional "delete all" with confirmation.
- LISTEN/NOTIFY for SSE event push (Sprint 6+ when at scale concerns).
- Template scaffolding (templateRepoUrl field is plumbed but Sprint 4 uses auto_init for empty repos). Sprint 5.
- DNS automation + Auth0 tenant scaffold + Stripe Connect — the no-op steps in the orchestrator. Sprint 5/6/9 respectively.
- Org-owned platform credentials via XOR refactor (parallel to provider_keys, Sprint 4-5).
- Identity persistence on platform_credentials (current UI shows identity only on freshly-added; persisted in jsonb in Sprint 5).
- Validate-key-on-add for AI providers (still deferred from Sprint 2.5).
- SSE reconnect with last-event-id support for longer-running flows.
- Bundle size 353.22 KB raw — still acceptable but the Auth0 SDK + settings UI + genesis UI together are creeping. Code-splitting research before Sprint 5 lands.

### Sprint 5 starting point
DNS automation, env var injection, template scaffolding for Project Genesis. Path B of the signup wizard (takeover existing Replit/Lovable/GitHub projects) is also Sprint 5 per the roadmap. Project Genesis is now demo-worthy (a real deployed project in ~10 minutes) but rough around the edges — Sprint 5 fills in the gaps that make it actually useful (custom domains, working env vars, real templates instead of empty repos).

---

*Last updated: 2026-06-04*
