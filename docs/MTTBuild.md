# MTTBuild — Build Template for Macro Tech Titan Products

**Owner:** Joseph Gelet
**Purpose:** A reusable, opinionated template for building software products with Claude (web chat for planning + Claude Code for execution).

This skill exists because solo-dev-with-AI builds have specific failure modes — workflow drift, schema collisions, in-memory state on hibernating hosts, conflict-heavy merges — that are predictable and preventable. MTTBuild encodes the lessons.

**Use this skill at the start of every new Macro Tech Titan project, and at the start of every working session on an existing one.**

---

## Health check toggle

Default: OFF.

When OFF (default), Claude and AI Connect do not interrupt work to check in on the human's state. The user wants forward progress; check-ins are friction.

When ON, Claude periodically checks in with the human at natural pause points:
- After a long-running task completes (e.g., a multi-commit sprint, a smoke test cycle)
- When the human has been working on the same problem for an extended period
- When the conversation context shows signs of decision fatigue (rapid topic switching, contradictory direction, asking the same question twice)
- Before starting a meaningfully larger scope of work

Check-ins should be brief — one or two sentences — and resist the urge to philosophize about energy, productivity, or work-life balance.

Examples of acceptable check-ins:
- "Quick check before this big commit — still in?"
- "That's been a long thread. Want to land what's done and pick up tomorrow?"
- "You've shifted directions a few times. Want to nail down scope before more code?"

Examples of unacceptable check-ins (avoid even with health check ON):
- Lectures about pacing, throughput, or the cost of sustained work
- Unsolicited advice about when to stop
- Speculation about the human's emotional state
- "I notice you've been..." reflective observations

How to toggle:
- User says "health check on" → enable for current session
- User says "health check off" → disable for current session
- Default for new sessions is OFF unless explicitly persisted in user preferences

Why off by default: the failure mode of OFF is "Claude misses an opportunity to suggest a stop." The failure mode of ON is "Claude wastes time on unnecessary check-ins." For users who explicitly want forward progress, OFF is correct. Users who want a gentler pace flip it ON.

---

## Phase 0 — Infrastructure first, no exceptions

Before writing any product feature, the foundation must be stable. If any of the following is shaky, **fix it first** even if the user wants to start building features. A wobbly foundation makes every sprint slower and produces compounding tech debt.

### Required infrastructure checklist

- [ ] **Hosting in place and live.** Render for the API server (or equivalent). Vercel for the frontend (or equivalent). Both deploying from `master` automatically.
- [ ] **`/health` endpoint** on every backend service, returning 200 with no auth and no DB dependency. Hosting platform's health check pointed at it.
- [ ] **Server binds to `0.0.0.0` explicitly** — not `localhost`, not `127.0.0.1`, not implicit. Render's port scanner needs IPv4 reachability.
- [ ] **Database is Postgres** (Supabase or equivalent). Connection from the API server **uses the IPv4-compatible pooler** (Session pooler at `aws-N-region.pooler.supabase.com:5432` for Supabase). NOT the direct connection — that's IPv6-only on most plans and Render can't reach it.
- [ ] **Environment variables are env vars**, not platform-specific secret services (Replit secrets, etc.). Code that fetches credentials should fall back to `process.env` when platform-specific mechanisms aren't available.
- [ ] **Stripe (or payment provider) wired with plain env vars**: `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`. Webhook registered manually in Stripe dashboard pointing at `/api/stripe/webhook` (or equivalent route).
- [ ] **GitHub repo connected to hosting platforms** for auto-deploy on push to `master`.
- [ ] **No platform-specific dependencies** that don't gracefully degrade. If the codebase came from Replit/Heroku/etc., scan for `REPL_*`, `DYNO`, etc. env var references and add fallbacks before doing anything else.
- [ ] **Latest published artifacts only** — never run an old commit, never deploy from a stale branch. Configure platforms to "Deploy latest commit" by default, not "Deploy specific commit."

### Required logging infrastructure (Phase 0, not later)

Logging tables and wrappers must exist **before any feature work**. Retrofitting audit logs after features ship means backfilling call sites everywhere, which never happens cleanly.

- [ ] **`systemLogs` table** in Postgres. Columns: `id`, `occurredAt`, `level` (debug/info/warn/error/critical), `category`, `event`, `message`, `context` (JSONB), `relatedUserId`, `relatedEntityIds` (foreign keys to whatever entities the project has, nullable), `externalRef`, `traceId`.
- [ ] **`userAuditLogs` table** in Postgres. Columns: `id`, `userId`, `occurredAt`, `action`, `description` (user-facing), `metadata` (JSONB safe to display), `ipAddress`, `userAgent`, `traceId`.
- [ ] **`devLogs` (or admin platform logs)** for Claude/admin-initiated actions, deploy events, migration runs. Same shape as systemLogs but separate logical category.
- [ ] **Logging wrapper** (`lib/logging.ts` or equivalent) exposing `logSystem()`, `logUserAction()`, `logDev()`. `logUserAction()` writes to both userAuditLogs AND systemLogs in one transaction with a shared `traceId`. Failures of log writes route to console/pino so they're never silently swallowed.
- [ ] **Indexes** on `(userId, occurredAt DESC)`, `(level)` partial WHERE level IN ('error','critical'), `(traceId)` partial WHERE NOT NULL, `(category)`.

