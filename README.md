# AI Connect

> **The unified orchestration layer for AI-assisted development.**
> One chat. Many AIs. Your repo. Your methodology. Your pace.

`aiconnect.macrotechtitan.com` · MIT License · Built by [Macro Tech Titan](https://macrotechtitan.com)

**See also:** [FEATURES.md](FEATURES.md) (what AI Connect solves and what's shipped) · [docs/MTTBuild.md](docs/MTTBuild.md) (the methodology) · [SPRINT_0_HANDOFF.md](SPRINT_0_HANDOFF.md) (handoff text for Sprint 0)

---

## Table of Contents

1. [What this is and why it exists](#1-what-this-is-and-why-it-exists)
2. [Heritage — what came before](#2-heritage--what-came-before)
3. [Architecture](#3-architecture)
4. [The MTTBuild methodology, embedded](#4-the-mttbuild-methodology-embedded)
5. [Core concepts](#5-core-concepts)
6. [Integrations](#6-integrations)
7. [Pricing and tiers](#7-pricing-and-tiers)
8. [Self-host vs hosted](#8-self-host-vs-hosted)
9. [Roadmap and sprints](#9-roadmap-and-sprints)
10. [Contributing](#10-contributing)
11. [Status and changelog](#11-status-and-changelog)

---

## 1. What this is and why it exists

AI Connect is a single chat interface that routes your prompts to the right AI tool — Claude for planning, Claude Code or Cursor for execution, Perplexity for research, OpenClaw for overnight runs, your local Ollama for offline work — and enforces a disciplined build methodology on top.

This section is longer than most READMEs lead with, and deliberately so. The problem AI Connect solves is real, persistent, and underappreciated, and the design choices that follow only make sense once the problem is described honestly. If you're skimming, the rest of the document is structured to be useful without this section. If you want to know *why* this product exists and not just *what* it is, read on.

### 1.1 The state of building with AI in 2026

The AI-assisted development tooling landscape has expanded faster in the last twelve months than at any prior point in the history of software. Claude Code shipped a coding agent that operates as a subprocess in your terminal. Cursor evolved from a VS Code fork into the dominant AI-native IDE. Replit added a full agent into its hosted environment. Perplexity launched both Comet (an agentic browser) and Computer (a general-purpose digital worker running in an isolated sandbox). OpenClaw made it possible to run Claude Code-style agents indefinitely on a Mac Mini in your closet. Local LLM stacks (Ollama, LM Studio) crossed the threshold of being genuinely useful for code tasks. MCP — Model Context Protocol — emerged as a real standard for tool wiring.

Each of these is excellent. Each is the right tool for some specific class of work. None of them know about each other.

A solo developer building a real product today routinely uses four, five, sometimes seven of these tools in a single working session. You start the morning planning a sprint with Claude in a browser tab. You hand the sprint off to Claude Code in a terminal. Claude Code gets stuck on an environmental issue and you switch to Cursor to do an interactive refactor. You realize you need to research a third-party API and switch to Perplexity. The fix involves a long-running data migration so you delegate that to Perplexity Computer or OpenClaw. You come back four hours later to review what happened and the results are scattered across five tabs, two terminal sessions, three commit messages, and a Slack channel where OpenClaw posted progress updates. Where exactly did the regression in the auth flow get introduced? Which AI suggested the fix that broke it? When was the last time the deploy actually went green? These questions become surprisingly hard to answer, and the answer time grows nonlinearly with the complexity of the project.

This is not a tooling problem. The tools are great. It is an *orchestration* problem.

### 1.2 The bottlenecks, named explicitly

Every AI-assisted developer hits the same set of bottlenecks. Most don't name them out loud because they feel like personal failings rather than structural ones. They aren't.

**The context-loading tax.** Every new conversation with every new AI starts from zero. You re-explain what the project is, what stack it uses, what conventions you follow, what the sprint goal is, what the recent failures were, what the deploy environment looks like. By the time you've finished onboarding the AI, half your morning is gone. The same context exists somewhere — usually in the previous chat, the previous Claude Code session, the previous Cursor thread — but it doesn't travel.

**The handoff cliff.** When work flows from one tool to another (planning to execution, execution to review, review to deploy), context drops. A sprint planned thoroughly with Claude becomes "fix the auth bug" by the time it reaches Claude Code. The acceptance criteria, the out-of-scope list, the stop-and-ask conditions — all of it tends to evaporate at the boundary. The AI that does the work has less information than the AI that planned it, which is exactly backwards from what should happen.

**The methodology drift.** Every solo dev with serious AI assistance accumulates personal lessons — Phase 0 infrastructure must be stable before features, schema migrations must never auto-apply, in-memory state on hibernating hosts is a trap, master-pull-before-and-after every sprint prevents 80% of merge conflicts. Most of these lessons are written down somewhere, in a notes app or a personal markdown file. None of them are enforced. Under deadline pressure, the dev cuts corners. The corners come back as bugs three weeks later. The lesson gets re-learned. The notes file gets a new bullet point. Nothing structural changes.

**The audit black hole.** When something breaks in production, the question "what changed and who decided to change it" should have a clean answer. With three or four AI assistants contributing to the codebase, it usually doesn't. Git blame shows a commit; the commit doesn't say "this came from a Claude Code session that was responding to a prompt I copied from a Claude chat that was researching an issue Perplexity found." The chain of reasoning that produced the change is unrecoverable, and so the lessons are unlearnable.

**The cost-of-experimentation tax.** Want to try Perplexity Computer for a long-running task? You need a Perplexity Max subscription. Want to try OpenClaw? You need a Mac Mini, an eSIM, and a weekend. Want to try Cursor's agent mode? Sign up, install, configure, learn its quirks. Each new tool is a multi-day investment before you find out whether it's actually better than what you were doing before. The dev who just sticks with one tool because the switching cost is too high is making a rational local decision and a poor global one.

**The "is this still the truth" problem.** AI assistants confidently produce information that was true a year ago and isn't anymore. Library APIs change. Pricing pages change. Best practices change. The dev who trusts the AI's training data ships against stale facts. The dev who searches the web every time loses speed. The dev who knows when to trust and when to verify is the one who ships, but that judgment is hard-won and rarely systematized.

**The framework-rebuild tax.** Every new project starts from a blank repo. You set up Render, you set up Vercel, you write the `/health` endpoint, you configure the IPv4 pooler, you bind to `0.0.0.0`, you set up the logging tables, you wire Stripe, you seed the admin user. By Sprint 1 of the new project, you've spent three days redoing infrastructure work you've done six times before. None of it carries forward because there's no template, no pattern library, no enforced bootstrap.

These bottlenecks compound. A solo dev hitting all of them — and most of them hit all of them — is operating at perhaps thirty percent of the productivity their tooling theoretically enables.

### 1.3 What we actually want to achieve

AI Connect's stated goal is to compress the gap between *what AI tooling theoretically enables* and *what a disciplined solo developer actually achieves with it*. That's the headline. The substance is more specific.

**Goal one: make the chat the canonical surface, and make every dispatch from chat traceable.** A user opens AI Connect. They type. Whatever they type — a question, a task, a sprint plan, a deploy command — gets routed to the appropriate AI tool, with the appropriate context, and the result comes back to the same place. Every dispatch produces a `run_id`. Every run is queryable forever. The chat is not just a conversation; it is the audit trail of every AI-assisted decision the dev has ever made on the project.

**Goal two: stop re-explaining context.** AI Connect knows what project you're working on, what stack it uses, what its sprint history looks like, what its deploy state is, what the last error was, what skills are loaded for it. When you dispatch to Claude Code or Cursor or Perplexity Computer, that context travels with the dispatch. The AI that does the work has at least as much context as you do, ideally more.

**Goal three: encode methodology as platform behavior.** Phase 0 infrastructure checks aren't a checklist you remember to run; they're a thing the platform enforces before letting you write features. Sprint conflict prevention isn't a habit; it's a constraint the dispatcher imposes. Audit logging isn't something you bolt on later; it's wired in before Sprint 1 of every project. The dev cannot cut corners because the platform doesn't expose the corners.

**Goal four: let each tool do what it's best at, and route accordingly.** Claude is unmatched at planning, reasoning, and synthesis. Claude Code is unmatched at multi-file edits in a real terminal. Cursor is unmatched at IDE-grounded refactors. Perplexity Sonar is unmatched at web-grounded research. Perplexity Computer is unmatched at long-running sandboxed tasks. OpenClaw is unmatched at unbounded execution on infrastructure you control. Local Ollama is unmatched at privacy-sensitive work. AI Connect's job is to know which is which and route accordingly — by default, with the user able to override.

**Goal five: make experimentation cheap.** Adding Perplexity Computer to your toolkit should be a five-minute step (paste API key, route a task), not a five-day evaluation. Switching from OpenAI to Anthropic for a class of work should be a one-line config change, not a week of refactoring. The platform absorbs the integration cost so the user can experiment freely.

**Goal six: make the framework portable.** AI Connect is open-source MIT-licensed. A user who outgrows the hosted product, or who needs to run AI Connect on air-gapped infrastructure, or who wants to fork the methodology for their team's specific needs, can do so without asking permission and without losing functionality. The hosted version exists because operating AI Connect well is non-trivial and most users would rather pay $29 a month than think about it. But the option to self-host is real, not a marketing prop.

**Goal seven: solve the author's problem first, then generalize.** AI Connect is built by a solo developer (Joseph Gelet) primarily for his own use, on his own products, with his own pain as the design driver. It will not ship features that look good in marketing screenshots but don't help him build OptimaQuant faster and more reliably. This is a deliberate constraint. Products built to solve their author's actual problem tend to be better than products built to solve a hypothetical user's imagined problem.

### 1.4 The design philosophy that emerged

A handful of design decisions follow from these goals and bottlenecks. These aren't arbitrary; they're consequences.

**Repo as substrate.** AI Connect doesn't host your code. It writes into your GitHub repo. Every dispatch leaves a commit. Every artifact is a git object. Every audit trail is `git log`. This is unfashionable in an era of "all-in-one platforms," but it has the property that AI Connect can disappear tomorrow and your work is intact. The lock-in is purely operational, not structural.

**Inference vs agentic, treated differently.** Sending a prompt to Claude and getting text back is fundamentally different from dispatching a task to OpenClaw and getting a `run_id`. The first happens in seconds and lives in conversation memory. The second happens in hours and lives in run history. Conflating them produces bad UI and bad APIs. AI Connect distinguishes them at every level — schema, route, UI surface, error handling.

**The GitHub message bus.** Cursor and Replit and similar IDE-bound tools don't expose programmable dispatch APIs in a way that's reliable across versions. Rather than fight that, AI Connect uses the repo itself as a message broker. A `.mtt/inbox/` directory receives prompts; a `.mtt/outbox/` directory receives responses; a daemon on the IDE side watches the inbox. This pattern is not novel — GitOps and Renovate work the same way — but applying it to AI dispatch is. It works on every IDE that can read files, which is all of them.

**BYOAI by default.** AI tokens are expensive enough that hiding them behind a markup is hard to justify, and getting an API key is no longer a meaningful barrier for most devs. AI Connect Hosted charges $29/month flat for orchestration and methodology; the dev pays providers directly. A small "with included tokens" tier ($49) exists for users who explicitly want to pre-buy, but BYOAI is the default and the recommended path.

**Infrastructure-first, recursively.** AI Connect is itself built using MTTBuild. The platform that enforces Phase 0 on user projects has Phase 0 enforced on itself. Sprint 0 of AI Connect is *just* infrastructure, with zero feature work. This is awkward to explain to investors and obvious to engineers.

**Open core, real moat.** The framework is MIT. The hosted product (managed Auth0, Stripe, marketplace, support, SLA) is proprietary. The moat is operational excellence and brand, not source code lockup. This works for Supabase, PostHog, Cal.com, and a dozen other open-core SaaS plays. It will work here.

**Honest about limitations.** AI Connect does not solve every problem. It does not magically make AI better at code. It does not eliminate the need to read what the AI produces. It does not save you from yourself if you skip the methodology it tries to enforce — though it makes skipping harder. It will not turn a junior dev into a senior dev. It is a coordination layer, not a competence multiplier.

### 1.5 Why this is the right time to build it

Three conditions converged in 2025–2026 that make AI Connect feasible now and not earlier.

First, the agentic AI tools that AI Connect orchestrates are real products with real users, not research demos. Claude Code, Cursor, Replit AI, Perplexity Computer, and OpenClaw all shipped to general availability in this window. Building an orchestration layer over vaporware is a category error; building it over five widely-used products is a defensible thesis.

Second, MCP and similar tool-protocol standards have crystallized enough to make integration tractable. AI Connect doesn't have to invent a wire format for every target; it inherits MCP for the targets that support it and falls back to the repo bus for those that don't.

Third, the methodology side has matured. MTTBuild — the methodology AI Connect encodes — is the product of three years of solo product development with AI assistance, including specific failure modes (the 43-file merge conflict, the in-memory-state-on-hibernating-host trap, the schema-and-code-out-of-sync deploy) that are now well-understood and preventable. Without a methodology worth enforcing, AI Connect would be a router with delusions of grandeur. With it, AI Connect is a coherent product.

The window for building this is open now. It will not stay open forever. Anthropic, OpenAI, or one of the IDE vendors will eventually ship something in this space that's "good enough" for most users, at which point the bar for an independent open-source alternative will be much higher. AI Connect is not racing those companies — they have other priorities and slower release cycles for products outside their core — but the time to establish the open-source standard for AI-dev orchestration is now, not in eighteen months.

### 1.6 The short version

AI Connect is a single chat interface that routes your prompts to the right AI tool, carries context across handoffs, enforces a disciplined build methodology, and writes everything to your repo. It's open-source, $29/month hosted, BYOAI, and built by a solo developer for solo developers and small teams who feel the orchestration pain acutely.

The rest of this document explains how.

---

## 2. Heritage — what came before

AI Connect inherits from two prior projects in the Macro Tech Titan ecosystem.

**MTTBuild** (`docs/MTTBuild.md` in this repo, originally authored for OptimaQuant) is the methodology AI Connect encodes. Phase 0 infrastructure-first discipline, sprint workflow with explicit pre-flight and merge checklists, conflict prevention rules, and Phase 2 operational habits — all of it lives in MTTBuild and is enforced by AI Connect at the platform level. MTTBuild is the *why*; AI Connect is the *how*.

**Matt** (sometimes referenced as OmniLang, lives at [`MacroTechTitan/OmniLang`](https://github.com/MacroTechTitan/OmniLang)) is a Replit-style AI vibe-coding platform — an in-browser IDE that generates and deploys apps from natural-language prompts. Matt is a separate product with overlapping vocabulary but architecturally distinct goals. AI Connect orchestrates *across* AI dev tools; Matt *is* an AI dev tool. Both products will eventually live under the broader **MTT AI** umbrella at `ai.macrotechtitan.com`, with AI Connect at `aiconnect.macrotechtitan.com` and Matt at its own subdomain when it ships. Until then, AI Connect is built fresh and the Matt repo is untouched.

**OptimaQuant** (`optimaquant.com`) is the proving ground. AI Connect is built first and foremost to make OptimaQuant's development faster and more disciplined. Every sprint of AI Connect ships against a real backlog item from OQ. Dogfooding is mandatory; AI Connect's first paying customer is its author.

---

## 3. Architecture

### 3.1 The two-axis routing model

AI Connect distinguishes two classes of AI target. The distinction is not aesthetic — it determines the entire interaction lifecycle, the latency budget, the storage model, and the UI affordances.

**Inference targets** are stateless prompt-response endpoints. You send a message, you get a response in seconds. Examples: Claude API, OpenAI, Groq, Gemini, Perplexity Sonar, local Ollama.

**Agentic targets** are long-running task executors. You dispatch a task, you receive a `run_id`, and the agent works for minutes to hours before producing an artifact (a commit, a PR, a diff, a deployed URL). Examples: Claude Code, Cursor, Replit AI, Perplexity Computer, OpenClaw.

The full routing matrix:

| Target | Class | Mechanism | Best for |
|---|---|---|---|
| Claude (chat) | Inference | API (BYOAI) | Planning, sprint design, decisions |
| OpenAI / Groq / Gemini | Inference | API (BYOAI) | User preference, fallback |
| Perplexity Sonar | Inference | API (BYOAI) | Research, fact-finding, citations |
| Local Ollama | Inference | HTTP API | Offline, privacy-sensitive |
| Claude Code | Agentic | MCP / official SDK | Sprint execution, code edits |
| Cursor | Agentic | GitHub message bus | IDE-grounded refactors |
| Replit AI | Agentic | GitHub message bus + 100s pull | Hosted execution, deploy fixes |
| Perplexity Computer | Agentic | Perplexity API (Max tier) | Long-running research+code in sandbox |
| OpenClaw | Agentic | WebSocket to user's instance | Self-hosted overnight runs, full filesystem |

### 3.2 The GitHub message bus

For agentic targets that don't expose a programmatic dispatch API — Cursor and Replit AI primarily — AI Connect uses the user's repo as a message bus. This is the same pattern that powers GitOps, Dependabot, and Renovate, applied to AI orchestration.

Every project connected to AI Connect gets a hidden `.mtt/` directory committed to the repo:

```
your-project/
├── .mtt/
│   ├── inbox/                      ← AI Connect writes here
│   │   ├── 2026-05-05-001.md       (prompt for Cursor or Replit)
│   │   └── 2026-05-05-002.md
│   ├── outbox/                     ← Agents write replies here
│   │   └── 2026-05-05-001.reply.md
│   ├── state/
│   │   ├── current-sprint.json
│   │   ├── phase-0-checklist.json
│   │   └── sprint-log.json
│   └── skills/                     ← Project-specific skills, auto-loaded
│       └── *.md
└── (rest of project)
```

Each message is a git commit. Every prompt, every reply, every routing decision lives in git history forever. The audit trail is free.

A small daemon on the agentic target (a Replit Python scheduler running every 100 seconds, a Cursor MCP server, etc.) watches `.mtt/inbox/`, picks up new files, dispatches them to its native AI, and writes the result to `.mtt/outbox/`. AI Connect's web UI watches `.mtt/outbox/` via webhook and surfaces the result back in chat.

The 100-second poll interval is deliberately conservative. It survives Replit hibernations, GitHub rate limits, and unstable home networks. Faster is possible (10–30s) for power users; slower (5+ min) is fine for batch overnight work.

### 3.3 Run lifecycle

Every agentic dispatch produces a `run_id` (vocabulary borrowed from OpenClaw, applied universally). The lifecycle:

1. **Dispatch** — User sends a prompt. Router classifies the task, selects the target, writes the dispatch (API call for direct targets, inbox file for message-bus targets).
2. **Acknowledged** — Target confirms receipt. For inbox-based targets, this is the first poll that picks up the file.
3. **Running** — Agent is working. AI Connect surfaces status updates in the chat thread.
4. **Awaiting input** — Optional. Agent is blocked on a human decision (approve a destructive action, choose between options).
5. **Complete** — Artifact is ready. Could be a commit, a PR URL, a diff, a deployed URL, a text response.
6. **Failed** — Run errored. Logs preserved.

Runs are first-class objects in AI Connect's database. Users can list, filter, resume, and cancel runs from the dashboard.

### 3.4 The four planes

```
┌─────────────────────────────────────────────────────────────────┐
│  USER PLANE                                                     │
│  Chat UI · Dashboard · Sprint board · Run inspector             │
│  aiconnect.macrotechtitan.com                                   │
└────────────────────────┬────────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────────┐
│  ORCHESTRATION PLANE                                            │
│  Router · Run lifecycle · Methodology enforcement (MTTBuild)    │
│  Skill loader · Template engine · Audit logger                  │
│  Render-hosted Express API                                      │
└──────┬──────────┬──────────────┬─────────────┬──────────────────┘
       │          │              │             │
┌──────▼───┐ ┌────▼─────┐ ┌──────▼──────┐ ┌────▼─────────────────┐
│ INFERENCE│ │ AGENTIC  │ │  REPO BUS   │ │ STATE                │
│ Claude   │ │ Claude   │ │  GitHub     │ │ Postgres (Supabase)  │
│ OpenAI   │ │  Code    │ │ .mtt/inbox  │ │ Auth0 (shared tenant)│
│ Groq     │ │ Cursor   │ │ .mtt/outbox │ │ Stripe (shared)      │
│ Gemini   │ │ Replit   │ │             │ │ Logs (systemLogs +   │
│ Perplex. │ │ Perplex. │ │             │ │  userAuditLogs +     │
│  Sonar   │ │  Computer│ │             │ │  devLogs)            │
│ Ollama   │ │ OpenClaw │ │             │ │                      │
└──────────┘ └──────────┘ └─────────────┘ └──────────────────────┘
```

User plane talks only to orchestration plane. Orchestration plane fans out to providers, message bus, and state. State is queryable from user plane via the orchestration API only — no direct DB access from the browser.

### 3.5 What's deployed where

| Component | Host | Domain |
|---|---|---|
| Frontend (Vite + React) | Vercel | `aiconnect.macrotechtitan.com` |
| API server (Express) | Render | `api.aiconnect.macrotechtitan.com` |
| Database | Supabase Postgres | (Session pooler, IPv4) |
| Auth | Auth0 | `macrotechtitandev.us.auth0.com` (shared tenant, new application) |
| Billing | Stripe | (shared with other MTT products) |
| Repo / message bus | GitHub | User-owned repos |


---

## 4. The MTTBuild methodology, embedded

AI Connect doesn't recommend MTTBuild — it enforces it. Every project initialized through AI Connect goes through the Phase 0 checklist before feature work is permitted. Every sprint follows the template. Every merge runs the conflict-prevention rules.

This section summarizes how the methodology shows up in the platform. The full methodology document lives at [`docs/MTTBuild.md`](docs/MTTBuild.md).

### 4.1 Phase 0 — Infrastructure first

When you connect a new project to AI Connect, the platform runs an automated Phase 0 audit and surfaces a checklist:

- Hosting in place (Render or equivalent for API, Vercel or equivalent for frontend)
- `/health` endpoint returning 200 with no auth, no DB dependency
- Server binds to `0.0.0.0` explicitly
- Database is Postgres on an IPv4-compatible pooler
- Environment variables are platform-agnostic
- Stripe (or payment provider) wired with plain env vars
- GitHub repo connected for auto-deploy on push to master
- `systemLogs`, `userAuditLogs`, `devLogs` tables exist and are indexed
- Logging wrapper exposes `logSystem()`, `logUserAction()`, `logDev()`
- Users table exists in Postgres; admin idempotently seeded

Failed checks are surfaced as actionable items. AI Connect can dispatch a sprint to fix any of them.

### 4.2 Phase 1 — Sprint workflow

Sprint creation in AI Connect is structured. You don't write a sprint by typing free-form prose; you fill out a template:

- Goal (one sentence)
- Acceptance criteria (specific user-visible outcomes)
- Out of scope (explicit list to prevent creep)
- Stop-and-ask conditions (when to escalate)
- Estimated scope (S/M/L by file count)

The platform runs pre-flight checks before any code dispatch:
- Pull latest master, confirm clean working dir
- Confirm no other open feature branches touch the planned files
- Run `pnpm -r build` against current master, confirm baseline
- Note typecheck error count for diff comparison

Merge-and-ship is also templated: pull master again, merge to feature branch, resolve conflicts with documentation, re-run checks, push, PR, watch deploy, smoke test, update sprint log, verify logs flowing.

### 4.3 Conflict prevention rules

Encoded as platform constraints, not guidelines:

1. **One active feature branch per project at a time.** AI Connect won't let you start Sprint N+1 if Sprint N is unmerged.
2. **Master pull before any work.** Pre-flight check fails if local master is behind origin.
3. **Master merge before any PR.** Merge-and-ship checklist won't tick "ready" until origin/master is merged into the feature branch.
4. **No parallel agentic sessions on the same project.** The dispatcher refuses to start a Claude Code run if a Cursor run is already in flight on the same project.
5. **No direct commits to master.** Hotfixes are sprints too — branched, PR'd, reviewed.
6. **Tight scope per sprint.** Sprints touching more than ~10 files trigger a "split this sprint" warning.

### 4.4 Phase 2 — Operating

Once a project ships, operating discipline kicks in:

- **Daily error log digest.** AI Connect queries `systemLogs WHERE level IN ('error','critical') AND occurredAt > now() - interval '24 hours'` and surfaces a daily triage view.
- **Deploy health monitoring.** Hourly `/health` pings; alert on red.
- **Schema migration pattern.** Migrations never auto-apply. Generated, committed, planned, reviewed, manually applied with verification queries.
- **Revert-first on production breaks.** Platform proposes the revert commit before proposing a forward fix.

---

## 5. Core concepts

The vocabulary AI Connect uses internally and externally. Each concept is a first-class object with its own table, API, and UI surface.

**Project.** A connected GitHub repo with `.mtt/` initialized. Projects own their sprints, runs, skills, and logs. A user can have many projects; a project belongs to one user (multi-user workspaces are v2).

**Provider.** An AI service (Claude, OpenAI, Groq, Gemini, Perplexity, Ollama) the user has connected with their API key. Stored encrypted. Used by the router for inference dispatches.

**Connection.** A non-AI external service (Render, Vercel, Supabase, GitHub) the user has authorized AI Connect to interact with on their behalf. Stored as encrypted OAuth tokens or API keys.

**Sprint.** A scoped unit of feature work following the MTTBuild template. Has a goal, acceptance criteria, out-of-scope list, status, branch name, owner, and estimated scope. Lives in `.mtt/state/sprint-log.json` and the AI Connect database (mirrored).

**Run.** A single agentic dispatch. Has a `run_id`, target, status (dispatched / running / awaiting-input / complete / failed), input prompt, output artifact, and full event log. Belongs to a sprint.

**Message.** A single inbox/outbox file in a project's `.mtt/` directory. The atomic unit of repo-bus communication.

**Skill.** A reusable prompt fragment + behavior pattern, scoped to project, user, or platform. Project skills live in `.mtt/skills/`. User skills live in the AI Connect database. Platform skills (MTTBuild, the GitHub sync skill, the cache-busting skill, etc.) ship with AI Connect.

**Template.** A scaffolded sprint or project shape. Examples: "New SaaS — Phase 0 standard," "Add Stripe billing to existing project," "Add audit logging to existing project." Templates produce sprint plans the user reviews and dispatches.

**Artifact.** The output of a completed run. A commit SHA, a PR URL, a diff, a deployed URL, a generated document, a test report. Stored as a reference (we don't duplicate git content).

---

## 6. Integrations

AI Connect's integrations split into three layers. Day-one scope is intentionally narrow — about a dozen integrations, not a hundred. Breadth is deferred until depth on the orchestration core is proven.

### 6.1 Inference providers (BYOAI)

Day one (Sprint 1):
- Anthropic (Claude family — Sonnet, Opus, Haiku)

Day two (Sprint 2-3):
- OpenAI
- Perplexity Sonar
- Groq
- Google Gemini

Later:
- Local Ollama
- Custom OpenAI-compatible endpoints

All keys stored encrypted with AES-256-GCM. Pattern lifted from the encrypted credential vault concept in the Matt design docs. Master key (`MASTER_KEY` env var) is server-only, 32 bytes hex.

### 6.2 Agentic targets

Day one (Sprint 4-5):
- Claude Code (via Anthropic's official MCP / SDK)
- GitHub message bus stub (Cursor and Replit AI both target this)

Later (Sprint 6+):
- Perplexity Computer (Perplexity Max API)
- OpenClaw (WebSocket to user-hosted instance)

### 6.3 Hosting and repo

Day one:
- GitHub (read repo, write `.mtt/` files, list branches, open PRs)
- Render (read service status, trigger deploys)
- Vercel (read project status, trigger deploys)

Later:
- Cloudflare Pages
- Fly.io
- Supabase (DB introspection for schema-aware sprints)

### 6.4 Auth and billing

- Auth0 (shared tenant `macrotechtitandev.us.auth0.com`, new application "AI Connect")
- Stripe (shared customer pool, new product/price line items)


---

## 7. Pricing and tiers

| Tier | Price | What's included |
|---|---|---|
| **AI Connect Free** | $0 | Self-host the open-source framework. Point it at your own infra and your own keys. Everything works locally; no hosted features. |
| **AI Connect Hosted** | $29 / month | Hosted at `aiconnect.macrotechtitan.com`. BYOAI keys (you pay providers directly). Project orchestration, GitHub message bus, sprint workflow enforcement, persistent project state, audit logs, daily digest. |
| **AI Connect Hosted + Tokens** | $49 / month | Everything in Hosted, plus ~$10 of platform-supplied Claude tokens included monthly so users can try AI Connect before bringing their own keys. Overage routes to BYOAI keys. *(Ships post-MVP.)* |
| **AI Connect Team** | $199 / month | Multi-user workspace, shared skills, role-based access, centralized billing across team members. *(v2 — post-launch.)* |

**Bundling.** Anyone subscribed to any other Macro Tech Titan product (OptimaQuant Pro, future Matt tier, etc.) gets AI Connect Hosted included. The author is the first user; dogfooding shouldn't require a separate subscription.

**Why this structure.** The framework being MIT and self-hostable is the trust signal that makes the hosted version worth paying for. Devs who never pay are still ambassadors. The $29 anchor matches the standard indie SaaS price point. The $49 included-tokens tier addresses the single biggest signup friction (getting an API key) without forcing it on power users.

---

## 8. Self-host vs hosted

**Open core.** The AI Connect framework — router, run lifecycle, message bus, methodology enforcement, base UI, all skills — is MIT-licensed. Anyone can clone this repo, run it locally or on their own infrastructure, and use it indefinitely without paying anyone.

**Proprietary hosted features.** A small set of operational features are part of the hosted product only:

- Hosted multi-tenant deployment at `aiconnect.macrotechtitan.com`
- Managed Auth0 + Stripe integration (self-hosters bring their own)
- Hosted skill marketplace (publish/discover skills with attribution + revenue share — v2)
- Platform-supplied tokens (the $49 tier)
- SLA, support, automatic upgrades

**Why open core works here.** Self-hosters reduce no revenue meaningfully — they were never going to pay $29/month for hosting they could trivially run themselves. They contribute pull requests, file useful issues, write blog posts, and convert to hosted when their team grows past the point where self-hosting is worth their time.

---

## 9. Roadmap and sprints

This section is the live build plan. Sprints are added one at a time as the previous one merges. Every sprint follows the MTTBuild sprint template (see [`docs/MTTBuild.md`](docs/MTTBuild.md) section "Sprint template").

### Sprint 0 — Phase 0 infrastructure

**Goal.** Stand up production-grade infrastructure for AI Connect at `aiconnect.macrotechtitan.com` against the MTTBuild Phase 0 checklist. Zero feature work. The deliverable is a green checklist, a deployed `/health` endpoint, the Phase 0 database schema and logging wrapper in code, an idempotent admin seed on boot, and a bearer-token-gated diagnostics endpoint.

**Acceptance criteria.**

1. **Monorepo.** pnpm workspace with `apps/api` (Express + TypeScript + Drizzle), `apps/web` (Vite + React), and `packages/shared`. `packages/shared` builds before either app in both local dev and the deploy pipelines.
2. **API live.** `https://api.aiconnect.macrotechtitan.com/health` returns 200 with structured JSON (`status`, `service`, `version`, `timestamp`). DB-free, auth-free, synchronous.
3. **Frontend live.** `https://aiconnect.macrotechtitan.com` serves the placeholder landing page over HTTPS with a valid Vercel-issued certificate.
4. **Drizzle schema.** Four tables defined in `apps/api/src/db/schema.ts`: `users`, `systemLogs`, `userAuditLogs`, `devLogs`. Includes the required indexes per MTTBuild Phase 0 (`systemLogs(occurredAt,level)`, `systemLogs(category,occurredAt)`, `userAuditLogs(userId,occurredAt)`, `userAuditLogs(action,occurredAt)`, `devLogs(source,occurredAt)`, `devLogs(category,occurredAt)`) and a `CHECK` constraint on `systemLogs.level`.
5. **Generated migration committed.** `apps/api/drizzle/0000_*.sql` exists in the repo. Schema is applied to Supabase **manually**, not via `drizzle-kit push` — never auto-applied at boot.
6. **Logging wrapper.** `apps/api/src/lib/logging.ts` exposes `logSystem(level, category, message, context?, traceId?)`, `logUserAction(userId, action, targetType?, targetId?, context?, traceId?)`, and `logDev(source, category, message, context?, traceId?)`. `logUserAction` writes to both `userAuditLogs` and `systemLogs` in a single transaction sharing a `traceId`. All three swallow errors to stderr so logging never crashes the caller.
7. **Idempotent admin seed.** `apps/api/src/lib/seed.ts` upserts `jgelet@macrotechtitan.com` as role `admin` via `ON CONFLICT (email) DO NOTHING` on every boot. Skips silently when `DATABASE_URL` is unset so dev without a DB still boots; seed failure logs to stderr but never crashes the process.
8. **Admin diagnostics endpoint.** `GET /api/admin/diagnostics` is protected by bearer-token auth against `env.DIAGNOSTICS_TOKEN` (constant-time compare). Returns `service`, `version`, `timestamp`, `node`, `uptimeSeconds`, an `env` object of **boolean** presence checks (never values), and a `db` object with `configured` + `reachable` (`SELECT 1` bounded by a 2 s ceiling). 401 on any auth failure, including when `DIAGNOSTICS_TOKEN` is unset.
9. **CLAUDE.md committed.** Full project context, layout, architecture invariants, secret-handling rules, methodology pointers, and production deployment state (service IDs, regions, env-var names, DNS records) — all in `CLAUDE.md` at the repo root.
10. **DNS configured.** Cloudflare zone `macrotechtitan.com` has `api.aiconnect` CNAME → `ai-connect-api.onrender.com` and `aiconnect` A → `76.76.21.21`. Both records are **DNS-only (grey cloud)** — Vercel and Render terminate their own TLS at the edge.
11. **Secrets hygiene.** All operational secrets (`DATABASE_URL`, `DIAGNOSTICS_TOKEN`, `MASTER_KEY`, Auth0 client ID/secret, Stripe keys) live in the Render/Vercel UIs and a password manager only — never in committed files, shell history, or the PowerShell `$PROFILE`. Any secret that appeared in chat, screenshots, or operator scratch has been rotated. `.env*` is gitignored.

**Out of scope.** No router, no chat UI, no provider integrations, no message bus, no Stripe products/prices, no JWT verification middleware, no Sentry. Just infra plus the Phase 0 database/logging plumbing.

**Stop and ask if.** Anything in the Phase 0 checklist doesn't apply cleanly to AI Connect's stack. Document the deviation in `docs/PROJECT_TEMPLATE_OVERRIDES.md`.

#### How to verify Sprint 0 acceptance

Run these from a clean checkout of `master` after Sprint 0 merges. Items 1–9 are automated; 10–11 require operator inspection.

```bash
# 1. Monorepo layout
ls apps/api apps/web packages/shared
pnpm -r build && pnpm -r typecheck

# 2. API /health returns 200 with structured JSON
curl -fsS https://api.aiconnect.macrotechtitan.com/health
# Expected: {"status":"ok","service":"ai-connect-api","version":"...","timestamp":"..."}

# 3. Frontend serves over HTTPS with valid cert
curl -fsSI https://aiconnect.macrotechtitan.com | head -1
# Expected: HTTP/2 200

# 4. Drizzle schema — four tables exist with indexes
#    Run against Supabase via psql or the SQL editor:
#      SELECT table_name FROM information_schema.tables
#       WHERE table_schema='public' ORDER BY table_name;
#    Expected rows: dev_logs, system_logs, user_audit_logs, users
#      SELECT indexname FROM pg_indexes
#       WHERE schemaname='public' AND tablename IN ('system_logs','user_audit_logs','dev_logs')
#       ORDER BY indexname;
#    Expected: the six (category|action|source|userId|occurredAt)_idx indexes from §4.

# 5. Generated migration is committed
ls apps/api/drizzle/0000_*.sql
git log --diff-filter=A --name-only -- apps/api/drizzle/

# 6. Logging wrapper exports the three functions
grep -E '^export (async )?function (logSystem|logUserAction|logDev)' apps/api/src/lib/logging.ts

# 7. Admin user seeded
#    SELECT email, role FROM users WHERE email = 'jgelet@macrotechtitan.com';
#    Expected: one row with role='admin'.

# 8. Diagnostics endpoint — token gate works and response shape is correct
curl -fsS -o /dev/null -w '%{http_code}\n' https://api.aiconnect.macrotechtitan.com/api/admin/diagnostics
# Expected: 401
curl -fsS -H "Authorization: Bearer $DIAGNOSTICS_TOKEN" \
  https://api.aiconnect.macrotechtitan.com/api/admin/diagnostics | jq .
# Expected: service/version/timestamp/node/uptimeSeconds/env/db keys present;
# every value under .env is a boolean; .db.reachable is true.

# 9. CLAUDE.md present and non-trivial
test -f CLAUDE.md && wc -l CLAUDE.md
```

```text
# 10. DNS — DNS-only (grey cloud) at Cloudflare
dig +short api.aiconnect.macrotechtitan.com   # → ai-connect-api.onrender.com → an IP
dig +short aiconnect.macrotechtitan.com       # → 76.76.21.21
# Confirm in the Cloudflare dashboard that both records show a grey cloud
# icon (proxy off). Proxied (orange) breaks Vercel/Render edge TLS.

# 11. Secrets hygiene (manual operator checks)
# - Search shell history and PowerShell $PROFILE for any secret literals; rotate if found.
# - Verify .env* is gitignored: git check-ignore .env
# - Confirm Render and Vercel env var lists match CLAUDE.md "Production deployment state"
#   and that no secret values are referenced inline in render.yaml or vercel.json.
```

### Sprint 1 — Auth, identity, single-page shell

**Goal.** A logged-in user lands on `aiconnect.macrotechtitan.com`, sees an empty dashboard, and is recognized by the API server.

**Acceptance criteria.**
- Auth0 SPA SDK wired into the frontend
- Login → Auth0 → callback → token in memory → API call with bearer token → `users.last_seen_at` updated
- API server validates JWTs against the Auth0 JWKS for the AI Connect API audience
- Empty dashboard renders user's email and a "no projects yet" empty state
- Logout works
- All auth events logged via `logUserAction()`

**Out of scope.** Provider connections, project creation, chat UI.

### Sprint 2 — BYOAI provider connections (Claude only)

**Goal.** A user can add their Anthropic API key, AI Connect stores it encrypted, and a "Test connection" button successfully calls Claude and returns a "Hello from Claude" response.

**Acceptance criteria.**
- `providers` table with encrypted-key column (AES-256-GCM, `MASTER_KEY` env var)
- Settings page UI: add/edit/remove Anthropic provider
- Test endpoint that decrypts, calls `https://api.anthropic.com/v1/messages`, logs the call to `systemLogs`, returns success/failure
- Encrypted key never leaves the API server; never returned to the frontend
- Audit log entry per add/remove/test action

**Out of scope.** Other providers, chat UI, routing logic.

### Sprint 3 — Project creation and `.mtt/` initialization

**Goal.** A user connects a GitHub repo, AI Connect commits `.mtt/` directory with initial state files, and the project appears on the dashboard.

**Acceptance criteria.**
- GitHub OAuth connection flow
- "New project" wizard: pick a repo, run Phase 0 audit (read-only — surface findings, don't fix), commit `.mtt/state/phase-0-checklist.json` + `.mtt/state/sprint-log.json` (empty)
- Project appears on dashboard with Phase 0 status badge
- `projects` table populated

**Out of scope.** Sprint creation, run dispatch, chat.

### Sprint 4 — Chat UI + Claude inference dispatch

**Goal.** A user opens a project, types a message, AI Connect routes to Claude, response streams back. Inference path only — no agentic dispatch yet.

**Acceptance criteria.**
- Chat interface in project view
- Messages persisted to `messages` table
- Router classifies message → "inference / Claude" (no real classification yet, hardcode to Claude)
- Claude API call streams response token-by-token to UI
- All exchanges logged

**Out of scope.** Agentic dispatch, multi-provider routing, sprint creation from chat.

### Sprints 5+

To be planned as Sprint 4 merges. Likely candidates:

- **Sprint 5** — Sprint creation from chat. User says "let's plan a sprint to add Stripe to OQ"; AI Connect drafts the sprint template, commits to `.mtt/state/`.
- **Sprint 6** — GitHub message bus stub. Inbox/outbox files; manual pickup (no daemon yet) so we can verify the round trip.
- **Sprint 7** — Replit polling daemon. The 100-second poller, written as a reusable script that drops into any Replit project.
- **Sprint 8** — Multi-provider routing. OpenAI, Perplexity, Groq, Gemini all addable; router picks based on task classification.
- **Sprint 9** — Claude Code MCP integration. First true agentic dispatch with run lifecycle.
- **Sprint 10** — Stripe billing wiring. Subscribe to AI Connect Hosted, Auth0 token reflects subscription state.

Beyond Sprint 10 is genuinely unknown. The roadmap evolves as the platform meets real use.

---

## 10. Contributing

AI Connect is open core. Contributions are welcome on the framework. The hosted product (billing, marketplace, support) is operated by Macro Tech Titan and not part of community contributions.

**How to contribute a skill.** Skills are markdown files with a defined frontmatter shape. Open a PR adding your skill to `skills/community/`. Skills go through review for quality, safety (no copyright violations, no prompt injection vectors, no data exfiltration), and alignment with the methodology.

**How to contribute code.** Standard fork-and-PR. Read [`docs/MTTBuild.md`](docs/MTTBuild.md) before opening any PR — your contribution should follow the same sprint discipline AI Connect enforces on its users.

**What we won't accept.** Pull requests that break the open-core boundary by importing proprietary hosted features. Pull requests that bypass the methodology (no skipping Phase 0, no parallel sprints, no direct-to-master). Pull requests that add provider integrations without the encrypted-credential pattern.

**Code of conduct.** Be helpful, be honest, be respectful, be specific. Standard open-source norms apply.

---

## 11. Status and changelog

**Current status.** Pre-Sprint-0. Repo seeded with this README. Phase 0 infrastructure not yet stood up.

**Changelog.**

*(Empty until Sprint 0 ships.)*

---

*This README is the project specification. It evolves with each sprint. When architecture changes, the README changes first; code follows.*

*Last updated: May 5, 2026.*
