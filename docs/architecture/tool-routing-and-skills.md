# Tool Routing and Composable Skills — Architecture Sketch

**Status:** Discussion draft. Not committed scope. Captured 2026-06-06 during Sprint 5.

**Triggering thought:** While building Project Genesis, the founder observed that different AI development tools have meaningfully different sweet spots, and that AI Connect could potentially position itself as the meta-layer that orchestrates between them rather than competing against them. Concurrent with this, work on Deal Match's recruiting system surfaced the question of whether feature modules built for one project could be reused across projects as installable units.

This document captures the thinking but does NOT commit AI Connect to building any of it. The decision belongs after Sprint 5 ships.

---

## Three Distinct Ideas, Often Conflated

### Idea 1: Tool routing

Different AI dev tools win at different task types:

- **Replit Agent** — fast iteration within a constrained scope. Bad at architecture (sprawling solutions, no methodology enforcement). Excellent at "wire this button to that endpoint" tasks.
- **Cursor** — strong in-IDE context. Knows the open files, can edit across them, has tab completion + agent mode. Best for tasks where the user is actively reading the code alongside the AI.
- **Claude Code (terminal)** — careful multi-file changes, good at structured prompts, integrates with git/build/test workflows. Best for well-specified commits with clear acceptance criteria.
- **Claude.ai (this layer)** — architecture, planning, methodology review, sprint discipline, conversational decision-making. Bad at executing many small file changes (better delegated to Claude Code). Best for "what should we do and why."
- **Perplexity Comet, browser-use, other agents** — browser automation, multi-tab task completion, things outside an IDE entirely.

**Hypothesis:** AI Connect could classify incoming tasks and route them to the appropriate tool automatically. User says "add user profile to my project." AI Connect determines this is a multi-file refactor with new endpoints, routes to Claude Code via API, returns the diff. User says "the button on this page should be blue." AI Connect routes to Cursor's API with the specific file context, returns the change.

The user never has to pick a tool. They get results.

### Idea 2: Composable skills

Built feature modules become reusable across projects:

- Deal Match has a recruiting flow (sourcing, outreach, tracking)
- Pro Skills Bridge could use the same recruiting flow
- Today: copy-paste the code, manually adapt to new project
- AI Connect could: package the recruiting flow as an installable "skill module" that any AI Connect project can install, with updates flowing back

**The hypothesis:** AI Connect projects aren't just standalone deployments. They're compositions of skills. A new project = template (Sprint 5) + 0-N skill modules. Skills have well-defined interfaces (data they need, UI they expose, env vars they require). Adding a skill to a project provisions whatever resources it needs (new DB tables, new Render env vars, new GitHub workflows).

This is genuinely novel territory. Not v0 (single-shot UI generation). Not Lovable (full SaaS generation). Not Replit (general IDE). Something like "Wordpress plugins for AI-native apps," but architected for the AI-assisted dev workflow.

### Idea 3: Template marketplace (already on the roadmap)

The Sprint 13-15 work where third parties contribute templates beyond AI Connect's own 3. Different from Idea 2 because templates are starting points (you pick one at project creation), while skills are additive (install them after the project exists).

Sometimes these get conflated. They're related but distinct.

---

## Idea 4: Command Center UI (added 2026-06-09)

**Triggering thought:** mid-Sprint-5.5, the founder articulated that AI Connect's eventual UI should look "like Cursor on the front end" — a tabbed command center for managing service connections, not an IDE.

### The shape

A single window. Tabs along the top for each service connected to the active project. Active tab shows that service's relevant data and status.

Mock layout:

    ┌─────────────────────────────────────────────────────────┐
    │ [Project] OQ ▼ │ Deal Match │ AI Connect │ + New tab   │
    ├─────────────────────────────────────────────────────────┤
    │ Service tabs:                                            │
    │ [Supabase] [Render] [Vercel] [GitHub] [Cloudflare]      │
    │ [Auth0] [Stripe] [Logs] [Costs] [Settings]              │
    ├─────────────────────────────────────────────────────────┤
    │                                                          │
    │  (active tab content — embed of that service's dashboard │
    │   OR AI Connect's own view of that service's data)       │
    │                                                          │
    └─────────────────────────────────────────────────────────┘

Project selector across multi-project portfolios. Service tabs per project. Each tab surfaces that service's status + recent activity + deep link to the real dashboard.

### Why this matters

1. It's the concrete shape of the "Build and Ship" framing. Not an IDE (Cursor does that). Not a SaaS generator (Lovable does that). Not a deploy platform (Vercel does that). It's the missing connective layer between code editor and deployed app — the place where service-to-service wiring is visible and fixable.

