# The independent reviewer

A Build Run that finishes its work lands in `REVIEWING`. Something has to judge
it before a human is asked to approve anything, and that something must not be
the thing that did the work.

This document covers the reviewer boundary, what a reviewer is given, what it
can return, and what it structurally cannot do.

## Why it is a separate boundary

`BuildReviewer` is not a second method on `BuildWorker`. Keeping them apart is
what makes "independent" mean something:

- **A new session, every time.** No `--session-id`, no `--resume`, no `--continue`.
  The reviewer cannot see the worker's conversation — only what it actually
  changed.
- **Read-only tools.** `Read`, `Glob`, `Grep`, and nothing else. `Write`,
  `Edit`, `Bash` and the rest are denied. A reviewer physically cannot fix what
  it is judging, run anything, push, or deploy.
- **No lifecycle access.** A reviewer returns a verdict. `reviewerService`
  applies it through the same state machine every operator action goes through,
  in a transaction, with the same concurrency guard.

## Layout

| File | Responsibility |
| --- | --- |
| `reviewer/types.ts` | The `BuildReviewer` interface and the payload schema. |
| `reviewer/payload.ts` | Assembles a `ReviewRequest` from the database and the workspace. |
| `reviewer/redact.ts` | Scrubs known secret shapes before anything leaves the process. |
| `reviewer/prompt.ts` | The reviewer policy and the run-specific brief. |
| `reviewer/parse.ts` | Reads a verdict out of a model's reply. Pure. |
| `reviewer/claudeReviewer.ts` | The v0.1 provider. The only file that knows a model is involved. |
| `reviewer/registry.ts` | Provider name → adapter. |
| `reviewerService.ts` | Runs a review and applies the verdict. |

Provider-neutral above `claudeReviewer.ts`: nothing in the Build Control
lifecycle names a model. Swapping the reviewer is a new file, a registry entry,
and `AICONNECT_REVIEWER_PROVIDER`.

## Running one

```
POST /api/build-runs/:id/review/independent
     { "provider": "claude_code" }        # optional; defaults to the configured one
```

This is distinct from `POST /api/build-runs/:id/review`, which **records** a
verdict someone else already reached. This one **produces** the verdict. Both
land in `build_reviews` and both move the run through the same transitions.

`GET /api/build-runs/runner` reports whether a reviewer is available here,
alongside the worker.

## The payload

Everything the reviewer is given, and the only thing it is given. It is a plain
serializable object: a reviewer judges a run without a database handle, without
a writable checkout, and without any part of the worker's process.

| Field | Contents |
| --- | --- |
| `task` | `runId`, `title`, `goal`, `acceptanceCriteria[]`, `outOfScope[]`, `stopAndAsk[]` |
| `feature` | `featureId`, `workPacket` — the Feature Work Packet when the run carried one |
| `workspace` | `repoRoot`, `branch`, `baseCommit` (paths only; it cannot write there) |
| `events[]` | The normalized timeline: `at`, `type`, `severity`, `summary`, `target` |
| `diff` | `filesChanged[]`, `additions`, `deletions`, `patch`, `patchTruncated`, `unmeasured[]` |
| `validation` | `summary[]` the run recorded, plus `completionGates[]` |
| `worker` | `type`, `status`, `finalMessage`, `metrics` — labelled as the worker's **claim**, not evidence |
| `context[]` | Architecture/policy files named by `AICONNECT_REVIEWER_CONTEXT_FILES` |

Two details that matter:

- **Untracked files are in the patch.** A plain `git diff` does not show them,
  and a reviewer that cannot see a newly created file is reviewing the wrong
  thing.
- **The worker's message is labelled as a claim to check against the diff.** A
  reviewer that takes the worker's word for it is not adding anything.

Caps: 120k characters of patch, 40k per context file, 300 events. A truncated
diff is flagged in the payload and the reviewer is told to weigh it.

## Redaction

The payload carries a repository diff to a separate process and, for a hosted
provider, a separate network. `redact.ts` is the last point at which we control
what is disclosed. It replaces provider key shapes (Anthropic, OpenAI, GitHub,
Stripe secret/restricted, Slack, AWS), JWTs, PEM private-key blocks, passwords
inside connection strings, and values assigned to secret-named variables.

Two deliberate choices:

- **Names survive, values do not.** `DATABASE_PASSWORD=[REDACTED]` — a reviewer
  should be able to see that a run touched a credential without seeing it.
- **Placeholders are left alone.** `API_KEY=`, `${API_KEY}`, `<your-key>`,
  `changeme` are not secrets, and hiding them makes a diff harder to review for
  no benefit. Stripe **publishable** keys (`pk_`) are likewise untouched: they
  are designed to be public.

