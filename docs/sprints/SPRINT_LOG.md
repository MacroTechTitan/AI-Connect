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
- 7 commits on the branch: schema (c353c45), platform integration layer (f319be6), credentials endpoints (6ae73ad), credentials UI (b6947fc), orchestrator core 5a (f693a00), rollback 5b (b235abe), SSE streaming + UI 5c (97565db), docs (1c01e01).
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

## Sprint 5 — Project Genesis completion (DNS + templates + env injection) (2026-06-08)
- Branch: sprint/5-genesis-completion (not yet merged at time of writing)
- 6 sprint commits on the branch: schema (c512e1e), Cloudflare client + GitHub create-from-template (c2bc547), Supabase wait + connection string capture (b402ee2), orchestrator integration (4c6a8fb), project creation UX with template selection (4e237a8), docs (eb02787), this SPRINT_LOG entry (last commit hash assigned at commit time).
- Plus a standalone strategic thinking doc committed mid-sprint (9832893) — docs/architecture/tool-routing-and-skills.md, NOT Sprint 5 scope, accidentally landed on the sprint branch instead of master. Will ride along on Sprint 5's merge.
- Migration 0005 (template_choice + subdomain + database_connection_string_vault_id columns on projects) applied to Supabase.
- Production verification: pending — Sprint 5 smoke test per docs/sprints/SPRINT_5_TESTING.md scheduled for the next session.

### What shipped
- Three new columns on projects table (no new tables): template_choice (text NOT NULL DEFAULT 'html-js', CHECK in 3 template values), subdomain (text NULLABLE, UNIQUE), database_connection_string_vault_id (uuid NULLABLE). Plus partial index on subdomain WHERE NOT NULL.
- Cloudflare DNS client (apps/api/src/lib/platforms/cloudflare.ts) — env-level (NOT user-supplied), validates against macrotechtitan.com zone, creates and deletes CNAME records. Architecturally distinct from the 4 PlatformClient implementations because Cloudflare credentials live in Render env vars (AI Connect's own config), not in user-supplied platform_credentials rows.
- GitHub createRepoFromTemplate (extension to existing client) — uses POST /repos/{template_owner}/{template_repo}/generate. Requires one extra GET /user call upfront to resolve the authenticated user's login (required by GitHub's owner field).
- Supabase waitUntilReady + buildConnectionString — addresses Sprint 4's async-creation gap. waitUntilReady polls every 5s for up to 2min for ACTIVE_HEALTHY status, with per-request 30s AbortController counting against the deadline. buildConnectionString is a pure helper that constructs postgresql://postgres.{ref}:{pass}@aws-0-{region}.pooler.supabase.com:6543/postgres. createResource extended to return dbPass in details (Supabase's API doesn't expose project passwords post-creation, so capture-at-create-time is the only viable approach).
- Three template repos at MacroTechTitan/template-html-js, template-sveltekit, template-nextjs — minimal working web apps (~50-150 lines each), all marked as template repositories on GitHub. Set up via PowerShell + gh CLI in one batch script during Sprint 5 prep.
- Orchestrator integration (apps/api/src/lib/genesis/{steps.ts, orchestrator.ts}): four step changes.
  - createGithubRepo branches on ctx.templateChoice → createRepoFromTemplate for the 3 templates, falls back to Sprint 4's empty auto_init for legacy projects.
  - createSupabaseProject now: create → waitUntilReady → buildConnectionString → vault.createSecret → UPDATE projects.database_connection_string_vault_id. Self-cleans the created Supabase project on post-creation failure (e.g., waitUntilReady timeout) to prevent orphans, since Sprint 4's rollback only undoes successful prior steps.
  - wireGithubToRender (was no-op): provisions Cloudflare CNAME pointing the project's subdomain at the Render onrender.com URL. Same self-cleanup pattern.
  - injectEnvVars (was no-op): fetches Render's current env vars via GET, merges in DATABASE_URL (from ctx) + NODE_ENV=production + PROJECT_NAME, PUTs back. Render's env-vars API is total-replace, so we read-modify-write rather than a partial update.
