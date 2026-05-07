# Contributing to AI Connect

Thanks for considering a contribution. AI Connect is open core — the framework is MIT-licensed and welcomes external contribution; the hosted product (billing, marketplace, support) is operated by Macro Tech Titan and not part of community contributions.

Read this before opening a PR. The full philosophy lives in [README section 10](../README.md#10-contributing).

## Before you start

- **Read [`docs/MTTBuild.md`](docs/MTTBuild.md) end-to-end.** AI Connect is built using the methodology it enforces. Your contribution should follow the same sprint discipline AI Connect imposes on its users.
- **Read the README in full.** Section 1 ("What this is and why it exists") is long for a reason — it captures the design intent that should drive every decision.
- **Check the sprint log** at [`docs/sprints/SPRINT_LOG.md`](docs/sprints/SPRINT_LOG.md). Sprints in flight or recently merged shape what's currently mergeable.

## Types of contribution

### Skills

Skills live in `skills/community/` (community-contributed) or `skills/platform/` (ships with AI Connect, more curated). To contribute a skill, open a PR adding a single markdown file to `skills/community/` following the existing skill format. Skills go through review for:

- **Quality** — clear, complete, useful
- **Safety** — no copyright violations, no prompt-injection vectors, no data exfiltration
- **Methodology alignment** — consistent with MTTBuild

### Code

Standard fork-and-PR. Conventions:

- **One feature per branch.** No omnibus PRs.
- **Pull master before and after.** Same rule the platform enforces on users.
- **Tight scope.** PRs touching more than ~10 files trigger a "split this" review comment.
- **Tests for new behavior.** Existing tests must stay green.
- **Migrations never auto-apply.** Schema migrations follow the AI Connect pattern: generate, commit, plan, review, manually apply.

### Documentation

PRs to README, MTTBuild, or docs are welcomed. Note that the README is the spec — significant changes need discussion in an issue first, since the README drives every downstream sprint.

## What we won't accept

- PRs that break the open-core boundary by importing proprietary hosted features
- PRs that bypass MTTBuild methodology (no skipping Phase 0, no parallel sprints, no direct-to-master)
- PRs that add provider integrations without the encrypted-credential pattern
- PRs that introduce platform-specific dependencies without graceful degradation
- PRs that add new dependencies casually — every new dependency is reviewed for necessity, license, and maintenance status

## Code of conduct

Be helpful, be honest, be respectful, be specific. Disagreement is fine; condescension is not. Standard open-source norms apply.

## Questions?

Open an issue with the `question` label. For the hosted product specifically, contact `support@macrotechtitan.com` (not via GitHub issues).