2. It matches the founder's actual workflow. ~30+ open tabs across Vercel, Render, GitHub, Supabase, Cloudflare, Auth0, Stripe dashboards is the status quo. AI Connect's command center collapses these into one window.

3. It naturally absorbs tool routing and composable skills (Ideas 1 and 2). Tool routing is "which tab handles this task." Composable skills are "install this set of services as a bundle." Both fit the tab paradigm cleanly.

### Implementation approaches

How to populate each service tab. Three options:

**A. Iframe embed of the service's dashboard.** Pros: full functionality immediately. Cons: most services set X-Frame-Options to prevent iframe embedding. Won't work for most.

**B. Rebuild each service's UI inside AI Connect via their API.** Pros: full control, consistent design, can show cross-service info. Cons: massive engineering — Supabase alone has dozens of screens we'd be rebuilding.

**C. Hybrid: summary view + deep link.** Each tab shows status + last activity + key metrics from APIs, plus a prominent "Open in <Service>" button. Pros: realistic scope, still genuinely useful. Cons: still meaningful API work per service.

**Recommendation: C.** It's the only shippable scope. The value isn't in replacing the service dashboards — it's in seeing all of them at a glance in one place and knowing where to drill deeper.

### Sprint sequencing implications

This isn't Sprint 5.5 work. The command center UI is probably Sprint 7-9 territory — meaningful frontend work that builds on Sprint 6's Auth0 + 7's Stripe + 8's tool routing.

But the architectural decision matters NOW for sprints in between:

- **Project data model:** projects should treat "connected services" as the primary shape. Sprint 4-5 already model projects this way (GitHub repo + Vercel + Render + Supabase per project) — keep this pattern as Sprint 6+ adds Auth0 and Stripe.
- **API surface:** each service's status should be queryable independently so future tabs can fetch their data without coupling to provisioning state. Currently AI Connect's GET /api/projects returns a flat row; future GET /api/projects/:id/services/:service should return per-service status.
- **Frontend architecture:** the current single-page settings panel is a placeholder. Sprint 7-9 should rebuild around the tabbed shape. Worth not adding too much polish to the current UI in the meantime — minimize sunk cost when the rewrite comes.

### What this is NOT

The command center is not:
- An IDE (Cursor / VS Code already excel here)
- A code editor (no file tree, no text editing)
- A SaaS storefront (no landing pages, no marketing site builder)
- A no-code app builder (no drag-and-drop UI builder)

It's specifically the **service connection layer** that AI-built apps need but don't have a great tool for.

---

## Strategic Question

AI Connect's current positioning (per Sprint 0.5's vision doc): "the methodology + orchestration layer for AI-assisted dev." 

What we've actually built so far is closer to: "BYOA + cloud infrastructure provisioning + project methodology enforcement + audit trail."

The orchestration *of which AI does what* has been almost entirely manual — the founder decides which tool to use for each task, manually copy-pastes between them, manually applies the methodology rules.

**The question:** Does AI Connect's vision include automating the choice of which AI tool runs which task, and/or include a composable skills layer?

Four possible answers:

### A. Stay scoped — methodology + infrastructure only

AI Connect ships:
- Project provisioning (Sprint 4-5)
- Auth0 / Stripe / DNS automation (Sprint 6-9)
- BYOAI cost tracking (Sprint 2, shipped)
- Methodology enforcement (Sprint 0.5, partial)
- Audit / cost / observability (across sprints)

Tool routing and composable skills are explicitly OUT of scope. Users pick tools manually. Users decide their own architecture.

Pros: Smaller scope, faster to ship, clearer pitch, no competition with established tools.

Cons: Smaller moat. Replit/Lovable/Bolt could ship "audit + cost tracking" features and erode the differentiation.

### B. Add tool routing as a future sprint

Sprint 8-12 effort: build a task classifier, integrate with Replit Agent API, Cursor CLI, Claude Code, browser-use, etc. AI Connect routes tasks to the right tool. Single interface for the user.

Pros: Real moat — being the "meta-tool" is structurally defensible. Existing tools can't easily build this without cannibalizing their own products. Users get the best tool for each task without having to know which.

Cons: Massive scope. Each integration is its own multi-sprint effort. Validation requires building enough to test, which means at least 6 months of work before knowing if users want it.

### C. Add composable skills as a future sprint

Sprint 10-15 effort: build a skill module abstraction, skill marketplace, skill installation flow on top of Project Genesis. "Add a recruiting flow to my project" becomes a one-click skill install with provisioning logic embedded.

Pros: Different moat than B but real. Lovable can't easily add this without rebuilding their architecture. Skill creators (third parties) become invested in AI Connect. Network effects start.

