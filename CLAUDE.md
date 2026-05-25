# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

AI Connect is the unified orchestration layer for AI-assisted development — a chat surface that routes prompts to the right AI tool (Claude, Claude Code, Cursor, Perplexity, Ollama, OpenClaw, etc.) and enforces the MTTBuild methodology as platform behavior. The product is open-core (MIT framework + hosted SaaS at `aiconnect.macrotechtitan.com`).

State at time of writing: Sprint 0 shipped (merge commit 8cdafc1 to master) and Sprint 0.5 polish shipped. Sprint 1 in progress on branch sprint/1-auth — three commits done locally (JWT middleware, /api/me with lazy user creation, frontend Auth0 SDK). Production currently runs Sprint 0.5 from master; Sprint 1 ships to production once Commit 4 lands and the branch merges per the MTTBuild merge-and-ship ritual.

The README (`README.md`) is treated as the project specification — when architecture changes, the README changes first. The Sprint 0 acceptance criteria live in README §9 and `SPRINT_0_HANDOFF.md`.

## Critical operational rules — secret handling

These rules bind every AI assistant working on this project. They exist because operator-side secret leaks (via inline command flags, shell history, screenshots of profile files, or chat prompts) are the most common failure mode in AI-assisted dev. See `docs/MTTBuild.md` Phase 0.5 (to be added) for full rationale.

Never:
- Propose a command that includes a secret value inline (e.g., `--env-var KEY=actualvalue` where `actualvalue` is the real secret). Use the platform UI (Render dashboard, Vercel dashboard, Cloudflare dashboard) for first entry. Use env var substitution (`$env:VAR_NAME`) when scripting.
- Ask the operator to open a file that may contain secrets (`$PROFILE`, `.bashrc`, `*.env*`, IDE config) — describe the change in prose instead.
- Request the operator confirm a secret value back, even partial.
- Echo secret values into your reply, even from screenshots or pasted content. If a secret value appears, flag it and tell the operator to rotate.

Always:
- When in doubt about a secret's exposure status, treat it as compromised and recommend rotation.
- Prefer platform-native env var management (Render env vars, Vercel env vars) over local files for production secrets.
- When a CLI flag and a web UI both work for setting a secret-bearing value, prefer the web UI for first setup.

## Layout

pnpm workspaces; root `pnpm-workspace.yaml` includes `apps/*` and `packages/*`.

- `apps/api` — `@ai-connect/api`. Express 4 + Drizzle (Postgres) + pino + zod. Node ESM (`"type": "module"`, `NodeNext`). Entry `src/index.ts`. The `dist/index.js` produced by `tsc` is what Render runs via `pnpm --filter @ai-connect/api start`.
- `apps/web` — `@ai-connect/web`. Vite + React 18. Deployed to Vercel from this subdir (see `apps/web/vercel.json`).
- `packages/shared` — `@ai-connect/shared`. Cross-package types/utilities. Both apps consume it via `workspace:*`; it **must build before** either app (the Render and Vercel build commands do this explicitly).
- `docs/MTTBuild.md` — the methodology, mandatory reading. `docs/PROJECT_TEMPLATE_OVERRIDES.md` records any deviation from defaults.
- `docs/sprints/SPRINT_LOG.md` — every merged sprint gets an entry after the deploy is verified green.
- `skills/platform/` — reusable prompt/behavior patterns that ship with AI Connect (BYOAI router, GitHub sync, cache busting, Replit fix reference).

## Commands

Run from the repo root unless noted.

```bash
pnpm install                                    # bootstrap (uses pnpm@9.12.0 via packageManager)
pnpm -r build                                   # build every workspace (shared → apps)
pnpm -r typecheck                               # tsc --noEmit across all workspaces
pnpm -r --parallel dev                          # all dev servers (api: tsx watch, web: vite)
pnpm --filter @ai-connect/api dev               # API only (tsx watch src/index.ts)
pnpm --filter @ai-connect/web dev               # Web only (Vite on :5173)
pnpm --filter @ai-connect/shared build          # rebuild shared after editing it
pnpm db:generate                                # drizzle-kit generate (in apps/api)
pnpm db:studio                                  # drizzle-kit studio
```

There is no test runner wired yet — adding one is a future sprint deliverable.