- Rollback extended to handle two non-PlatformClient cases: cloudflare (deleteSubdomainCname) and render+inject_env_vars (read-filter-PUT to remove our specific keys). Rollback failures are soft — if Render env var rollback fails, the subsequent create_render_service rollback deletes the whole service and resolves orphan env vars naturally.
- Project creation UX: Add project form gains template radio selector with always-visible inline helper text (covers mobile + accessibility in one pattern). Each project row shows "Template: <humanized>" badge and, once subdomain is provisioned, a clickable URL to the live site (the demo moneymaker line).
- Bundle delta: JS +1.28 KB raw / +0.39 KB gzipped; CSS +0.95 KB raw / +0.20 KB gzipped. Total Sprint 5 bundle delta: ~+2.2 KB raw / ~+0.6 KB gzipped — small because most of Sprint 5's complexity is backend.

### Lessons learned
- Setup phases for Sprint 5 (Cloudflare zone config, Render env var addition, 3 template repo creation) took meaningful time but were prerequisites that couldn't be deferred. Worth recognizing the "infrastructure-prep before code" pattern for future sprints with similar dependencies (Sprint 6's Auth0 tenant scaffolding will likely have similar prep).
- Discretion calls by Claude Code on Commit 4 (orchestrator integration) caught real spec bugs: (1) keeping the (ctx) step signature rather than threading a redundant db parameter, (2) adding self-cleanup on post-creation failure in each step to handle the "step fails AFTER creating its resource" gap that Sprint 4's reverse-walk rollback didn't cover. Both were correct architectural calls that improved on the spec. Worth noting that giving Claude Code explicit permission to flag spec deviations was important — without that, the same code would have shipped with a spec-compliant but-worse implementation.
- The decision to capture per-call credentials at orchestrator runtime (Sprint 4 pattern) made Sprint 5's connection-string-capture work cleanly: the dbPass generated at Supabase create-time stays in memory through wait → connection string → Vault, never persisted as plaintext outside Vault.
- Manual MCP swap for AI Connect's own Supabase deferred yet again. We're operating with OQ-Supabase MCP connection during AI Connect work, which means NOT calling Supabase MCP for AI Connect database changes (would point at the wrong project). Continued reliance on manual SQL paste workflow for the AI Connect database. Worth swapping eventually but not blocking.
- The mid-sprint architecture sketch (tool-routing-and-skills.md) was the right idea executed at the wrong time. Captured genuinely useful strategic thinking but interrupted Sprint 5 flow. Future "I just had a strategic thought" moments during a sprint should be captured in 2 lines to a scratch note, not 250 lines to a real architecture doc — the elaboration belongs after the sprint ships.
- The shared-domain-via-CLOUDFLARE-base-domain pattern (D1 from Sprint 5 planning) is meaningfully simpler than user-brings-domain. Once Sprint 5 ships and the demo works end-to-end, the "click button → working URL in 10 minutes" pitch becomes real, and that pitch is what made the architectural commitment to A worth it.

### Deferred to Sprint 5.5 / Sprint 6+
See docs/future-ideas.md "Sprint 5 follow-ups" subsection for the full list. Highlights:
- Supabase quota_exceeded + paused-project + multi-org-selection UX improvements.
- Multi-account Supabase support (Sprint 7-8).
- Resource cleanup on project DELETE (still deferred from Sprint 4).
- Custom user domains (currently shared domain only).
- Render env var rollback edge cases (low impact).
- DNS propagation wait step (paranoid completeness).

### Sprint 6 starting point
Auth0 tenant scaffolding for each provisioned project (per the roadmap). When a user provisions a project, that project gets its own Auth0 tenant + application + user pool, with AUTH0_DOMAIN/AUTH0_CLIENT_ID/AUTH0_AUDIENCE injected into Render env vars (extending the Sprint 5 inject_env_vars step). Plus the Path B work (takeover existing Replit/Lovable/GitHub projects) from the Sprint 5 deferred list — still on the table for Sprint 6 vs 5.5 depending on user signal after Sprint 5 ships.

## Sprint 5.5 — Genesis fixes (template-aware Render config + status-aware verify_deployment) (2026-06-10)
- Branch: sprint/5.5-genesis-fixes
- Merged via PR #10 on 2026-06-10
- 2 commits: template-aware Render config (26705be), status-aware verify_deployment (290f3d3); plus a mid-sprint docs commit (d6fc39b) capturing the Command Center UI insight