Cons: Requires Project Genesis to be solid first (Sprint 5 finishes that). Requires a skill abstraction that doesn't exist yet. Requires real adoption to make the marketplace work — chicken-and-egg.

### D. All of the above — full vision

A + B + C. AI Connect is methodology + infrastructure + tool routing + composable skills. The complete vision.

Pros: Biggest possible moat.

Cons: Multi-year effort. Easy to spread thin. High risk of shipping nothing complete.

---

## Honest Assessment

Right now (June 2026):

- Sprint 5 isn't done. Project Genesis MVP isn't shipped end-to-end yet.
- No real users besides the founder.
- No revenue, no validation that anyone wants ANY of this.

**Reaching for B/C/D before validating A is the classic founder failure mode.** Build the bigger thing because the bigger thing is more interesting, ship nothing, run out of runway/energy.

**Reaching for A and stopping there is the conservative-failure mode.** Build something complete but undifferentiated, fail to capture the actual opportunity.

The real path: **Ship A through Sprint 9-10 (Project Genesis + Auth0 + Stripe Connect ready for real users). Then do a focused 1-week discovery sprint specifically on B and C. Then decide.**

What "discovery" means here:

1. Inventory every AI dev tool the founder actually uses across all current projects (OQ, AI Connect, Deal Match, Pro Skills Bridge, RFL PST, TelePath OS, MTTAd1Render, etc.). Track for one week: which tool used for which task, what worked, what didn't.

2. Identify task patterns that recurred across multiple projects. Recruiting was one such pattern. There are probably others.

3. Map the API surfaces of the tools — which can actually be orchestrated programmatically? Cursor exposes CLI. Claude Code is itself programmatic. Replit Agent has chat-based interaction (no clean API yet). Browser automation works for tools without APIs but is fragile.

4. Sketch the data model: what does a "task" look like in AI Connect's database? What does a "skill" look like? Can these abstractions coexist with Project Genesis's existing model?

Output is a doc, not code. Decision is whether to commit to B or C as a future sprint.

---

## Specific Tactical Captures

### The Deal Match → Pro Skills Bridge example

The recruiting system being built for Deal Match is a real candidate for a "skill" if AI Connect adds that abstraction. Worth documenting WHILE building it:

- What does Deal Match's recruiting flow assume about the host project's data model?
- What database tables does it require?
- What env vars does it consume?
- What UI does it expose?
- What URLs does it own?
- What's required of the project to "host" this skill?

If those questions get answered cleanly during the Deal Match build, the same flow is much more easily extracted to a skill abstraction later.

**Action: track the answers to these questions as Deal Match's recruiting system gets built. Independent of whether AI Connect ever adds the skill abstraction — clean module boundaries are good engineering anyway.**

### Tool-task pairings observed so far

From the founder's actual workflow building Sprint 4-5 of AI Connect:

| Task type | Tool that worked | Tool that didn't |
|-----------|------------------|------------------|
| Architectural decisions (5a vs 5b vs 5c split) | Claude.ai | Would have failed in Replit |
| Multi-file commit with careful review | Claude Code | Would have sprawled in Replit |
| Watching SSE smoke test in real time | Browser + Claude.ai | N/A |
| Generating template repos (3 minimal apps) | Claude Code | Could have used Cursor |
| Database migrations + schema review | Claude.ai + manual SQL paste | MCP swap would speed this up |
| PR + merge ritual | PowerShell + gh CLI + Claude.ai | N/A |

Patterns emerging:
- Architecture and review consistently belong in Claude.ai (chat)
- File-creation and commit work consistently belong in Claude Code (terminal)
- Smoke testing belongs in the browser (or in a future test harness)
- DB migrations are slowed by the manual SQL paste workflow (would benefit from MCP swap)

This isn't a study, but it's a starting hypothesis: **Claude.ai for decisions + reviews, Claude Code for execution, browser for live testing.**

That's a 3-tool routing. Useful as a starting point if/when B becomes a sprint.

---

## Decision Log

- **2026-06-06:** Captured initial thinking. Decision deferred until Sprint 5 + 6 + 7 ship.
- **2026-06-09:** Command Center UI added to the architecture sketch as Idea 4. Sprint sequencing: Sprint 7-9 territory. Sprint 5.5 (current) and Sprint 6 (Auth0) continue as planned; their data model and API surface decisions should anticipate the command center destination.
- **TBD:** Revisit after Sprint 9-10 with a discovery sprint.

---

*This document is a snapshot of the founder's thinking. It is NOT a commitment. AI Connect's actual scope through Sprint 9 remains: methodology + infrastructure + BYOAI + audit.*