After editing `packages/shared`, rebuild it so consuming apps see the new `dist/`. The deployment build commands (in `render.yaml` and `apps/web/vercel.json`) always do `pnpm --filter @ai-connect/shared build` before the app build, and local dev should follow the same order.

## Architecture notes that span files

**Phase 0 `/health` contract (`apps/api/src/index.ts`).** `/health` and `/version` must remain DB-free, auth-free, and synchronous. Render's health check points at `/health`; anything that could block (DB connect, Auth0 JWKS fetch) belongs in a separate route. This is a load-bearing invariant — do not "improve" it by adding a DB ping.

**Explicit `0.0.0.0` bind.** The API listens on `0.0.0.0`, not `localhost`/`127.0.0.1`. Render's port scanner needs IPv4 reachability; binding implicitly is the failure mode this project exists partly to prevent.

**Env validation (`apps/api/src/lib/env.ts`).** All env vars go through one zod schema parsed at import time. Production-required secrets (Auth0, Stripe, `MASTER_KEY`, `DIAGNOSTICS_TOKEN`) are marked `optional()` so `/health` can boot without them in dev. When adding a new env var, add it here first — direct `process.env.X` reads in feature code are a smell.

**Logger (`apps/api/src/lib/logger.ts`).** Pino with `pino-pretty` in dev, JSON in production for Render's log aggregation. `LOG_LEVEL` env overrides default `info`. Sprint 0 will add `lib/logging.ts` wrappers `logSystem` / `logUserAction` / `logDev` over the three logging tables (`systemLogs`, `userAuditLogs`, `devLogs`) — see MTTBuild Phase 0 for the schema.

**Database.** Drizzle (`apps/api/drizzle.config.ts` → schema at `src/db/schema.ts`, not yet created). Postgres on Supabase. **Always use the IPv4-compatible session pooler** connection string (`aws-N-region.pooler.supabase.com:5432`), not the direct connection — Render can't reach the direct connection over IPv6.

**Database connection scoping.** DB connect happens lazily in `src/db/client.ts` (to be created), never at boot — `/health` must remain DB-free.

**Deploy targets.**
- `render.yaml` declares the API service: `rootDir: apps/api`, branch `master`, `healthCheckPath: /health`. Build command installs at the repo root with `--frozen-lockfile` and pre-builds shared. Secrets are set in the Render UI, never in this file.
- `apps/web/vercel.json` does the equivalent for the frontend: runs install scoped to `@ai-connect/web...` (the `...` includes workspace deps so shared resolves), pre-builds shared, then builds web.

**Future: BYOAI encrypted credentials.** When Sprint 2 lands, provider API keys are AES-256-GCM encrypted with `MASTER_KEY` (32-byte hex). Decrypted keys never leave the API server, never get returned to the frontend. This pattern is non-negotiable for any new provider integration — see `skills/platform/BYOAI_SKILL.md`.

## Production deployment state (as of Sprint 0)

API service — `ai-connect-api` on Render
- Service ID: `srv-d87lopgjo6nc739msebg`
- Region: Ohio (us-east-2 — matches Supabase region for low DB latency)
- Plan: free (cold-start tolerance acceptable through Sprint 2)
- Custom domain: `https://api.aiconnect.macrotechtitan.com`
- Default URL: `https://ai-connect-api.onrender.com`
- Currently deployed from branch `sprint/0-phase-0-infra` (flips to `master` post-merge)
- Env vars (names only, values in password manager + Render UI): `NODE_ENV`, `NODE_VERSION=24.15.0`, `PORT=8080`, `DATABASE_URL`, `AUTH0_ISSUER_BASE_URL`, `AUTH0_AUDIENCE`, `DIAGNOSTICS_TOKEN`, `MASTER_KEY`, `ADMIN_EMAIL`

Frontend — `ai-connect-web` on Vercel
- Custom domain: `https://aiconnect.macrotechtitan.com`
- Default URL: `https://ai-connect-web.vercel.app`
- Root directory: `apps/web` (Vercel project setting, with "Include files outside the root directory in the build step" enabled)
- Env vars (Production + Preview environments): `VITE_API_BASE_URL`, `VITE_AUTH0_DOMAIN`, `VITE_AUTH0_CLIENT_ID`, `VITE_AUTH0_AUDIENCE`

Database — Supabase project `ai-connect-prod`
- Region: us-east-2 (Ohio)
- Connection: IPv4 session pooler (port 5432)
- Schema state: empty `public` schema, migrations not yet applied