### Required identity infrastructure (Phase 0)

- [ ] **`users` table in Postgres** from day one. Never run user state in memory. Hibernating hosts wipe in-memory state on every cold start.
- [ ] **Auth provider configured** (Auth0, Supabase Auth, Clerk — pick one and stick with it).
- [ ] **Admin user seeded on boot** via `INSERT … ON CONFLICT DO NOTHING` — idempotent, race-safe.
- [ ] **All other state in Postgres too** — sessions, preferences, anything stateful. Don't ship features against in-memory state.

### What "infrastructure stable" means

You can answer YES to all of:
- Deploys from `git push origin master` work autonomously and reliably
- The deployed service stays live across hibernations and cold starts without losing user data
- A failed deploy doesn't break the live site (zero-downtime or near-zero)
- Schema migrations apply cleanly via `pnpm db:push` (or equivalent) with zero hand-holding
- Logs from any source (auth, payments, signals, errors) land in the right table queryable by the admin
- Stripe (or payment) test flows work end-to-end against test mode

If you can't answer YES to all of the above, you're in Phase 0. Fix it before Phase 1.

---

## Phase 1 — Sprint workflow

Once infrastructure is stable, all feature work happens in **discrete sprints**. Each sprint follows the same template.

### Sprint template (use for every sprint)

```markdown
# Sprint N — [Feature Name]

**Status:** Not started | In progress | Awaiting review | Merged | Reverted
**Branch:** [branch name]
**Owner:** [Claude Code session ID or human]
**Estimated scope:** [S/M/L based on file count and component count]

## 0. Pre-flight checks

Before writing any code, the executing agent (Claude Code or human) MUST:

- [ ] Pull latest `master`. `git fetch origin && git checkout master && git pull`
- [ ] Confirm there are no uncommitted local changes in working dir
- [ ] Read `docs/MTTBuild.md` (this skill) to refresh patterns
- [ ] Confirm there are no other open feature branches that touch the same files this sprint will touch — if there are, **resolve them first or ask the operator**
- [ ] Run `pnpm -r build` and confirm it succeeds against current master
- [ ] Run typecheck and note baseline error count — this sprint shouldn't introduce new errors beyond environmental ones

If any pre-flight check fails, stop and surface to the operator.

## 1. Goal

[One sentence — what this sprint ships]

## 2. Acceptance criteria

- [ ] [Specific user-visible outcome 1]
- [ ] [Specific user-visible outcome 2]
- [ ] [Logging is wired into the new code paths — every meaningful action calls `logSystem()` or `logUserAction()` as appropriate]
- [ ] All new endpoints have zod validation on inputs
- [ ] Migration files (if any) committed but NOT applied to live DB
- [ ] Migration plan doc (`docs/migrations/sprint-N-plan.md`) updated with rollback SQL and verification queries
- [ ] Documentation updated for any new public-facing concept
- [ ] Typecheck passes (no new errors beyond environmental)
- [ ] Build succeeds (`pnpm -r build`)

## 3. Out of scope

[Explicit list of things NOT in this sprint — prevents scope creep]

## 4. Stop and ask if

- The sprint requires touching files outside the planned scope
- An architectural decision needs to be made that wasn't specified
- Auth, payments, or production data are involved without operator review
- Merge conflicts arise that require judgment calls
- Anything surprises you (in-memory state, missing tables, undocumented dependencies)

## 5. Merge and ship checklist

When the sprint is feature-complete, the executing agent MUST:

- [ ] **Pull master AGAIN** and merge into the feature branch. `git fetch origin master && git merge origin/master`
- [ ] **Resolve any merge conflicts** — for each, document in commit message which side won and why
- [ ] **Re-run all checks** after merging master in: `pnpm -r build`, typecheck, manual smoke test of new feature
- [ ] **Update sprint doc** with what shipped and any deviations from the plan
- [ ] **Push the branch**
- [ ] Create PR. Description includes: what shipped, list of files changed, any decisions made, any open follow-ups
- [ ] Operator reviews PR
- [ ] Operator merges to master
- [ ] **Watch the auto-deploy.** If it fails, revert the merge immediately, don't try to fix-forward in production
- [ ] **Smoke-test the deployed version.** Hit `/health`, hit one feature endpoint, confirm logs are flowing
- [ ] **Update `docs/sprints/SPRINT_LOG.md`** with sprint completion entry
- [ ] **Verify the new sprint's logs are appearing** in the admin log viewer or via SQL query

## 6. Roll back if

- The deployed version breaks the live site for any user
- A schema migration corrupts data or fails partially
- Auth flows stop working
- Payments stop working

Roll back path: revert the merge commit on master, redeploy. If schema needs reverting, restore from the last good Supabase backup *before* re-running anything.
```

### Conflict prevention rules

These are the rules that prevent the 43-file conflict situation:

1. **One active feature branch at a time per project.** Don't have Sprint 1, Sprint 2, Sprint 3, and bug fixes all open simultaneously. Finish one, merge it, then start the next.

2. **Always start a sprint with `git pull origin master`.** No exceptions. If master has moved since the branch was created, rebase or merge before doing any new work.

3. **Always end a sprint with `git merge origin/master`** before opening a PR. Resolves conflicts while context is fresh, not a week later.

4. **No parallel Claude Code sessions on the same project.** Each session is independent and doesn't know about the others. Two sessions on the same codebase will collide. If you need to do two things, do them sequentially in the same session, or do one in Claude Code and the other in chat-only mode.

5. **No direct commits to master from outside the sprint workflow.** Hotfixes are sprints too — they get a branch, a PR, and review. The only exception is reverting a broken deploy.

6. **Tight scope per sprint.** If a sprint is touching more than ~10 files or feels like it's growing, split it. Smaller sprints land faster, conflict less, and review easier.

### Always publish latest, never old

Configure Render, Vercel, and any other auto-deploy platform to deploy **latest master** by default, never a pinned commit. Pinned commits are useful for emergency rollbacks but should never be the default state — they accumulate and silently drift from the active codebase.

After every merge to master, **verify the deploy actually went out**. Log into Render and Vercel, look at the deploy history, confirm the latest commit hash is what's running. Do this even if it "should be automatic" — failures here are silent and easy to miss.

---

## Phase 2 — Operating

Once a project has shipped its first features and has paying users (or any users with persistent state), operating discipline kicks in.

### Daily/weekly habits

- **Check error logs daily.** Query `systemLogs WHERE level IN ('error','critical') AND occurredAt > now() - interval '24 hours'`. Triage anything new.
- **Check deploy health daily.** Hit `/health` on every service. Confirm green.
- **Watch for in-memory state creep.** Any time a new feature persists data, ask "is this in Postgres?" — if not, fix before merging.
- **Backup verification weekly.** Confirm Supabase (or equivalent) automated backups exist and are recent. Test a restore once a quarter against a clone of the project.

### When something breaks in production

The instinct is to fix forward. **Don't.** Revert first, fix in a branch, re-merge.

Sequence:
1. Identify the bad commit
2. `git revert <commit-sha>` on master
3. Push, watch auto-deploy
4. Confirm site is restored
5. THEN open a branch, fix the bug, sprint workflow, re-merge

This costs 5 extra minutes vs. fix-forward, and it has saved every team that's ever adopted it from an extended outage.

### When schema changes are needed

Schema migrations follow the **never-apply-without-review** pattern from Sprint 2 of OQ:

1. Schema change goes into the migration file (Drizzle, Prisma, raw SQL — whatever the project uses)
2. `drizzle-kit generate` (or equivalent) produces the migration SQL
3. Migration file commits to the branch — does NOT auto-apply
4. Migration plan doc updated with rollback SQL, verification queries, and irreversibility notes
5. Operator reviews the migration file AND the plan doc
6. Operator applies via SQL editor or `pnpm db:push` with eyes on the output
7. Verification queries run, confirm shape
8. **Then** the code that uses the new schema gets merged

This sequence prevents "schema is here but code isn't" and "code is here but schema isn't" — both of which crash production.

---

## Project-specific overrides

Each project using MTTBuild can override or extend these defaults. Document overrides in a `docs/PROJECT_TEMPLATE_OVERRIDES.md` file. Common overrides:

- Different ORM (Prisma instead of Drizzle, etc.)
- Different host (Fly.io instead of Render, etc.)
- Different auth (Clerk instead of Auth0, etc.)
- Project-specific table additions to the Phase 0 logging schema

Don't override without writing the override down. Future Claude Code sessions will follow this skill literally and produce the wrong defaults if overrides aren't documented.

---

## What this skill is NOT

- **Not a coding standards guide.** Style, naming, formatting — those are project-level decisions.
- **Not a feature spec.** Sprint contents are project-specific. This skill defines how sprints get planned, executed, and shipped.
- **Not a substitute for thinking.** When this skill's guidance conflicts with what the project actually needs, the project wins. Tell the operator and document the deviation.

---

## Quick-start: starting a new project with MTTBuild

1. Save this file as `docs/MTTBuild.md` in the new project's repo
2. Phase 0 checklist — work through it before any feature
3. Set up the logging tables and wrapper as part of the very first migration
4. Create `docs/sprints/SPRINT_LOG.md` for sprint completion entries
5. First sprint is always "Foundation verification + first feature." Half infrastructure check, half a small visible feature, to confirm the end-to-end pipeline works.

## Quick-start: resuming work on an existing MTTBuild project

1. Read `docs/MTTBuild.md` and `docs/sprints/SPRINT_LOG.md`
2. Run Phase 0 checklist as a smoke test — anything new broken since last session?
3. Pull master
4. Plan the next sprint using the template above
5. Branch, build, merge, ship

---

*Last updated: May 4, 2026. This skill evolves with use — when a new failure mode is discovered, encode the lesson here so it doesn't repeat.*