### What shipped
- TEMPLATE_REPOS in types.ts extended with render.{buildCommand, startCommand} per template. The 3 templates needed different config: html-js → npm install / node server.js, sveltekit → npm install && npm run build / node build/index.js, nextjs → npm install && npm run build / npm start
- renderClient.createResource extended to accept buildCommand and startCommand via the request, with Sprint 4 defaults as fallback
- New renderGetLatestDeploy(credential, serviceId) helper — GET /v1/services/{id}/deploys?limit=1, returns deploy status
- verifyDeployment rewritten to poll deploys API instead of URL — fast-fails on terminal states (build_failed, etc.) with Render's status and a dashboard logs URL

### Why this was needed
Sprint 5 smoke test failed at verify_deployment after 294 seconds. Root cause: Render service was being created with hardcoded Node config (pnpm install && pnpm build / node dist/index.js) that didn't match any of the 3 templates we shipped. verify_deployment polled a dead URL for 5 minutes before timing out — diagnostically blind to the underlying build failure.

## Sprint 5.6 — Post-live URL retry hotfix (2026-06-12)
- Direct-to-master commit (9ee53e7) — post-merge hotfix pattern from CLAUDE.md
- 1 commit total

### What shipped
- VERIFY_POSTLIVE_MAX_ATTEMPTS = 6 in steps.ts
- The post-live URL check (added in Sprint 5.5 Commit 2) now retries up to 6 times over 60 seconds before declaring failure
- Each retry attempt logged at info level via logSystem
- Bounded wall time: max 60 seconds of post-live retries on top of the 8-minute status polling deadline

### Why this was needed
Sprint 5.5 smoke test showed Render reports 'live' status reliably, but the public URL needs ~10-60 seconds more before actually serving 200. The single-shot post-live URL check failed too aggressively, surfacing 'Render reports deploy live but service URL returned 502' even though the deploy was genuinely working.

## Sprint 5.7 — Disable Cloudflare DNS + env vars at creation (2026-06-13)
- Branch: sprint/5.7-genesis-fixes
- Merged via PR #11 on 2026-06-13
- 3 commits: Disable Cloudflare DNS automation (546955b), AI-to-AI coordination docs capture (ace8a65), env vars during Render creation (c19fcb5)

### What shipped
- wireGithubToRender becomes a no-op again. Renders as "DNS automation deferred to Sprint 6+ (custom domain support, blocked on SSL cert depth for aiconnectprojects.macrotechtitan.com subdomain)"
- New projects.deployed_url column (migration 0006). createRenderService writes deployed_url after service creation. Frontend project row displays this onrender.com URL as the clickable link
- Cloudflare client code and env vars STAY in the repo. Subdomain column STAYS in the schema. Both preserved for re-enablement when a dedicated short domain is acquired
- Render's POST /v1/services now receives envVars in the initial payload — [DATABASE_URL, NODE_ENV=production, PROJECT_NAME]. Service starts with env vars baked in
- injectEnvVars step repurposed as VERIFICATION — fetches current env vars and confirms all 3 are set correctly
- Rollback simplified: env vars die with the service, no separate env var rollback needed

### Why this was needed
Sprint 5.6 smoke test surfaced two bugs: (1) custom subdomain *.aiconnectprojects.macrotechtitan.com doesn't resolve in browsers because Cloudflare's universal SSL cert doesn't cover 3-level-deep subdomains; (2) PROJECT_NAME env var injection didn't reach the running service because Render starts the service immediately on creation and PUT env vars don't trigger redeploys.

### Lessons learned across 5.5 / 5.6 / 5.7
- Smoke testing is the discovery tool. Each sprint exposed the next layer of bugs. Sprint 5 -> empty repo timeout -> 5.5 fix -> URL race -> 5.6 fix -> env var timing + SSL depth -> 5.7 fix -> WORKING
- The 'set env vars at create time, not after' pattern is the correct architecture. Sprint 5's PUT-after-create approach was always wrong in retrospect — services need their env vars from boot, and Render doesn't auto-redeploy on env var changes
- Cloudflare DNS depth + SSL cert is a real constraint. The 'shared base domain' pattern (D1 from Sprint 5 planning) works architecturally but doesn't work practically without a dedicated domain. Sprint 6+ needs to either acquire aiconnect.app (or similar short domain) or accept the .onrender.com URLs
- Status-aware verify > URL polling. The diagnostic improvement from 5.5 Commit 2 alone justifies its existence even ignoring the bug it fixed — future deploy failures now surface in seconds with real error messages