This is defence in depth, not a guarantee. It cannot recognize every secret and
is not a reason to relax the rule that secrets do not belong in a repository.

The timeline records **redaction counts only** — never values, and never the
payload. The payload goes to the reviewer's raw log, beside the worker's
transcript, outside the repository.

## Verdicts

```
PASS               REVIEWING -> AWAITING_APPROVAL
REVISION_REQUIRED  -> REVISION_REQUIRED, findings queued for the worker
STOP               -> STOPPED, attributed to the reviewer
```

A reviewer returns `{verdict, summary, findings[], completion_gates[]}` and
nothing else. Findings carry `title`, `detail`, `severity`, `target`.

**PASS is not approval.** It moves the run to a human, who approves or rejects.
There is no reviewer verdict anywhere that reaches `COMPLETED`.

**Release eligibility comes from the gates, not the verdict.** A `PASS` with a
failing required gate is still `BLOCKED`.

**STOP lands on STOPPED, not FAILED.** A reviewer deciding a run should not
continue is a supervisory decision, like an operator's stop — not an execution
fault. `stop_reason` records the attribution:
`Stopped by independent review (<reviewer>): <summary>`.

### An unparseable reply is not a verdict

It is tempting to default a broken reply to `PASS` (nothing was reported) or
`REVISION_REQUIRED` (something went wrong). Both are lies about what the
reviewer said. A review that could not be produced leaves the run **exactly
where it was**, records `review.failed`, and returns `502`. No `build_reviews`
row is written.

The same applies to an unavailable reviewer (`503`) and to a run that moved
while it was being reviewed (`409`).

## The revision loop

`REVISION_REQUIRED` turns the findings into an instruction and **queues** it —
it does not restart the worker.

```
review.completed (REVISION_REQUIRED)
  └─ run.revision_requested   findings queued, instruction recorded
       └─ operator: POST /api/build-runs/:id/instruct
            └─ dispatch resumes the SAME worker session, carrying the findings
```

Leaving `REVISION_REQUIRED` is an operator decision. A reviewer that could
restart a worker would be driving the run rather than judging it — and
supervision means a human chooses to continue. The findings ride the next
dispatch, in the same resumable session, so the worker keeps its context.

The queue is per-process and does not survive an API restart; the worker
session id does, because it lives on the timeline.

## Events

| Event | Meaning |
| --- | --- |
| `review.started` | A review began. Carries redaction counts, event/file counts, context file names. |
| `review.completed` | The verdict, the reviewer, its version, finding count, release status, metrics. |
| `review.failed` | No verdict was produced. The run did not move. |
| `review.verdict_ignored` | A verdict arrived for a run that had already moved. |
| `run.revision_requested` | Findings queued for the worker's next dispatch. |

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `AICONNECT_REVIEWER_PROVIDER` | `claude_code_reviewer` | Which adapter to use. |
| `AICONNECT_REVIEWER_MODEL` | provider default | Model override. |
| `AICONNECT_REVIEWER_TIMEOUT_MS` | `600000` (10 min) | Ceiling on one review. |
| `AICONNECT_REVIEWER_CONTEXT_FILES` | none | Comma-separated workspace-relative policy/architecture files. |

Context file paths are containment-checked against the workspace: a configured
path cannot reach outside the repository.

The reviewer's child process gets the same filtered environment as the worker's
— `DATABASE_URL`, `MASTER_KEY`, Auth0/Stripe/GitHub/Cloudflare values, the
whole `AICONNECT_` namespace and anything matching `SECRET`/`TOKEN`/`PASSWORD`/
`_KEY` are stripped. `ANTHROPIC_API_KEY` is the one credential passed through.
Asserted in `childEnv.test.ts`.

## Testing

| Command | Covers | Cost |
| --- | --- | --- |
| `pnpm test` | Verdict parsing (including refusing to guess), redaction, the reviewer's argument vector and policy, child-env filtering. | free |
| `pnpm test:integration` | Real routes and database with a **scripted reviewer**: every verdict's transition, `build_reviews` persistence, release gating, the revision queue reaching the same session, failed reviews leaving the run alone, org isolation. | free |
| `pnpm --filter @ai-connect/api smoke:runner` | A **real** worker followed by a **real** reviewer, end to end. | real money |

## Known gaps

- **One reviewer, one pass.** No second opinion, no reviewer disagreement
  handling, no re-review after revisions beyond running it again.
- **The reviewer sees the workspace as it is now**, not as it was at the base
  commit. For a single-dispatch run these are the same; after several
  dispatches the diff is cumulative, which is what a reviewer should see anyway.
- **No reviewer cost budget.** The timeout bounds wall clock, not spend.
