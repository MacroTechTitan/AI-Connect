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

---

*Last updated: 2026-05-24*