### Genesis arc summary (Sprint 4 -> 5 -> 5.5 -> 5.6 -> 5.7)
Sprint 4 (MVP) -> Sprint 5 (templates+DNS+envs, broken) -> Sprint 5.5 (template config+verify, half-fixed) -> Sprint 5.6 (post-live retry, surface SSL+env timing) -> Sprint 5.7 (disable DNS+create-time envs, WORKING). Smoke tested 2026-06-13 against AIC Sprint 5.7 Final project — provisioned a real working Express server with PROJECT_NAME injected correctly at https://aic-sprint-5-7-final.onrender.com.

### Sprint 6 starting point
Per the architecture sketch + product positioning conversation during this arc, Sprint 6 pivots from the original 'Auth0 tenant scaffolding per project' to an integration arc: Integration UI pattern + SendGrid + OpenAI per-project + Anthropic per-project + WordPress with a custom AI Connect plugin. Auth0 and Stripe deferred. Custom domains deferred. Path B (takeover existing projects) also deferred. Full Sprint 6 scope captured separately in upcoming planning doc.

## Sprint 6 — Build and Ship (integration foundation + WordPress gated apps) (2026-06-20)
- Branch: sprint/6-build-and-ship
- Merged via PR #12 on 2026-06-20
- 9 commits: spec, migration 0007, backend foundation, SendGrid validator, OpenAI validator, Anthropic validator, frontend Integrations panel, MTTBuild health check toggle docs, WordPress combined (plugin + wizard + module manager)

### What shipped
- New integrations table (migration 0007) with per-user, per-type uniqueness, vault-secret references, jsonb config, validation status tracking
- apps/api/src/lib/integrations/ — types, validator registry using factory pattern ((userId) => IntegrationValidator), per-type validators for SendGrid (hits GET /v3/user/account), OpenAI (links provider_keys + ownership check), Anthropic (mirror of OpenAI)
- apps/api/src/routes/integrations.ts — CRUD routes mirroring platformCredentials.ts conventions (auth middleware, vault-before-DB, org scoping, logUserAction)
- WordPress plugin v1 (wp-plugin/ai-connect/) — FIRST PHP IN THIS REPO. Token-authenticated REST API at ai-connect/v1 (ping, status, modules CRUD). Modules stored in WordPress wp_options table (not static JSON) so AI Connect can add/edit/delete modules via REST without re-uploading the plugin. Dynamic page registration via init hook + template_redirect. MemberPress integration with graceful fallback when not installed
- WordPress validator hits the plugin's /ping endpoint
- Plugin .zip generation endpoint (apps/api/src/routes/wordpressPlugin.ts) streams the plugin via archiver
- wordpressClient (apps/api/src/lib/integrations/wordpressClient.ts) wraps the plugin REST API for module operations
- Frontend Integrations panel (App.tsx) — collapsible panel parallel to Hosting connections. Per-type input branching, optimistic include_in_projects toggle, delete with confirmation
- WordPressWizard (apps/web/src/components/WordPressWizard.tsx) — six-step modal: welcome, download plugin, install instructions, get token, enter site URL + token, success
- WordPressModuleManager (apps/web/src/components/WordPressModuleManager.tsx) — list/add/edit/remove modules with tier dropdown auto-populated from /status
- MTTBuild Health check toggle (docs/MTTBuild.md) — default OFF. User explicitly opts into mid-session check-ins; default behavior is forward-progress without interruption

### Why this matters
Sprint 6 is the integration arc — AI Connect's first user-facing layer where users connect third-party services AND embed external apps as MemberPress-gated WordPress pages. The headline feature (WordPress gated apps) eliminates a multi-day setup that previously required manually configuring cross-domain auth, MemberPress checks, and embedded routing for every sub-app a user wanted to gate. Now: 4 clicks.

