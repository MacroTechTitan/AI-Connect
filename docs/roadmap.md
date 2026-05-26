# AI Connect roadmap

This document captures the planned sprint sequence and monetization milestones for AI Connect. It is a working plan, not a binding commitment — user signal, validation, and learning will reshape it as we go.

For unsorted feature ideas and longer-term concepts, see `docs/future-ideas.md`.
For completed sprints with retrospective lessons, see `docs/sprints/SPRINT_LOG.md`.

## Sprints

### Sprint 0 — Phase 0 infrastructure ✅ SHIPPED (2026-05-24)
Monorepo, live API, live frontend, schema, logging, admin tooling, custom domains, secret handling.

### Sprint 0.5 — Polish ✅ SHIPPED (2026-05-24)
Public CHANGELOG, landing page rewrite, architectural commitments document, drizzle-orm security upgrade, future-ideas.md.

### Sprint 1 — Auth0 wiring + /api/me ✅ SHIPPED (2026-05-25 / 2026-05-26)
JWT middleware, /api/me with lazy user creation, frontend Auth0 SDK, smoke test. Plus production hotfixes for CORS and Auth0 namespaced email claim.

### Sprint 2 — BYOAI provider abstraction
**Goal:** users connect their own AI provider keys (Claude, OpenAI, Gemini, Ollama). AI Connect routes prompts. Cost-per-call captured from day one (per Sprint 0.5 architectural commitment).
**Estimated:** 2-3 days.
**Public visibility:** First demo-worthy feature. Build-in-public content begins.

### Sprint 3 — Multi-tenant data model
**Goal:** organizations table, projects table, users → organizations relationship. Org-level isolation at query layer.
**Estimated:** 2-3 days.
**Public visibility:** Internal infrastructure sprint. No public content needed.

### Sprint 4 — Project Genesis MVP (Path A, custom build)
**Goal:** signup wizard's Path A — user clicks "Start new dev project," AI Connect provisions Vercel + Render + Supabase + Auth0 + DNS in ~10 minutes. Real automation.
**Estimated:** 5-7 days.
**Public visibility:** First genuinely viral-worthy demo. 60-second video of "watch AI Connect provision a full SaaS infrastructure in real-time."
**Monetization milestone:** Stripe integration ships in this sprint or Sprint 5. Free tier "first 100 users" launch.

### Sprint 5 — Project Genesis Path B (takeover)
**Goal:** Replit / Lovable / Open Claw / GitHub repo ingestion. User provides a repo URL, AI Connect analyzes, proposes migration plan, executes onto AI Connect's stack.
**Estimated:** 7-10 days.
**Public visibility:** Testimonial-driven content. "Show me your messiest Replit project."
**Monetization milestone:** First paying users likely arrive in this sprint. Solo Dev tier introduced ($29/month range, exact pricing TBD by signal).

### Sprint 6 — Cost-aware AI routing
**Goal:** Sprint 0.5's cost-aware routing architecture becomes user-facing. Static rules (per task type) plus dynamic budget-aware escalation.
**Estimated:** 4-5 days.
**Public visibility:** "AI Connect saved me $X this month" content.
**Monetization milestone:** Pro tier introduced ($99/month range). Free users get one provider, Pro users get smart routing.

### Sprint 7 — Audit trail UI + sprint dashboard
**Goal:** the audit logs that Sprint 0 already captures get a UI. Per-sprint cost breakdown, AI-action attribution, methodology adherence reporting.
**Estimated:** 4-5 days.
**Public visibility:** Enterprise-credibility milestone. Compliance-conscious orgs become viable conversations.
**Monetization milestone:** Pro tier strengthened. Enterprise conversations open up.

### Sprint 8-9 — Self-hosting story
**Goal:** AI Connect deployable on customer infrastructure. Docker compose for solo devs; Helm chart for ops teams; on-prem deployment kit for enterprise.
**Estimated:** 7-10 days.
**Public visibility:** Opens regulated industries, defense, finance.
**Monetization milestone:** Enterprise tier ($500-2000/month + support contract). Shield AI / defense procurement conversations possible.

### Sprint 10-12 — WordPress plugin channel
**Goal:** AI Connect for WordPress published to WordPress plugin directory. Authenticated bridge, REST API connector, AI chat widget, content automation.
**Estimated:** 14-21 days (different deployment model, marketplace approval cycle).
**Public visibility:** Largest distribution channel — WordPress plugin directory has built-in discovery for tens of millions of WordPress sites.
**Monetization milestone:** Largest monetization opportunity by audience size. Freelance WordPress devs are price-tolerant and used to paying for tools. Free + paid features model.

### Sprint 13-15 — SDK + plugin marketplace foundations
**Goal:** developers build their own AI Connect apps on top of the connector layer. Public SDK, basic marketplace listing, manual app approval.
**Estimated:** 14-21 days.
**Public visibility:** Platform credibility shift. AI Connect = platform-for-platforms.
**Monetization milestone:** Revenue share with app authors. Standard 70/30 or 80/20 split. Long-term moat.

### Sprint 16-20 — Filling out the platform
Connectors for Drupal, Ghost, other CMSes. Mobile companion app. Team observability dashboard. Compliance certifications (SOC 2 Type II evaluation). Production-grade reliability work. Vertical-specific targeting (defense via Shield AI connection, etc.)

## Monetization timeline

| Sprint | Stripe state | Tiers available | Audience |
|---|---|---|---|
| 0-3 | Not integrated | Free (closed beta, single user) | Founder only |
| 4 | Integrated | Free (open) | First 100 users |
| 5 | Live billing | Free + Solo Dev ($29/mo range) | Solo devs, takeover use case |
| 6-7 | Live billing | Free + Solo Dev + Pro ($99/mo range) | Heavy AI users, small teams |
| 8-9 | Live billing | + Enterprise ($500-2000/mo + support) | Regulated industries, large teams |
| 10-12 | Live billing | + WP Plugin tier (free + paid features) | Freelance WP developers |
| 13+ | Live billing | + Marketplace revenue share | App authors |

## Public visibility phases

**Phase 1 — Build in public (Sprint 2-3):** Architecture decisions, technical lessons, methodology layer concept. No selling.

**Phase 2 — First demo content (Sprint 4):** Project Genesis demo video. Twitter/LinkedIn launch. HN Show post.

**Phase 3 — Paid product launch (Sprint 5-6):** First takeover testimonials. Pro tier introduced.

**Phase 4 — Enterprise outreach (Sprint 8-10):** Self-hosting works + audit dashboard mature. Reach Shield AI contacts, defense procurement.

**Phase 5 — Platform launch (Sprint 13-15):** SDK + marketplace open to third-party developers.

---

*Last updated: 2026-05-26*