Auth — Auth0 tenant `macrotechtitandev.us.auth0.com`
- Application: `AI Connect` (SPA type)
- API audience identifier: `https://api.aiconnect.macrotechtitan.com`
- Connections: Username-Password-Authentication enabled

DNS — Cloudflare zone `macrotechtitan.com`
- `api.aiconnect` CNAME → `ai-connect-api.onrender.com` (DNS-only, grey cloud)
- `aiconnect` A → `76.76.21.21` (DNS-only, grey cloud)
- Cloudflare proxy is off (grey cloud) for both — Vercel and Render handle their own SSL/edge

## Methodology — MTTBuild

This project is built using the methodology it enforces. Before any non-trivial change, read `docs/MTTBuild.md` end-to-end. The points that bite hardest in practice:

- **Branch from `master`, not `main`.** Default branch is `master` by MTTBuild convention.
- **No direct commits to `master`.** Hotfixes are sprints too — branch, PR, review. The only exception is reverting a broken deploy.
- **One active feature branch at a time per project.** Don't start a new sprint with the previous one unmerged.
- **`git pull origin master` before starting work, and `git merge origin/master` into the feature branch before opening the PR.** This resolves conflicts while context is fresh.
- **Tight scope per sprint.** PRs touching >10 files trigger a "split this" review comment.
- **Schema migrations never auto-apply.** Generate → commit → review → manually apply with verification queries → then merge the code that uses the new schema. Never the other order.
- **Revert-first on production breaks.** Revert the merge, redeploy green, *then* branch and fix forward.
- **No platform-specific dependencies without graceful degradation.** Anything referencing Replit-specific env vars (`REPL_*`, `DYNO`) needs a `process.env` fallback.

Deviations from MTTBuild defaults must be recorded in `docs/PROJECT_TEMPLATE_OVERRIDES.md` with reason, date, and sprint. The defaults apply (Drizzle, Render+Vercel, Supabase, Auth0 shared tenant `macrotechtitandev.us.auth0.com`, Stripe shared customer pool, pnpm). Two AI-Connect-specific architectural commitments extend MTTBuild rather than override it: (1) MCP-per-service for external integrations (Sprint 6+ implementation, decision made Sprint 0), (2) admin diagnostics endpoint with bearer-token auth (`/api/admin/diagnostics`, implemented Sprint 0). These belong in `docs/PROJECT_TEMPLATE_OVERRIDES.md` as architectural commitments — a follow-up commit will add them there.

## Sprint workflow expectations for code changes

Every sprint follows the template in `docs/MTTBuild.md` ("Sprint template (use for every sprint)"). When executing a sprint:

1. Pre-flight: pull master, confirm clean working dir, `pnpm -r build` and `pnpm -r typecheck` pass on baseline, confirm no other open branch touches the same files.
2. Implement against the sprint's acceptance criteria and out-of-scope list. **Stop and surface** if the work needs files outside the planned scope, an unspecified architectural decision, auth/payments/prod-data changes without operator review, or anything surprising.
3. Merge-and-ship: `git merge origin/master` into the branch, re-run build + typecheck, push, PR, watch the auto-deploy go green, smoke-test `/health` and the new feature, then write the entry into `docs/sprints/SPRINT_LOG.md`.

PR descriptions follow `.github/pull_request_template.md`.

## Deferred to future sprints

Decided not now during Sprint 0, captured here so future sessions don't relitigate:

- Sentry — error tracking, Sprint 1+. Complements (does not replace) the DB log tables.
- Infisical / Doppler — centralized secrets manager, Sprint 5+ if secret proliferation pain materializes.
- PostHog — product analytics + feature flags, Sprint 2-3 when there's user behavior to analyze.
- External log aggregation via Render Log Streams (Datadog, Better Stack, New Relic, Honeycomb candidates) — Sprint 1+ if Render's UI log stream proves insufficient. Requires Render Professional plan.
- Cloudflare proxy in front of Render/Vercel — Sprint 4+ for DDoS/WAF when pre-launch ends.
- GitHub Copilot in Cursor — skipped; Cursor's built-in AI is sufficient. Revisit only if autocomplete quality becomes a pain point.
- MCP-per-service architecture for external integrations — first MCP server (GitHub message bus) built in Sprint 6. Render and Vercel both publish official Claude Code skill plugins worth evaluating in Sprint 4+.
