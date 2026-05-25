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

*Last updated: 2026-05-25*
