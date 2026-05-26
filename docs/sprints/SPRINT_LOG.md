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

---

*Last updated: 2026-05-26*
