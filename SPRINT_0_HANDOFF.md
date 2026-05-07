# Sprint 0 — Handoff to a Fresh Claude Conversation

This document gives you the exact text to paste into a fresh Claude conversation to begin Sprint 0 of AI Connect. Two versions:

- **[Short version](#short-version)** — copy/paste, fits in one message, Claude pulls the rest from GitHub
- **[Long version](#long-version)** — more context up front if you want to skip the initial round-trip where Claude reads the repo

Either works. The short version is recommended unless you specifically want the long context loaded immediately.

---

## Short version

```
Hi Claude. I'm starting Sprint 0 of a project called AI Connect.

The full project specification, methodology, and Sprint 0 acceptance criteria are in the public GitHub repo:

https://github.com/MacroTechTitan/AI-Connect

Please web-fetch:
1. The README at https://github.com/MacroTechTitan/AI-Connect/blob/master/README.md — read it in full, especially Section 9 (the Sprint 0 plan) and Section 1 (the design intent)
2. The MTTBuild methodology at https://github.com/MacroTechTitan/AI-Connect/blob/master/docs/MTTBuild.md — Sprint 0 follows the sprint template defined there
3. FEATURES.md at https://github.com/MacroTechTitan/AI-Connect/blob/master/FEATURES.md — capability inventory, current status

Context you should know:

- I'm Joseph Gelet, founder of Macro Tech Titan. AI Connect is the unified orchestration layer for AI-assisted development I'm building, partly to fix my own pain on OptimaQuant and partly as a product to ship.
- The repo seed (README, methodology, platform skills, templates) is already on GitHub on the master branch. We just bootstrapped it. Sprint 0 has not started.
- I'm on Windows 11 with Cursor + Git Bash + Node.js + GitHub CLI installed locally. My local working copy is at ~/code/AI-Connect.
- My infrastructure preferences (per the README): Render for the API server, Vercel for the frontend, Supabase for Postgres, Auth0 for auth (shared tenant macrotechtitandev.us.auth0.com — I'm admin, will create a new application called "AI Connect" in that tenant), Stripe for billing.
- The domain is aiconnect.macrotechtitan.com (frontend on Vercel) and api.aiconnect.macrotechtitan.com (API on Render).
- I prefer to do work through Cursor's chat or step-by-step instructions for the GitHub/Render/Vercel/Auth0/Supabase web UIs, not raw shell commands when avoidable. I'll use the terminal when I have to.

Please:
1. Read the three documents linked above
2. Confirm you understand the Sprint 0 acceptance criteria
3. Break Sprint 0 down into discrete tasks, ordered by dependency (e.g., Supabase before Render, Render before logging-tables-migration, etc.)
4. For each task, tell me whether it's a web-UI task (and which UI), a Cursor coding task, or a terminal task
5. We'll work the list one task at a time. Do not start the first task in the same response as the breakdown — wait for me to confirm the plan first.

Sprint 0 ends when the README's Sprint 0 acceptance criteria are all green-checked and a /health endpoint is publicly responding 200 at api.aiconnect.macrotechtitan.com.
```

## Long version

Use this if you want Claude to start with more context loaded without needing to web-fetch as a first step. It's longer but front-loads everything.

```
Hi Claude. I'm starting Sprint 0 of a project called AI Connect — the unified orchestration layer for AI-assisted development. Public repo: https://github.com/MacroTechTitan/AI-Connect (master branch).

Background

AI Connect is a single chat interface that routes prompts to the right AI tool (Claude for planning, Claude Code or Cursor for execution, Perplexity for research, Perplexity Computer or OpenClaw for long-running agentic tasks, local Ollama for offline work) and enforces the MTTBuild methodology as platform behavior — Phase 0 infrastructure first, sprint workflow with conflict prevention, audit logging, no parallel branches, no direct commits to master.

The product distinguishes "inference targets" (sync API calls — Claude, OpenAI, Perplexity Sonar, Groq, Gemini, Ollama) from "agentic targets" (async run lifecycle — Claude Code, Cursor, Replit AI, Perplexity Computer, OpenClaw). Agentic targets that don't expose programmatic dispatch APIs (Cursor, Replit) use a GitHub-based message bus: AI Connect writes prompts to .mtt/inbox/ in the user's repo, daemons on the agentic side poll every 100 seconds, replies land in .mtt/outbox/.

The product is open core: the framework is MIT-licensed and self-hostable; the hosted product at aiconnect.macrotechtitan.com is paid ($29/month BYOAI, $49/month with included Claude tokens shipping post-MVP, $199/month Team tier in v2). Existing Macro Tech Titan subscribers (e.g., OptimaQuant Pro at $99) get AI Connect Hosted bundled.

Heritage

There's a separate parked product called Matt (formerly OmniLang) at MacroTechTitan/OmniLang. It's a Replit-style IDE that generates and deploys apps from prompts. AI Connect and Matt are architecturally distinct — AI Connect orchestrates *across* AI dev tools; Matt *is* an AI dev tool. They'll eventually both live under the broader MTT AI umbrella but are built independently. Disregard Matt for AI Connect's build; treat it as future context only.

The relevant inheritance from existing Macro Tech Titan work is operational: the Auth0 tenant macrotechtitandev.us.auth0.com is shared with OptimaQuant and other MTT products, and Stripe billing is shared at the customer-pool level. AI Connect creates new Application + new API audience inside that existing Auth0 tenant; reuses the Stripe customer pool with new product/price line items.

What's done so far

- Repo created at MacroTechTitan/AI-Connect (public, MIT)
- 528-line README committed with full project specification, architecture, methodology embedding, sprint roadmap, pricing, contributing guide
- docs/MTTBuild.md committed (the methodology AI Connect enforces)
- docs/PROJECT_TEMPLATE_OVERRIDES.md committed (placeholder, no overrides yet)
- docs/sprints/SPRINT_LOG.md committed (empty, awaiting Sprint 0)
- skills/platform/ committed with 4 platform skills (BYOAI router pattern, GitHub sync force-pull patterns, Vercel + Vite cache busting, Replit deployment fix reference)
- FEATURES.md committed (capability inventory, all marked Planned pending Sprint 0+)
- .github/ templates for PRs and issues committed
- Branch is master (per MTTBuild convention, not main)
- Default branch and branch protection rules configured on GitHub
- Local working copy at ~/code/AI-Connect on my Windows 11 machine
- Cursor + Git Bash + Node.js + GitHub CLI installed and verified

What's not done — that's Sprint 0

Sprint 0 is Phase 0 infrastructure for AI Connect itself. Per the README's Section 9, Sprint 0's acceptance criteria are:

- New Vercel project deployed at aiconnect.macrotechtitan.com serving a placeholder landing page
- New Render web service deployed at api.aiconnect.macrotechtitan.com serving /health returning 200, no auth, no DB dependency
- Render API server bound to 0.0.0.0 explicitly, environment variables loaded from Render env
- Supabase Postgres provisioned, IPv4-compatible session pooler connection string configured
- Stripe env vars set in test mode: STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET
- Auth0 application "AI Connect" created in macrotechtitandev tenant, callback URLs for aiconnect.macrotechtitan.com and localhost:5173
- Auth0 API "AI Connect API" created with audience https://api.aiconnect.macrotechtitan.com
- systemLogs, userAuditLogs, devLogs tables migrated, indexes created per MTTBuild spec
- Logging wrapper lib/logging.ts exposes logSystem, logUserAction, logDev
- users table migrated, admin user (jgelet@macrotechtitan.com) seeded idempotently
- GitHub repo connected to Render and Vercel for auto-deploy on push to master
- docs/MTTBuild.md, docs/PROJECT_TEMPLATE_OVERRIDES.md, docs/sprints/SPRINT_LOG.md committed (already done)

Out of scope for Sprint 0: chat UI, router, provider integrations, message bus, Stripe products/prices. Those are Sprints 1-10.

My environment and preferences

- Windows 11, Cursor IDE, Git Bash terminal, Node 22 LTS, gh CLI authenticated to MacroTechTitan org with admin:org scope
- Local repo cloned at ~/code/AI-Connect, master branch
- I prefer step-by-step instructions for web UIs (GitHub, Render, Vercel, Auth0, Supabase, Stripe) over raw curl/API calls
- I prefer Cursor-driven coding tasks over hand-coding when both are options
- I will use the terminal for git operations and one-off scripts but prefer not to live there

What I need from you in this conversation

1. Confirm you've absorbed the context above and the README's Sprint 0 plan
2. Break Sprint 0 into a dependency-ordered task list — Supabase before Render (Render needs DATABASE_URL), Render before logging migration (migration runs against the deployed DB), etc.
3. For each task, label it: web-UI (and which platform), Cursor (and what to ask Cursor to do), or terminal (and what command)
4. Confirm we're not violating any MTTBuild discipline before kicking off
5. Wait for me to approve the plan before starting task #1

Sprint 0 is done when all the README acceptance criteria are green and api.aiconnect.macrotechtitan.com/health returns 200 publicly.

Let's begin with the plan.
```

---

## How to use this

1. Open a fresh Claude conversation (claude.ai)
2. Pick the short version or long version above
3. Copy the entire code block (including the backticks-bounded text)
4. Paste into the new conversation and send

Claude will fetch the repo, read the README and methodology, propose a Sprint 0 task list, and wait for your approval. You then work the list one task at a time.

## Why two versions

**Short version (recommended)** is faster to copy/paste and forces Claude to actually read the repo, which is the right behavior — Claude should always be reading from the source of truth, not relying on what was pasted into the chat.

**Long version** is useful if Claude's web_fetch is being slow or rate-limited, or if you want to pre-load context to skip the initial round-trip. It also serves as a backup if the repo is ever temporarily unreachable.

Both versions tell Claude to wait for your approval before starting Sprint 0 task #1. That's the MTTBuild discipline applied to handoffs as well as to sprints — plan first, get sign-off, then execute.

---

*This handoff document lives at the root of the repo as `SPRINT_0_HANDOFF.md`. Future sprints will get their own handoff documents in `docs/handoffs/sprint-N-handoff.md` as needed.*
