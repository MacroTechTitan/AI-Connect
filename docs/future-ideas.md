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

### Project memory layer (target: Sprint 5-6 expansion of takeover flow)

The takeover flow (Path B of the signup wizard) ingests source code from Replit, Lovable, GitHub, and similar sources. The next layer is **project memory** — beyond just code, AI Connect ingests every artifact relevant to a project so users can resume work after long gaps without remembering context.

Ingested artifact types:
- Code (repo contents, already in takeover scope)
- Documents (Word docs, PDFs, markdown, plain text notes)
- Configuration (env vars, deployment configs, infrastructure descriptions)
- Connection metadata (which Supabase project, Render service, Stripe account, Auth0 tenant)
- External context (Notion pages, Google Docs URLs, Slack threads, email exports)
- History (old chat exports, screenshots, voice memos)

AI Connect's value-add: synthesizing across these artifacts. When a user returns to a project after weeks or months, AI Connect should be able to answer questions like "what was I working on last?", "what's the current state of the Render deploy?", "was there an outstanding bug I noted somewhere?", "what did I tell my client we'd ship next?", "did I ever decide between approach A and approach B?"

Architecture: standard RAG pattern (object storage for files, vector embeddings for content, metadata index for filtering, synthesis layer via AI Connect's existing AI routing).

Why it matters: developers and teams with multiple active projects struggle to maintain context across them. A solo developer juggling several projects, an agency managing client work, a small team running multiple products — all face the same problem of "what was I doing on project X six weeks ago?" AI Connect's project memory turns scattered artifacts into queryable context, so projects that haven't been touched recently can be picked up without the mental tax of reconstructing where things stood. Methodology discipline depends on this — without continuous context, methodology gets skipped because users skip the steps they can't remember why they set up.

Architectural implications now:
- Object storage choice for files: Cloudflare R2 preferred (S3-compatible, no AWS lock-in, generous free tier).
- The `projects` table from Sprint 3-4 must accommodate file attachments — either a `project_files` join table or a separate `artifacts` table tied to projects.
- Vector storage choice: defer until Sprint 5-6 when actual volume is known. Initial pattern: pgvector extension on Supabase Postgres (no separate vector DB needed, fits the self-hosting story).

### Scope of Work template + 20-question wizard (target: Sprint 4-5, part of signup wizard)

Every AI Connect project starts with a SOW.md (Scope of Work) document. Two ways to fill it in:

**A. Static template.** User fills in a structured markdown file with sections like project pitch, target audience, success criteria, out-of-scope, architecture, risks, dependencies, initial sprint structure. Auto-generated stub when a project is created.

**B. 20-question wizard.** AI Connect walks the user through structured questions. The answers assemble the SOW.md plus initial README.md plus initial task list (broken into Sprint 0/1/2 scope) plus a risk register.

Why this matters: half of dev-project failures come from skipping the question "what is this for and why?" at the start. AI Connect making this discipline the default — and integrating the SOW with methodology enforcement — turns a generic template into a real methodology product. A strong foundation document at the start saves rework, conflict, and scope creep throughout the entire project lifecycle.

The wizard's questions cover, in rough order: project name, one-sentence pitch, target user, problem solved, success metric, MVP scope, out-of-scope, budget/timeline, stack preference, integrations needed, deployment model (self-hosted vs cloud vs either), multi-tenancy, data sensitivity, stakeholders, risk of failure, level of investment, prior similar projects, existing competitors to learn from, definition of done.

Integration with existing AI Connect features:
- The SOW becomes part of the project memory layer (ingested and retrievable)
- The out-of-scope list gets enforced by methodology — if Claude Code starts building something declared out of scope, AI Connect warns the user
- Audit log connects every commit to which SOW section it serves
- The task list becomes a real backlog with priorities and dependencies tracked across sprints

Equally applicable to both wizard paths:
- Path A (new project): SOW filled in before any infrastructure is provisioned
- Path B (takeover): user fills in SOW about the existing project. Useful for documenting what was intended even if the project's original SOW was never written. Especially valuable for AI-builder projects (Replit/Lovable/Open Claw) that typically have no documentation.

Both individuals and teams benefit. A solo developer using SOW discipline avoids the chronic "what was I trying to build" drift that derails personal projects. A team using SOW discipline gets shared alignment on scope, priorities, and exclusion boundaries before code is written — which is where most team conflict on projects actually originates.

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

### Sprint 4 follow-ups (target: Sprint 4.5 / housekeeping)

Issues identified during Sprint 4 build worth tracking:

- Process-crash safety: orchestrator runs as a detached promise (Decision A1). If the Render API process dies mid-genesis, the project's provisioning_state will be stuck at 'provisioning' indefinitely. Sprint 6+ should introduce a real job queue (BullMQ + Redis, or pg-boss). For now, document a manual recovery query: UPDATE projects SET provisioning_state = 'failed' WHERE provisioning_state = 'provisioning' AND id NOT IN (SELECT DISTINCT project_id FROM project_provisioning_events WHERE created_at > now() - interval '30 minutes').

- Resource cleanup gap: when a user removes a project from the UI (DELETE /api/projects/:id), AI Connect only deletes the DB row. The provisioned cloud resources (GitHub repo, Vercel project, Render service, Supabase project) are NOT cleaned up. Sprint 5 should add a "delete all provisioned resources" option, or change DELETE to do that by default with a confirmation step.

- LISTEN/NOTIFY for SSE: the SSE endpoint polls the DB every 1 second. This is fine at Sprint 4's scale but won't scale to 100+ concurrent genesis runs. Sprint 6+ should move to Postgres LISTEN/NOTIFY for push-based event streaming.

- Template scaffolding: the GenesisContext has a templateRepoUrl field that's currently unused (Sprint 4 creates an empty repo via auto_init). Sprint 5 should add template selection (Next.js, SvelteKit, plain HTML/JS) and have the GitHub step initialize from the chosen template.

- DNS + Auth0 + Stripe automation: Sprint 4's wire_github_to_render and inject_env_vars steps are no-op placeholders. Sprint 5 (DNS), Sprint 6 (Auth0 tenant), and Sprint 9 (Stripe Connect) will fill them in.

- Org-owned platform credentials: same XOR refactor pending for provider_keys. Sprint 4-5 should add organization_id as the alternative to user_id on both tables, with a CHECK constraint that exactly one is set.

- Identity persistence: PlatformCredentialsPanel UI shows the validated identity (e.g., "as joegelet" for GitHub) only on the credential row freshly added during the session. After a page refresh, this disappears. Sprint 5 should persist identity_json (jsonb) on platform_credentials so GET responses include it.

- Validate-key-on-add for AI providers: still deferred from Sprint 2.5 — when users add an Anthropic/OpenAI key in /api/keys, we should fire a tiny test call before storing to catch deprecated-model or bad-token errors at registration time, matching what Sprint 4 does for platform credentials.

### Sprint 5 follow-ups (target: Sprint 5.5 / Sprint 6+)

- Supabase quota_exceeded UX: when a user has 2 active Supabase free-tier projects and tries to provision a 3rd, surface a helpful UI message explaining the cap + their options (upgrade to Pro, delete an existing project, switch Supabase orgs). Issue captured in Sprint 5 planning.
- Supabase paused-project detection: free-tier projects auto-pause after 7 days of inactivity. AI Connect should detect this when interacting with a project and surface "click to unpause" in the UI. Issue captured in Sprint 5 planning.
- Multi-org Supabase selection: validate() returns the first org from the PAT's list. Users with multiple Supabase orgs should be able to pick which to provision into. Workaround for Sprint 5: create a dedicated AI Connect Supabase org.
- Multi-account Supabase (Sprint 7-8): let users register multiple Supabase PATs and pick per-project. Architecturally significant — touches credentials model, provisioning UI, project creation flow.
- Cloudflare token rotation reminder: the Cloudflare API token has no expiration. AI Connect operators should rotate it periodically. No code change, just operational discipline.
- Resource cleanup on project DELETE: still deferred from Sprint 4. AI Connect's DELETE /api/projects/:id only removes the DB row; cloud resources (now including Cloudflare CNAME and Vault secret) remain. Add an opt-in "delete all" flow.
- Render env var rollback edge case: if injectEnvVars fails AFTER successfully writing some vars, the soft-failure pattern relies on create_render_service rollback to delete the service entirely. If the service deletion also fails, those env vars stay orphan. Low impact (Render service exists, env vars are cosmetic).
- Custom user domains: Sprint 5 ships shared AI Connect domain only. Users wanting their own domain need to manually wire DNS post-provision. Sprint 6+ should support "use my own domain" with a CNAME-from-user's-DNS pattern.
- Vault secret cleanup: Sprint 5's database_connection_string_vault_id references a Vault secret that becomes orphan after project DELETE. Not a correctness issue but Vault grows over time.
- DNS propagation delays: Sprint 5 doesn't wait for DNS to actually propagate before declaring success. Most users will hit the subdomain within minutes of provisioning. Could add a final "verify DNS resolves" step after wire_github_to_render for paranoid completeness.

## Rejected / out of scope (named so they don't come back)

- **AI Connect as a hosted IDE.** Reproducing Cursor/VS Code is multi-year work with no defensibility. AI Connect integrates with IDEs, not becomes one.
- **General-purpose chat assistant.** Don't be ChatGPT-with-better-UI. Stay focused on AI-assisted development.
- **Mobile app.** Solo devs and small teams work on laptops/desktops. Wasted effort until >1000 paying users explicitly ask for it.

## AI-to-AI Coordination

### AI-to-AI Coordination — the unix pipe for AI tools (target: Sprint 8-12)

The founder's observation: "For coding/building and for using OpenClaw, there can be hundreds of copy-pastes until we get to the bottom of something." The human is currently the literal bottleneck transporting text between AIs that should be talking directly. Each manual copy-paste slows down, loses context (selective trimming), introduces errors, and wastes attention on routing instead of decisions.

AI Connect could be the orchestration layer that eliminates this.

### Three real use cases (all observed in active workflows)

**Use Case A: Long sprint with limited human involvement.** Like the Sprint 4/5/5.5/5.6/5.7 arc of building AI Connect itself. Claude.ai produces plans, Claude Code executes commits, the human reviews. Today: the human copies each plan from Claude.ai and pastes to Claude Code, then copies the result back to Claude.ai for review. Future: Claude.ai writes prompts directly into Claude Code's queue; Claude Code's results route directly back to Claude.ai. Human reviews at decision points only, not every transit.

**Use Case B: OpenClaw setup (operating-other-app workflows).** The founder is concurrently configuring OpenClaw (or similar tool) for another project. Hundreds of small instructions back and forth between AI and tool until the configuration is right. Each iteration is mostly mechanical. Future: AI Connect routes the AI's instructions to OpenClaw's API/MCP/whatever, gets results back, decides if another iteration is needed — without human transit.

**Use Case C: Multi-AI debugging.** A bug appears in Project Genesis. Render logs, Supabase state, Cloudflare DNS records, the orchestrator's events — diagnosing requires looking at all of them. Today: human aggregates context from each service, prompts AI to think, repeats. Future: AI Connect orchestrates the lookup itself — Render MCP for logs, Supabase MCP for state, Cloudflare API for DNS — passes the aggregated context to Claude.ai, gets a diagnosis, posts to a human-readable summary tab.

### The transport pattern (architecture sketch)

Deliberately simple to start. The mechanism is interchangeable:

- **HTTP endpoint** (Express, PHP, whatever) where one AI posts and another polls
- **MCP server hosted by AI Connect** that all AIs connect to as both publisher and subscriber
- **Shared filesystem / Supabase row** that AIs read and write
- **Webhook callbacks** for event-triggered handoffs

The user shouldn't care which transport — AI Connect picks per use case.

### Configurable event-triggered prompting

Not every event triggers AI coordination. The user configures which events trigger which AI:

- "When Project Genesis verify_deployment fails, post the Render logs to Claude.ai and ask for diagnosis"
- "When Claude Code finishes a commit, ask Cursor to write a 1-line PR summary"
- "When OpenClaw configuration encounters an unknown error, ask Claude.ai for a recovery path"
- "When the human asks 'is X done', summarize across all active AI conversations and respond"

Each event hook: event → which AI → prompt template → escalation rule → cost budget.

### Warning signals

Hundreds of copy-pastes today = thousands of automated AI-to-AI exchanges in the future. Critical that AI Connect surfaces problems:

- **Loop detection** — two AIs going back and forth without converging. Escalate to human.
- **Budget warnings** — token cost exceeds threshold. Pause, escalate.
- **Contradiction detection** — AIs reaching incompatible conclusions. Escalate.
- **High-risk action proposed** — AI proposes deleting data, making payments, sending emails. Escalate.
- **Convergence detection** — AIs have reached consensus, here's the result. Human reviews and approves.

The default is: humans get involved only at decision points and escalations. Everything else runs.

### Why this is genuinely novel positioning

Existing tools either:
- Sit a single AI inside a single environment (Cursor, Claude Code, Replit, OpenClaw)
- Use one AI to call another via API as a tool (Anthropic's tool use, OpenAI's function calling)
- Hardcode AI orchestration patterns (LangChain, CrewAI, Autogen)

None of them are "**a unix pipe for AI tools**" — orthogonal to any specific AI, user-configurable, event-triggered, observable, debuggable. That's what AI Connect could be uniquely positioned to provide.

### Sprint sequencing

Earliest reasonable: Sprint 8-10 (after tool routing infrastructure). Would build on:

- MCP server for AI Connect (Sprint 6-7 candidate)
- Tool routing layer (Sprint 8 if adopted)
- Composable skills (Sprint 10-15)

A minimal proof-of-concept could ship earlier — just direct handoff between Claude.ai and Claude Code via a shared transport, no fancy routing. Maybe 1-2 sprints. Worth thinking about: this might be the SHORTEST path to a real moat.

### Open architectural questions

- Synchronous or async? Probably async — AIs are slow, blocking is bad UX
- How long do AI conversations persist? Per-task? Per-project? Across-projects?
- How is context shared between AIs (full history vs summary vs state pointer)?
- Cost model — AI-to-AI is still token-priced; budget controls are essential
- Trust model — does AI A get to make commits if AI B proposes them? Or only with human approval?
- Discovery — how does AI A know AI B exists and what it's good at?

### Concrete next step (when to revisit)

After Sprint 5.7 ships and the smoke test confirms Project Genesis works at the .onrender.com URL, revisit this. Three possibilities:

A. Sprint 8 builds tool routing first, then AI-to-AI coordination Sprint 9.
B. Sprint 8 builds AI-to-AI coordination FIRST (the shortest path to a real moat), tool routing follows.
C. Build a minimal POC during Sprint 6 (Auth0 sprint) on the side, see if it changes the founder's daily workflow.

C is interesting because the founder is currently feeling the pain directly. Even a crude version that eliminates 50% of copy-pastes would be useful immediately.

## Deferred infrastructure

### Migrate AI Connect's own database to MTT-AIConnect Supabase org

Currently AI Connect's production database lives at supabase project rmbolhoizdwykpqmlhzw in the MacroTechTitan organization (alongside OptimaQuant, rfl-pst-portal, and other unrelated projects).

A dedicated MTT-AIConnect Supabase organization has been created (project uiyozvlrsrhrqzsalsum at https://uiyozvlrsrhrqzsalsum.supabase.co) for AI Connect's own data and for projects it provisions on users' behalf.

The new org is currently dormant — Sprint 6 work (migration 0007 / integrations table) was applied to the existing prod database to avoid mid-sprint migration risk.

When ready to migrate:
- pg_dump from rmbolhoizdwykpqmlhzw, restore to uiyozvlrsrhrqzsalsum
- Update DATABASE_URL on Render's ai-connect-api service
- Redeploy and verify
- Decommission the original project once confidence is high

Also update the Supabase platform credential in AI Connect so that PROJECT GENESIS provisions new client Supabase projects under the MTT-AIConnect org rather than MacroTechTitan. This is the actual value of the migration — keeps user-provisioned databases organizationally separate from your other businesses.

No deadline. Defer until between sprints to minimize disruption.

---

*Last updated: 2026-06-13*