### Smoke test (2026-06-20)
1. Account: jgelet@macrotechtitan.com (Auth0 production tenant)
2. WordPress plugin .zip downloaded from /api/integrations/wordpress/plugin.zip — 25KB, archived correctly
3. Plugin uploaded to lifehackprotocol.com, activated, token generated in Settings → AI Connect
4. AI Connect WordPress wizard step 5: site URL + token → /ping validation returned 200 with plugin version 1.0.0
5. WordPress integration appeared in Integrations panel with "Connected" badge
6. Module added: slug=testapp, source_url=https://example.com, required tier=Member
7. Visited lifehackprotocol.com/testapp/ in incognito (logged out) — gating UI rendered correctly: "Members only — This content requires Member - Life Hack Protocol membership" with Log in + Become a member buttons

End-to-end gating mechanism VERIFIED in production on lifehackprotocol.com.

### What's NOT done (deferred)
- Logged-in-with-tier iframe verification (need test user with Member tier in lifehackprotocol.com — not yet validated tonight)
- The "Stripe Connect + AWS S3/SES" Sprint 6 candidates were CUT during scoping in favor of WordPress focus
- Reverse-proxy (non-iframe) WordPress modules — Sprint 7+
- Auto-sync of plugin .zip from AI Connect to WordPress — Sprint 7+
- Generic membership plugin support (LearnDash, RCP, WooCommerce Memberships) — Sprint 7+
- Multi-account integrations — Sprint 7+
- Build-from-source WordPress modules (AI Connect builds an app from a repo, packages as module) — Sprint 7+
- AI-generated WordPress modules — Sprint 12+ (likely never; defer to Lovable/Cursor for code generation)
- AI Connect help documentation (planned for Sprint 6.5)

### Known deployment surface
- Plugin .zip route uses ../../../../ relative path to wp-plugin/ directory. Worked on Render in production smoke test, but is fragile if rootDir or build process changes. Fix-forward when it breaks.
- PHP plugin was not lint-checked with php -l before shipping (no PHP locally). Smoke test verified runtime behavior.
- ai-connect.macrotechtitan.com/help route does not exist yet — Sprint 6.5 work.

### Sprint 7 starting point
Two candidates for Sprint 7:
- AI Connect help center (in-app docs, sidebar navigation, ? links from each panel) — gets users self-sufficient
- WordPress module enhancements: tier check fixed for logged-in members, more iframe-friendly default page styling, "build from your AI Connect project" template integration — extends the WordPress integration

The user's preference at end of Sprint 6 was building a real macro calculator app to embed as a WordPress module on lifehackprotocol.com. That's its own Sprint 7+ scope (real app development, not AI Connect feature work).

## Sprint 7 — OpenClaw Integration (Local Mode) (2026-06-24)
- Branch: sprint/7-openclaw-integration
- Merged via PR #14 on 2026-06-24
- 8 commits: spec, migration 0008, types+validator+mode detection, client wrapper, routes, wizard UI, agent manager, docs

### What shipped
- First local-mode integration. AI Connect can now run on the same host as a target system (OpenClaw) and drive it via stdio MCP. Cloud AI Connect cleanly refuses with 503 'openclaw_local_only'.
- ``apps/api/src/lib/mode.ts`` — ``isLocalMode()`` env-driven detection. True if AICONNECT_LOCAL_MODE=true OR OPENCLAW_BIN set. ``LOCAL_ONLY_ERROR`` for consistent 503 short-circuits.
- Migration 0008: extended ``integrations_integration_type_check`` to include 'openclaw'. Applied to AI Connect Supabase manually via SQL editor.
- ``apps/api/src/lib/integrations/openclawClient.ts`` — OpenClawClient class with listAgents, sendMessage, listTools. Each spawns the bridge as stateless child process per call (no long-lived MCP connection in v1). MCP initialize + tools/call handshake over stdio. MAXIMUS_READONLY=true at every spawn. 30s init / 60s call timeouts. OpenClawError typed with 9-code union.
- ``apps/api/src/lib/integrations/validators/openclaw.ts`` — cloud-mode refusal, shape/existence checks, listTools confirm list_agents + send_message present, listAgents confirm default_agent in returned list.
- ``apps/api/src/routes/integrations.ts`` — GET /:id/agents, POST /:id/messages, POST /openclaw/discover. All three short-circuit in cloud mode. OpenClawError → HTTP: bridge_timeout 504, agent_not_found 404, others 502. Message route validates ≤10k chars, audits via logUserAction (length-only, not content).
- ``apps/web/src/components/OpenClawWizard.tsx`` — 6-step modal parallel to WordPressWizard. Welcome (security warning) → bridge path → discover → pick agent → test message ("reply OK") → success.
- ``apps/web/src/components/OpenClawAgentManager.tsx`` — two-pane: agent list (default badge, identity, workspace, model) + conversation (autogrowing textarea, 10k cap, char count >8k, optimistic user message, in-memory history last 10). HTTP status → friendly error mapping.
- App.tsx IntegrationsPanel: OpenClaw added with cloud-mode gating. Disabled type selector option, disabled Manage Agents button, "Local mode only" pill on rows. Local mode detected via /health extension (local_mode boolean).
- /health route extended with isLocalMode() output.
- ``docs/LOCAL_MODE.md`` — user-facing setup guide. Prereqs, env vars (AICONNECT_LOCAL_MODE, OPENCLAW_BIN, DATABASE_URL pointing at prod Supabase), wizard walkthrough, security notes, troubleshooting. Corrects several env-var inaccuracies the spec doc had (port 8080 not 3000, VITE_API_BASE_URL not VITE_API_URL, audience aiconnect.macrotechtitan.com not optimaquant.com).
- ``docs/sprints/SPRINT_7_TESTING.md`` — end-to-end smoke test plan (A through G).

