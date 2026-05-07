# Skills

A skill is a reusable prompt fragment + behavior pattern that AI Connect can load into a project to guide AI dispatches. Skills are markdown files with descriptive content and (optionally) embedded patterns or scripts.

## Directory layout

- **`platform/`** — Skills that ship with AI Connect. Curated, maintained by the project, used by the platform itself for its own operation.
- **`community/`** — Skills contributed by external developers. Reviewed for quality, safety, and methodology alignment before merging. Anyone can contribute one — see [`../CONTRIBUTING.md`](../CONTRIBUTING.md).

A user's project can also have its own skills in `.mtt/skills/` within the project repo. Those don't live in this monorepo.

## Current platform skills

- `BYOAI_SKILL.md` — How AI Connect's BYOAI provider router is structured. Reference for adding new inference providers.
- `GITHUB_SYNC_SKILL.md` — Patterns for forcing GitHub-to-Replit (or any-to-any) repo sync when the platform's auto-sync diverges. Useful for the agentic-target side of the GitHub message bus.
- `CACHE_BUSTING_SKILL.md` — Vercel + Vite SPA cache configuration. Needed for AI Connect's own deploy and reusable for user projects.
- `FIX_REPLIT_QUICK_REFERENCE.md` — Triage card for broken Replit deployments. Used by the Replit polling daemon's failure handler.

More platform skills will be added as sprints surface reusable patterns. The MTTBuild discipline of "encode the lesson when you learn it" applies here.
