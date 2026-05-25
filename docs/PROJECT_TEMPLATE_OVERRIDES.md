# Project Template Overrides — AI Connect

This document captures any deviations AI Connect makes from the MTTBuild defaults documented in [`MTTBuild.md`](MTTBuild.md). Future Claude Code sessions and contributors should read this file before assuming MTTBuild defaults apply unmodified.

## Current overrides

*None yet. AI Connect uses MTTBuild defaults across the board:*

- **ORM:** Drizzle (default)
- **Hosting:** Render (API) + Vercel (frontend) (default)
- **Database:** Supabase Postgres via IPv4 session pooler (default)
- **Auth:** Auth0 (default — same tenant as other MTT products: `macrotechtitandev.us.auth0.com`)
- **Payments:** Stripe (default — shared customer pool with other MTT products)
- **Package manager:** pnpm (default for MTT projects)

## How to add an override

When AI Connect needs to deviate from MTTBuild, add a section here following this template:

```
### [Override name]

**Default:** [What MTTBuild specifies]
**AI Connect:** [What we do instead]
**Reason:** [Why the deviation is necessary]
**Date added:** [YYYY-MM-DD]
**Sprint:** [Which sprint introduced the override]
```

Overrides should be rare and well-justified. Most apparent deviations turn out to be bugs in the implementation, not legitimate overrides — re-read MTTBuild before adding here.

## Architectural commitments (Sprint 0.5)

The Sprint 0.5 landing page uses audience-agnostic framing ("whether you're one developer or fifty"). That implicitly commits AI Connect to serving teams up to ~50 developers within a reasonable timeframe. To avoid painting into a solo-only corner, the following architectural decisions are locked in now even though implementation comes later:

### Multi-tenant data model (target: Sprint 3-4)
- Introduce `organizations` table before any multi-user features ship.
- Introduce `projects` table — each organization can have multiple projects. The portfolio pattern (one org has AI Connect, OQ, Matt, etc.) is core to AI Connect's mental model.
- All user-scoped data gets `organization_id` and (where relevant) `project_id` foreign keys.
- The current `users` table will gain an `organization_id` column.
- The admin seed will be updated to create a default "MacroTechTitan" organization, a default "AI Connect" project under it, and assign the seed user to that organization.
- Org-level isolation will be enforced at the query layer (drizzle helpers) before any user-facing multi-user features ship.
- The data model is `organizations → projects → users → (sprints, audit logs, AI usage)`. Not flat `organizations → users`.

### Self-hosting story (target: Sprint 7+)
- The MIT framework must be deployable on customer infrastructure, not only on Render/Vercel/Supabase.
- All Sprint 1-6 architecture decisions (auth wiring, provider routing, secret handling, encryption) must avoid hard dependencies on platform-specific features that would block self-hosting.
- Render-specific features (Background Workers, Cron Jobs, Render Disks) get abstraction layers so the framework can run on alternative platforms (Fly.io, Railway, raw Docker, on-prem) without code changes.

### Cost-aware AI routing (architectural implication, target: Sprint 6-8)
- Sprint 2's BYOAI provider abstraction must capture cost-per-call (tokens × provider rate) as first-class data on every AI call.
- Each AI invocation logs: provider, model, input tokens, output tokens, estimated cost, latency, task type.
- This data feeds the cost-aware routing feature (Sprint 6-8): static rules per task type, then dynamic budget-aware escalation.
- Retrofitting cost tracking later is expensive. Capturing it from day one of Sprint 2 is the design constraint.

### Project Genesis (architectural implication, target: Sprint 8-10)
- The flagship workflow: "user signs up → AI Connect provisions Vercel + Render + Supabase + Auth0 + DNS + monorepo scaffold + working /health in ~10 minutes." Automates the Sprint 0 work done manually for AI Connect itself.
- Architectural implication NOW: by Sprint 3, the `projects` table models the platform-side state of any project AI Connect manages (Render service IDs, Vercel project IDs, Supabase refs, Auth0 tenants, DNS records).
- AI Connect must be able to introspect its own current infrastructure setup before it can reproduce it for users. The Project Genesis feature reverses this: it provisions outward instead of introspecting inward, but the data model is the same.

These commitments are recorded here per MTTBuild §1.2 (overrides and project-specific decisions go in this file).

---

*Last updated: May 24, 2026*
