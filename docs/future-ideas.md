# Future ideas

Items recorded here are not roadmap commitments. They are concepts to revisit during sprint planning. Most will be irrelevant or obvious by the time we reach them; the surviving ones become real sprints.

Updated as ideas land. Reviewed before each sprint planning session.

## Anchored concepts (architectural implications today)

These are not just ideas — they're commitments that constrain architecture decisions now even though implementation comes later. Cross-referenced in `docs/PROJECT_TEMPLATE_OVERRIDES.md` under "Architectural commitments (Sprint 0.5)".

### Project Genesis (target: Sprint 8-10)

The flagship workflow: "user signs up → AI Connect provisions Vercel + Render + Supabase + Auth0 + DNS + monorepo scaffold + working /health in ~10 minutes." Automates the Sprint 0 work we just did manually for AI Connect itself.

**Architectural implication now:** by Sprint 3, the `projects` table models the platform-side state of any project AI Connect manages (Render service IDs, Vercel project IDs, Supabase refs, Auth0 tenants, DNS records).

### Multi-project portfolio per organization (target: Sprint 4-5)

Users have multiple projects (AI Connect, OptimaQuant, Matt, MTT-Ads). Organizations have multiple users + multiple projects. Sprint history, infrastructure, and AI usage all tracked per project.

**Architectural implication now:** the multi-tenant data model is `organizations → projects → users → (sprints, audit logs, AI usage)`. Not flat `organizations → users`.

### Cost-aware AI routing (target: Sprint 6-8)

Two flavors: static (user-configured rules per task type) and dynamic (platform escalates from cheap to expensive based on budget + task success). Real customer pain — heavy AI use produces real bills.

**Architectural implication now:** Sprint 2's BYOAI abstraction captures cost-per-call (tokens × provider rate) as first-class data on every AI call. Retrofitting cost tracking is expensive.

## Anchored concepts: distribution channels

These concepts shape AI Connect's distribution and onboarding strategy. Implementation comes later but architectural implications start now.

### Signup wizard with A/B flow (target: Sprint 5-6)

First-touch UX for a new user. Two branches:

**A. Start a new dev project.** AI Connect provisions the project from scratch — Vercel + Render + Supabase + Auth0 + DNS + monorepo scaffold + working /health endpoint. This is the user-facing manifestation of the Project Genesis concept (already documented above).

**B. Take over an existing project.** AI Connect connects to infrastructure the user already has. Different problem from A: discovery, introspection, mapping their existing setup into AI Connect's project data model. Likely higher-value in the near term because it has no chicken-and-egg problem — existing developers with existing projects are the natural first users.

Both branches need the platform-choice step (see below).

**Architectural implication now:** the `projects` table (Sprint 3-4 anchored concept) must be flexible enough to model both "AI Connect-provisioned project" (path A) and "external project I connect into" (path B). A connection is metadata about how AI Connect reaches the project, not what AI Connect owns.

### Path B takeover — supported source platforms

Path B's "take over an existing project" flow targets developers who used AI-builder or AI-assisted tools to move fast on a prototype, hit the "okay but it's a mess" wall, and want to turn the prototype into something production-grade with discipline going forward.

This is one of AI Connect's most concentrated audiences by intent: they already use AI in development, they already feel methodology pain, they're already actively shopping for solutions.

Path A and Path B are both core to the wizard. Neither is prioritized over the other — different users arrive with different starting points and both deserve a clean onboarding flow.

**Primary supported source platforms** (validated through founder use, prioritized for first implementation):

1. **Replit projects.** Replit projects often start fast, accumulate garbled code, partial features, and unclear deployment status. AI Connect takeover flow: clone the Replit, analyze the code, propose migration to AI Connect's stack (Vercel + Render + Supabase or equivalent), apply MTTBuild methodology going forward, rescue working features, audit-log every fix.

2. **Lovable projects.** Lovable generates React frontends; users often have a working UI but no real backend or unclear deployment. AI Connect takeover: ingest the Lovable repo, add proper backend infrastructure, deploy cleanly, apply methodology.

3. **Open Claw projects.** Same pattern, different source generator.

4. **Generic GitHub repo.** Catch-all for projects from any source. Likely the eventual fallback once we understand what patterns repeat across specific platforms.

**Honorable mentions** (not yet validated through founder use, deferred until either signal or validation):

Bolt, v0, Cursor projects, Claude Artifacts, Cline, Aider, Continue, Codeium, and similar AI-assisted dev tools. Each is a potential source platform but none have been validated through firsthand use. Added to AI Connect as supported sources when signal emerges from users requesting them.

**Architectural implications now:**

- Project ingestion needs a clean abstraction. The core flow: "Take a repo URL, produce an AI Connect project record + analysis of what is there + migration plan."
- The Sprint 4-5 `projects` table should accommodate `imported_from` metadata: source platform, original URL, ingestion date, original state at ingestion time.
- Code-analysis tooling becomes a first-class capability. AI Connect must read code, identify framework, dependencies, deployment setup, and propose changes. This was implicit in MTTBuild already; takeover makes it explicit and core.
- The migration step (e.g., Replit → AI Connect stack) is itself a methodology-enforced sprint. Sprint 0 of every takeover project = ingestion + analysis + plan. Sprint 1 = first deploy + audit baseline. This creates a natural revenue model: charge for the takeover engagement, then for ongoing usage.

### Platform support strategy (target: Sprint 5-6, ships with the wizard)

The wizard's platform-choice step lets the user declare what they're building on:

1. **Custom build** (Vercel + Render + Supabase, the AI Connect template — Path A's default)
2. **WordPress** (existing or new WP site, via the AI Connect WordPress Plugin — see below)
3. **Other CMS/framework** (placeholder for future support; not in initial scope)

WordPress is the second platform AI Connect commits to formally because it has the largest installed base of solo-developer-managed sites worldwide and the lowest auth/infra friction compared to bespoke setups. It's another channel into AI Connect's actual audience: developers and small teams.

Joomla, Drupal, Ghost, Webflow, and similar are explicitly out of initial scope. Not because they don't matter, but because the WordPress plugin pattern should be validated before extending to other CMSes.

### WordPress plugin channel (target: Sprint 10-12, with architectural implications starting Sprint 4-5)

**AI Connect for WordPress** — a plugin published to the WordPress plugin directory that gives developers a controlled bridge between AI Connect and any WordPress site they're building or maintaining.

**Audience:** solo developers, freelancers, and small agencies who build WordPress sites for clients. Estimated 200-500K worldwide. Not WordPress end-users; the developers who own and maintain WordPress sites professionally.

**Positioning:** "We build the rails, devs build the apps." The plugin is a connector and bridge, not a productized AI feature. AI Connect provides the infrastructure and APIs; developers compose them into whatever they need for their sites and clients.

**First-shipping capabilities:**
- Authenticated bridge: developer connects their AI Connect account to a WP site they manage. OAuth-style flow initiated from WP admin.
- Read and write WordPress content (posts, pages, custom post types) via WordPress REST API, proxied through AI Connect's connector layer.
- AI chat widget embeddable on the WP site, configurable in WP admin, scoped to topics the developer defines.
- Automated content creation routed through the developer's configured AI providers.
- Social media posting and content scheduling, executed by AI Connect's scheduling system.
- Extension points for developers to build custom AI features on top of the connector layer (see SDK note below).

**Strategic decision: AI Connect SDK and app marketplace (target: Sprint 15-18)**

Long-term direction is real, not metaphorical. AI Connect will eventually have:
- An SDK for developers to build their own AI Connect apps on top of the connector layer
- A marketplace where those apps can be listed and discovered (similar to Slack apps, Zapier apps, Notion blocks)
- A revenue share model for marketplace authors

This commits AI Connect to a platform-for-platforms architecture. Not implemented out of the gate — the SDK ships when there is enough user demand and platform usage to justify it (likely Sprint 15-18). However, Sprint 6-10 architecture decisions should anticipate this future: the connector layer needs an extensible interface, audit logging needs app-scoped attribution, cost-aware AI routing needs per-app cost tracking.

**Revenue model for WordPress plugin users:** deferred to when first paying user signs up. Initial direction is free + paid features (basic capabilities free, advanced capabilities paid). The exact pricing — per-site, per-seat, metered usage, or freemium with tiered features — gets decided based on what early users actually want to pay for. Whatever is easiest at the time, validated against signal.

**Architectural implications now:**
- Sprint 4-5 multi-project portfolio model must scale to the "developer with 30 client WP sites" use case. The `projects` table needs to handle dozens of connections per organization without performance issues.
- Sprint 6 connector layer architecture should anticipate a WordPress plugin as the first non-AI connector. Pattern: AI Connect orchestrates → external system (WordPress site, eventually Drupal, Ghost, etc.).
- Sprint 6-10 should design APIs with the future SDK in mind, even if the SDK itself isn't built yet. Specifically: every API surface that the WP plugin uses internally should be conceptualized as "what would a third-party dev's app also need to use this for?"
- Authentication for the WP plugin must work cleanly alongside Auth0 (the WP site's plugin doesn't go through Auth0 — it presents an AI-Connect-issued API key or OAuth token that the developer obtains from their AI Connect account).

## Unsorted ideas

These don't have architectural implications today. They're parked here for future sprint planning.

### Higher-confidence near-term

- **Spec → implementation flow.** User writes a spec in markdown. Platform breaks it into tasks, routes each to the right AI, tracks completion, generates the PR.
- **Auto-generated PR descriptions with risk assessment.** Every commit Claude Code finishes gets an auto-generated PR description with risk level + reviewer suggestions.
- **Trading strategy integration (OQ-specific dogfood).** AI Connect runs MTTBuild on OQ. ClaudeCoon strategy iterations go through Sprint structure. Backtest results auto-logged as devLogs.

### Mid-term, mid-confidence

- **Voice + transcription mode.** Talk to AI Connect via Whisper, route prompts by intent. "While driving/walking" use case.
- **Live inline pair programming.** Cursor-style continuous suggestions, but in the AI Connect framework with audit trails + methodology enforcement.
- **Project graph visualization.** Visualize project dependencies — "AI Connect Sprint 6 unblocks OQ MCP integration."

### Long-term / speculative

- **Marketplace for MTTBuild platform skills.** Other developers publish skill bundles (Django-Postgres-Stripe, etc.). Revenue share on listings.
- **Team observability dashboard.** For 10-50 person teams: org-wide "AI-assisted work this week" visibility.
- **On-prem deployment kit.** Containerized AI Connect for regulated/enterprise customers (Shield AI connection, gov procurement).
- **AI tool selector based on task semantics.** Platform auto-picks the right AI based on prompt content, not user choice.

## Rejected / out of scope (named so they don't come back)

- **AI Connect as a hosted IDE.** Reproducing Cursor/VS Code is multi-year work with no defensibility. AI Connect integrates with IDEs, not becomes one.
- **General-purpose chat assistant.** Don't be ChatGPT-with-better-UI. Stay focused on AI-assisted development.
- **Mobile app.** Solo devs and small teams work on laptops/desktops. Wasted effort until >1000 paying users explicitly ask for it.

---

*Last updated: 2026-05-26*
