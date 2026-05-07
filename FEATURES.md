# AI Connect — Features

This document tracks what AI Connect actually does for you, on two dimensions:

- **[Part 1](#part-1--what-ai-connect-solves)** — the problems AI Connect is designed to solve, framed in terms of pain a working developer recognizes
- **[Part 2](#part-2--system-features)** — the concrete system features that exist in AI Connect today, marked as Shipped, In progress, or Planned

Part 2 is updated at the end of every sprint. If you want to know whether a specific capability exists right now, look there.

---

## Part 1 — What AI Connect solves

### The orchestration mess

AI dev tooling in 2026 is excellent and fragmented. Claude, Claude Code, Cursor, Replit AI, Perplexity Sonar, Perplexity Computer, OpenClaw, local Ollama — each is the right tool for some specific class of work. None of them talk to each other. A solo developer building a real product routinely uses four to seven of them in a single working session, juggling browser tabs, terminal windows, IDE panes, and Slack channels.

When AI Connect ships, you stop juggling tabs. You type into one chat. AI Connect routes to the right AI for the task — Claude for planning, Claude Code or Cursor for execution, Perplexity for research, OpenClaw for overnight runs — and the work happens in your repo. The result comes back to the same chat where the prompt started.

This directly attacks two of the named bottlenecks from the README: the "context-loading tax" (re-explaining the project to every new AI) and the "handoff cliff" (context dropping when work moves between tools). Both go away.

### The methodology drift

Every solo dev with serious AI assistance accumulates lessons the hard way: Phase 0 infrastructure must be stable before features, schema migrations must never auto-apply, in-memory state on hibernating hosts is a trap, master-pull-before-and-after every sprint prevents most merge conflicts. Most of these lessons are written down somewhere — a notes file, a personal markdown doc, a stale README. None of them are *enforced*. Under deadline pressure, the dev cuts corners. The corners come back as bugs three weeks later. The lesson gets re-learned.

AI Connect enforces the [MTTBuild methodology](docs/MTTBuild.md) as platform behavior, not documentation:

- Phase 0 before features (won't let you start feature work on shaky infrastructure)
- Sprint discipline (template enforced, scope checked, pre-flight required)
- Master-pull before and after every sprint
- No parallel branches on the same project
- No direct commits to master
- Migrations never auto-apply
- Logging tables exist before any feature ships

The reason OptimaQuant deploys have hit walls — IPv6 pooler issues, in-memory state on hibernating Render instances, schema-and-code out of sync — is precisely because methodology gets cut under deadline pressure. AI Connect won't let you cut it. The platform doesn't expose the corners.

### The audit trail

When something breaks in production six weeks from now, "what changed and why" should have a clean answer. With three or four AI assistants contributing to the codebase across browser tabs and terminal windows, it usually doesn't. Git blame shows a commit; the commit doesn't say "this came from a Claude Code session that was responding to a prompt I copied from a Claude chat that was researching an issue Perplexity found."

AI Connect makes every dispatch a first-class object. Every prompt to every AI produces a `run_id`. Every run is queryable forever. The chat is not just a conversation; it is the audit trail of every AI-assisted decision the dev has ever made on the project. Every artifact (commit, PR, diff, deployed URL) traces back to the prompt that produced it, the AI that did the work, and the sprint that contained it.

OptimaQuant doesn't currently have this. Some of its harder debugging sessions are harder than they need to be specifically because the chain of reasoning that produced a change is unrecoverable. AI Connect projects don't have that problem.

### The framework-rebuild tax

Every new project today starts from a blank repo. You set up Render, you set up Vercel, you write the `/health` endpoint, you configure the IPv4 pooler, you bind to `0.0.0.0`, you create the logging tables, you wire Stripe, you seed the admin user. By Sprint 1 of the new project, you've spent three days redoing infrastructure work you've done six times before. None of it carries forward because there's no template, no pattern library, no enforced bootstrap.

AI Connect templates Phase 0. The next time you start a new Macro Tech Titan product, the platform scaffolds the infrastructure, runs the checklist, wires the auto-deploy, creates the logging tables, and seeds the admin user. Phase 0 takes 30 minutes instead of 3 days, and it's correct the first time because it's the same template that has worked across every prior project.

---

## Part 2 — System features

This is the live capability inventory. It is updated at the end of every sprint. Status legend:

- ✅ **Shipped** — built, deployed, in use
- 🚧 **In progress** — currently being built; sprint reference noted
- 📋 **Planned** — on the roadmap; sprint number noted if known
- ❌ **Not yet planned** — known to be needed eventually but not on a current roadmap

### Infrastructure and methodology

| Feature | Status | Sprint | Notes |
|---|---|---|---|
| Phase 0 infrastructure checklist (template) | 📋 Planned | Sprint 0 | Render, Vercel, Supabase, Auth0, Stripe, logging tables for AI Connect itself |
| `/health` endpoint | 📋 Planned | Sprint 0 | API server returns 200 with no auth, no DB |
| IPv4 Postgres pooler configured | 📋 Planned | Sprint 0 | Supabase session pooler |
| Auth0 application + API audience | 📋 Planned | Sprint 0 | Shared `macrotechtitandev` tenant, new app |
| Stripe env vars (test mode) | 📋 Planned | Sprint 0 | No products yet, just env wiring |
| `systemLogs`, `userAuditLogs`, `devLogs` tables | 📋 Planned | Sprint 0 | With indexes per MTTBuild spec |
| Logging wrapper (`logSystem`, `logUserAction`, `logDev`) | 📋 Planned | Sprint 0 | TypeScript module |
| Auto-deploy on push to master | 📋 Planned | Sprint 0 | Render + Vercel from GitHub |
| Phase 0 audit for user projects | 📋 Planned | Sprint 3 | Read-only initial pass |
| Phase 0 auto-fix for user projects | ❌ Not yet planned | — | Future — beyond Sprint 10 |

### Authentication and identity

| Feature | Status | Sprint | Notes |
|---|---|---|---|
| Auth0 SPA login flow | 📋 Planned | Sprint 1 | Browser → Auth0 → callback → token |
| JWT validation on API server | 📋 Planned | Sprint 1 | Against Auth0 JWKS |
| Admin user seed (idempotent) | 📋 Planned | Sprint 0 | `jgelet@macrotechtitan.com` |
| Admin gate middleware | 📋 Planned | Sprint 1 | 403 for non-admin emails |
| User dashboard (empty state) | 📋 Planned | Sprint 1 | Shows email, no projects yet |
| Multi-user workspaces | 📋 Planned | v2 | Post-launch |

### Provider integrations (BYOAI)

| Feature | Status | Sprint | Notes |
|---|---|---|---|
| Encrypted credential vault (AES-256-GCM) | 📋 Planned | Sprint 2 | `MASTER_KEY` env var |
| Add/edit/remove Anthropic provider | 📋 Planned | Sprint 2 | UI + API |
| Test connection to Claude | 📋 Planned | Sprint 2 | Decrypt → call → log |
| OpenAI provider | 📋 Planned | Sprint 8 | Same vault pattern |
| Perplexity Sonar provider | 📋 Planned | Sprint 8 | Same vault pattern |
| Groq provider | 📋 Planned | Sprint 8 | Same vault pattern |
| Google Gemini provider | 📋 Planned | Sprint 8 | Same vault pattern |
| Local Ollama provider | 📋 Planned | post-Sprint 10 | Different connection model |
| Custom OpenAI-compatible endpoint | 📋 Planned | post-Sprint 10 | User-defined base URL |

### Project management

| Feature | Status | Sprint | Notes |
|---|---|---|---|
| GitHub OAuth connection | 📋 Planned | Sprint 3 | Read repo, write `.mtt/`, list branches, open PRs |
| Connect new project (repo picker) | 📋 Planned | Sprint 3 | Select existing GitHub repo |
| `.mtt/` directory init on connect | 📋 Planned | Sprint 3 | Commits initial state files |
| Project dashboard with Phase 0 status badge | 📋 Planned | Sprint 3 | Per-project landing |
| Multi-project switcher | 📋 Planned | Sprint 3 | UI for users with >1 project |

### Chat and orchestration core

| Feature | Status | Sprint | Notes |
|---|---|---|---|
| Chat UI per project | 📋 Planned | Sprint 4 | Persisted to `messages` table |
| Inference dispatch to Claude (hardcoded) | 📋 Planned | Sprint 4 | Streaming response |
| Sprint creation from chat | 📋 Planned | Sprint 5 | Chat → drafted sprint plan → committed to `.mtt/state/` |
| Multi-provider routing (intelligent) | 📋 Planned | Sprint 8 | Task classification → provider selection |
| Manual provider override per message | 📋 Planned | Sprint 8 | User can force a specific provider |
| Run inspector | 📋 Planned | Sprint 9 | Status, artifacts, logs per `run_id` |

### GitHub message bus

| Feature | Status | Sprint | Notes |
|---|---|---|---|
| `.mtt/inbox/` write from AI Connect | 📋 Planned | Sprint 6 | One file per message |
| `.mtt/outbox/` read by AI Connect | 📋 Planned | Sprint 6 | Webhook-triggered |
| Manual pickup verification | 📋 Planned | Sprint 6 | No daemon yet — verify round-trip |
| Replit polling daemon (100s) | 📋 Planned | Sprint 7 | Reusable Python script |
| Cursor MCP server | 📋 Planned | post-Sprint 10 | Native MCP integration if available |

### Agentic targets

| Feature | Status | Sprint | Notes |
|---|---|---|---|
| Claude Code dispatch via MCP | 📋 Planned | Sprint 9 | First true agentic target with run lifecycle |
| Run lifecycle (dispatched/running/awaiting/complete/failed) | 📋 Planned | Sprint 9 | First-class run states |
| Cursor dispatch via message bus | 📋 Planned | post-Sprint 10 | Already supported by Sprint 6/7 infrastructure |
| Replit AI dispatch via message bus | 📋 Planned | post-Sprint 10 | Already supported by Sprint 6/7 infrastructure |
| Perplexity Computer dispatch | 📋 Planned | post-Sprint 10 | Perplexity Max API |
| OpenClaw dispatch via WebSocket | 📋 Planned | post-Sprint 10 | User-hosted instance |

### Methodology enforcement

| Feature | Status | Sprint | Notes |
|---|---|---|---|
| Sprint template (UI form) | 📋 Planned | Sprint 5 | Goal, criteria, out-of-scope, stop-and-ask |
| Pre-flight checks (auto-run) | 📋 Planned | Sprint 5 | Pull master, check baseline build |
| Conflict prevention — one branch per project | 📋 Planned | Sprint 5 | Refuses to start Sprint N+1 if Sprint N is unmerged |
| Conflict prevention — no parallel agentic runs | 📋 Planned | Sprint 9 | Refuses second dispatch on same project |
| Migration plan generator | 📋 Planned | post-Sprint 10 | Drizzle/Prisma migration → plan doc |
| Daily error log digest | 📋 Planned | post-Sprint 10 | Phase 2 operating discipline |

### Skills and templates

| Feature | Status | Sprint | Notes |
|---|---|---|---|
| Platform skills committed to repo | ✅ Shipped | Pre-Sprint 0 | BYOAI, GitHub sync, cache busting, Replit fix |
| Project-scoped skills (`.mtt/skills/`) | 📋 Planned | Sprint 3 | Auto-loaded by AI Connect when project is active |
| User-scoped skills (across projects) | 📋 Planned | post-Sprint 10 | Stored in AI Connect database |
| Community skill marketplace (read) | 📋 Planned | post-Sprint 10 | v2 |
| Community skill marketplace (publish) | 📋 Planned | v2 | Revenue share via Stripe Connect |
| Project templates (e.g., "New SaaS — Phase 0 standard") | 📋 Planned | post-Sprint 10 | Scaffold new project from template |

### Billing

| Feature | Status | Sprint | Notes |
|---|---|---|---|
| Stripe products and prices configured | 📋 Planned | Sprint 10 | Free / Hosted $29 / Hosted+Tokens $49 |
| Subscription wiring | 📋 Planned | Sprint 10 | Auth0 token reflects subscription state |
| MTT subscriber bundling | 📋 Planned | Sprint 10 | OQ Pro etc. → AI Connect Hosted included |
| Token metering for $49 tier | 📋 Planned | post-Sprint 10 | Platform-supplied tokens with overage to BYOAI |
| Team tier ($199) | 📋 Planned | v2 | Multi-user workspace |

### Self-host and open core

| Feature | Status | Sprint | Notes |
|---|---|---|---|
| MIT license on framework | ✅ Shipped | Pre-Sprint 0 | LICENSE file in repo root |
| Repo public on GitHub | ✅ Shipped | Pre-Sprint 0 | `MacroTechTitan/AI-Connect` |
| Self-host quick-start guide | 📋 Planned | post-Sprint 10 | After hosted version stabilizes |
| Docker compose for self-host | 📋 Planned | post-Sprint 10 | One-command local deploy |

### Operational visibility

| Feature | Status | Sprint | Notes |
|---|---|---|---|
| `systemLogs` queryable from admin UI | 📋 Planned | post-Sprint 10 | Beyond core MVP |
| Run history per project (UI) | 📋 Planned | Sprint 9 | List, filter, drill into runs |
| Per-provider cost dashboard | 📋 Planned | post-Sprint 10 | Token usage by provider, by project |
| Daily error log digest email | 📋 Planned | post-Sprint 10 | Phase 2 operating |

---

## How this document is maintained

At the end of every sprint, the merge-and-ship checklist includes "update FEATURES.md if user-visible capabilities changed." Status flips happen in the same commit as the sprint that delivered them. If you read this document and a feature is marked ✅ Shipped, the corresponding capability is live.

If you spot a discrepancy — a feature you can use that's still marked Planned, or a Shipped feature that doesn't actually work — open an issue with the `documentation` label.

---

*Last updated: May 5, 2026 — pre-Sprint-0 baseline*
