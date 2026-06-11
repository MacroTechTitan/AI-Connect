# Smoke Tests — Index

Run these procedures to verify AI Connect's end-to-end behavior. Each links to a sprint-specific test doc with the full procedure.

## Active smoke tests (one per shipped sprint)

| Sprint | What it verifies | Test procedure |
|--------|------------------|----------------|
| Sprint 4 | Project Genesis MVP (cloud provisioning + rollback) | [SPRINT_4_TESTING.md](./SPRINT_4_TESTING.md) |
| Sprint 5 | Template scaffolding + DNS + DATABASE_URL injection | [SPRINT_5_TESTING.md](./SPRINT_5_TESTING.md) |

## How to run a full regression

When validating before a major release, run the tests in the order shipped (Sprint 4 then Sprint 5). Each sprint's procedure assumes prior sprints' features still work.

For development iteration, run only the test for the sprint you're currently building or modifying.

## Adding new sprint tests

When a sprint that introduces user-visible behavior ships, add a row to the table above. Hot-fix sprints (e.g. Sprint 5.5) do NOT need their own row — they reverify behavior already covered by the parent sprint's test (Sprint 5).

## Cleanup discipline

Every smoke test creates real cloud resources. The per-sprint procedures include cleanup steps. Run them. Orphan resources cost real money over time.

---

Last updated: 2026-06-10
