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

---

*Last updated: May 5, 2026*