### Why this matters
Sprint 7 is AI Connect's first integration that requires running on the user's host. Architectural precedent: same TypeScript codebase, same Supabase, two deployments (cloud + local). Sets the pattern for future local-only integrations (Cursor MCP, Claude Desktop, etc.). The "Build and Ship" story expands — Sprint 6 embedded external apps via WordPress; Sprint 7 drives local AI agents via cloud orchestration. From a moat perspective: AI Connect becomes the routing layer for hybrid cloud+local AI workflows. The horse pulls; AI Connect decides.

### Smoke test (deferred to first local-mode session)
Sprint 7 smoke test plan documented in docs/sprints/SPRINT_7_TESTING.md. Sections A-F cover cloud-mode gating, local startup, shared DB verification, wizard flow, agent manager round-trip, cloud-mode list gating. Section G covers validation error coverage. To be run on Joseph's Mac mini with OpenClaw v2026.2.6-3 + maximus-bridge v0.2.0.

NOT YET EXECUTED. Sprint 7 is shipped from a code perspective; live verification awaits the first local-mode session.

### What's NOT done (deferred to Sprint 7.5+)
- Smoke test on Mac mini — first local-mode session
- Network transport (SSH or HTTPS) so cloud AI Connect can drive remote OpenClaw — Sprint 7.5+
- Long-lived MCP connection pool (faster repeated calls) — Sprint 7.5+
- Message history persistence — Sprint 7.5+ (in-memory only, last 10)
- Streaming agent responses — would need bridge changes
- Multi-message conversation context — each send is independent currently
- Agent skill discovery / per-skill UI — Sprint 7.5+
- Auto-detect OpenClaw across common install locations — Sprint 7.5+
- Read-write mode (MAXIMUS_READONLY=false) — never until deliberate security review
- Supabase CLI integration for automated migrations — Sprint 7.5+
- Help center / user manual — Sprint 8
- AI Connect Design System (UI as a feature) — Sprint 8
- Auth0 + Stripe as both connectors AND internal integrations — Sprint 8

### Known deployment surface
- /health route extended with local_mode boolean. Cloud reports false. No new env vars on Render.
- Cloud production cleanly returns 503 'openclaw_local_only' on all OpenClaw endpoints. No errors, no missing config.
- For local mode setup, follow docs/LOCAL_MODE.md exactly. Several env vars must match production (DATABASE_URL, AUTH0_*) — treat local .env.local like a password.

### Sprint 8 candidates locked from conversation
- AI Connect Design System ("UI as a feature" — design tokens, shared component library, typography scale, color tokens, button/input/modal primitives, Storybook or live /ui components page, UX writing standards, accessibility pass)
- Help center / user manual (in-app docs at /help, sidebar nav per feature, "?" links from each panel, articles for every feature shipped to date)
- Auth0 connector + AI Connect's own Auth0 management UI (user list, role assignment, Auth0 tenant config visible in AI Connect)
- Stripe connector + AI Connect's own subscription/billing management UI (use Stripe for AI Connect's own paid tiers when those launch)

---

*Last updated: 2026-06-24*
