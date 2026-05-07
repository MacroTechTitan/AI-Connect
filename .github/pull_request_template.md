## Sprint reference

Which sprint does this PR belong to? Link the sprint plan or the SPRINT_LOG entry.

## What this changes

One or two sentences describing what shipped.

## Files changed

List the files touched. PRs touching more than ~10 files should be split.

## Pre-flight checklist

- [ ] Pulled latest `master` before starting work
- [ ] Re-merged `origin/master` into this branch before opening the PR
- [ ] `pnpm -r build` passes
- [ ] Typecheck has no new errors beyond environmental
- [ ] No platform-specific dependencies added without graceful fallback
- [ ] Logging wired into new code paths (`logSystem`, `logUserAction`, or `logDev`)
- [ ] Migration files (if any) committed but NOT applied to live DB
- [ ] Migration plan doc updated if schema changed
- [ ] Documentation updated for any new public-facing concept

## Decisions made

Any architectural or scope decisions made during execution that weren't in the original plan.

## Open follow-ups

Anything intentionally deferred to a future sprint.

## Roll-back path

If this breaks production, what's the revert?
