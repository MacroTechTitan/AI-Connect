# The Build Control runner

Build Control supervises work. The runner is the part that actually causes work
to happen: when an operator starts a Build Run, it dispatches a Claude Code
process, turns what that process emits into a supervision timeline, and moves
the run to review when the worker is done.

This document covers what it does, what it deliberately does **not** do, and
where the boundaries are.

## Layout

| File | Responsibility |
| --- | --- |
| `routes/buildRuns.ts` | Operator-driven transitions. Owns start/pause/resume/stop/instruct/review/approve/reject. |
| `lib/buildControl/runnerService.ts` | Worker-driven transitions. Owns `RUNNING → REVIEWING` on completion, `→ FAILED` on execution fault, plus `current_activity`, the event timeline, and diff statistics. |
| `lib/buildControl/worker/types.ts` | The `BuildWorker` interface — the adapter boundary. |
| `lib/buildControl/worker/claudeCodeAdapter.ts` | The only file that knows Claude Code exists. |
| `lib/buildControl/worker/normalize.ts` | Claude's stream frames → Build Control events. Pure. |
| `lib/buildControl/worker/workspace.ts` | The execution boundary and git measurement. |
| `lib/buildControl/worker/prompt.ts` | The supervision policy and the task brief. |
| `lib/buildControl/worker/resolveBinary.ts` | Finding a spawnable Claude Code executable. |
| `lib/buildControl/worker/registry.ts` | `worker_type` → adapter. |

Nothing Claude-specific reaches the routes. A second worker implements
`BuildWorker`, registers itself, and nothing above that line changes.

## Enabling it

The runner spawns processes on the host, so it is **off unless two variables
are both set**. An API instance that is not meant to execute anything is never
one flag away from doing so, and on Render both are unset.

```bash
AICONNECT_RUNNER_ENABLED=1
AICONNECT_RUNNER_WORKSPACE_ROOT=/absolute/path/to/authorized/repos
```

Optional:

| Variable | Default | Purpose |
| --- | --- | --- |
| `CLAUDE_CODE_BIN` | resolved from `PATH` | Explicit executable. A `.js` path is run with the current node. |
| `AICONNECT_RUNNER_LOG_DIR` | `<tmp>/ai-connect-runs` | Raw transcripts. Kept out of the repository on purpose. |
| `AICONNECT_RUNNER_TIMEOUT_MS` | `1800000` (30 min) | Hard ceiling on one dispatch. |
| `AICONNECT_RUNNER_MODEL` | worker default | Model override. |

`GET /api/build-runs/runner` reports whether starting a run will dispatch
anything on this instance, and what the worker can do — so an operator finds
out *before* starting a run rather than by watching nothing happen.

## How Claude Code is invoked

The CLI is spawned as a child process. No SDK, no new dependency, no shell:

```
claude --print
       --output-format stream-json --verbose
       --session-id <uuid>       (first dispatch)
       --resume <uuid>           (every later dispatch)
       --permission-mode acceptEdits
       --allowedTools  Read Write Edit Glob Grep Bash TodoWrite NotebookEdit
       --disallowedTools WebFetch WebSearch Task ... Bash(git push:*) ...
       --add-dir <workspace>
       --append-system-prompt <supervision policy>
       <task prompt>                       ← positional, always last
```

- **`--print` + `stream-json` + `--verbose`.** Without `--verbose` the CLI emits
  only a final result and the timeline would be empty.
- **`--session-id` on the first dispatch.** Build Control assigns the session
  identifier rather than discovering it, so resuming is deterministic.
- **`shell: false`, always.** The prompt is operator-authored text; a shell
  would re-interpret it. It is passed positionally and last so nothing in it
  can be read as a flag.
- **stdin is closed.** A supervised run must never block on terminal input
  nobody will answer.
- **The child's environment is filtered**, not inherited: `DATABASE_URL`,
  `MASTER_KEY`, Auth0/Stripe/GitHub/Cloudflare credentials and anything
  matching `SECRET`/`TOKEN`/`PASSWORD`/`_KEY` are removed. `ANTHROPIC_API_KEY`
  is the one credential passed through, and only because the worker needs it.

### Finding the binary

`spawn("claude", …)` is not portable. On Windows the `claude` on `PATH` is a
`.cmd` shim plus an extension-less shell script, and Node has refused to spawn
`.cmd` without a shell since the CVE-2024-27980 fix. Turning on `shell: true`
would fix the spawn and reintroduce shell interpretation of every argument.

`resolveBinary.ts` instead resolves to a real executable: a `.exe` on `PATH`,
or the npm layout the shim points at
(`<npm-prefix>/node_modules/@anthropic-ai/claude-code/bin/claude.exe`). If it
cannot, the runner reports itself unavailable with a reason, before a run
starts.

## Security boundaries

Three layers, in decreasing order of strength. Only the first two are real
boundaries; the third is a courtesy to a well-behaved worker.

**1. The workspace.** `workspace.ts` resolves every path through `realpath` and
requires it to be inside `AICONNECT_RUNNER_WORKSPACE_ROOT`. Containment is
checked with `path.relative`, not `startsWith`, so `/srv/repos-evil` is not
accepted as being inside `/srv/repos`. A symlink pointing out of the root is
rejected. The process is spawned with `cwd` set to the workspace and
`--add-dir` naming only that. **A run cannot choose its own workspace** — the
create route does not accept a path.

**2. The tool list.** Dangerous verbs are removed, not discouraged:
`WebFetch`, `WebSearch`, `Task`, and by command prefix `git push`, `git remote`,
`gh pr`, `gh release`, `npm/pnpm/yarn publish`, `vercel`, `render`, `fly`,
`heroku`, `kubectl`, `docker push`, `terraform`, `aws`, `gcloud`, `supabase`,
`psql`, migration commands, and the network reach-arounds `curl`, `wget`,
`ssh`, `scp`. `--permission-mode` is `acceptEdits`; permission bypass is never
enabled.

**3. The supervision policy** (`prompt.ts`), appended to the system prompt on
every dispatch including resumes. It states the prohibitions — no merging,
deploying, production access, secret handling, self-approval, or altering Build
Control — and the stop-and-ask policy: destructive commands, migration
execution, security/auth changes, dependency changes, and scope expansion, plus
the run's own `stop_and_ask` list. **This is prose addressed to a model and is
the weakest layer.** It exists so a well-behaved worker stops and asks; it is
not what makes any of this safe.

### What the worker structurally cannot do

`FAILED` and `REVIEWING` are the only states a worker can reach. There is no
worker action that produces `COMPLETED` or `AWAITING_APPROVAL`, so a worker
cannot review or approve its own work, and cannot advance a run past a gate
that belongs to a person. This is enforced by the transition table and asserted
in `workerTransitions.test.ts`.

## Lifecycle

```
start     → dispatch a worker            RUNNING
worker completes                         RUNNING → REVIEWING     (runner)
worker faults                            → FAILED                (runner)
operator stops                           → STOPPED               (operator)
```

`STOPPED` is reserved for an operator's decision and `FAILED` for an execution
fault. The runner never writes `stop_reason` — the failure cause goes on the
`run.failed` event and into `current_activity`.

### Events

`build_events` is a supervision timeline, not a transcript. Raw NDJSON goes to
the run's raw log; what lands in the database is the subset an operator would
scroll.

| Event | Emitted by | Meaning |
| --- | --- | --- |
| `run.dispatch_started` | runner | A worker is being dispatched. Carries workspace, branch, base commit. |
| `worker.session_started` | adapter | The real session announced itself: model, cwd, permission mode. |
| `worker.message` | adapter | Assistant text, truncated. |
| `worker.tool_use` | adapter | One per tool call. `info` for notable tools, `debug` for read-only lookups. |
| `worker.tool_error` | adapter | A tool call failed. |
| `worker.permission_denied` | adapter | The boundary held. `action_required`. |
| `worker.rate_limited` | adapter | Genuine throttling only. |
| `worker.unparsable_output` | adapter | A stdout line that was not JSON. Recorded, never dropped. |
| `worker.completed` / `worker.failed` / `worker.cancelled` | adapter | How the process ended. |
| `run.dispatch_finished` | runner | Outcome, session id, base commit, raw log path. |
| `run.diff_captured` / `run.diff_unavailable` | runner | Measured file and line counts, or an honest admission. |
| `run.worker_completed` | runner | `RUNNING → REVIEWING`. |
| `run.failed` | runner | `→ FAILED`, with cause and kind. |
| `run.pause_deferred` | runner | Pause could not interrupt the dispatch in flight. |
| `run.instruction_queued` | runner | An instruction is waiting for the next dispatch. |
| `run.worker_outcome_ignored` | runner | A worker outcome arrived too late to apply. |

### Measurement, never estimation

Cost, tokens, turns and durations are written **only when the worker reported
them**. A run whose worker reported no cost stores `NULL`, not `0.00`.
Similarly, a binary file whose line count git cannot determine is listed in
`unmeasured` rather than counted as zero, and a diff that cannot be computed
produces `run.diff_unavailable` rather than a confident "0 files changed".

Diff statistics are measured against the run's base commit, recorded on the
first dispatch, so they cover the whole run rather than only its last dispatch.
Untracked files are counted explicitly — a plain `git diff` does not see them,
and `git add -N` would mutate the operator's index to find out.

## Session, pause, and instructions — the honest limits

The adapter reports its capabilities and Build Control adapts to them rather
than pretending. `GET /api/build-runs/runner` returns them.

| Capability | Claude Code | Consequence |
| --- | --- | --- |
| `resumableSessions` | **yes** | Every dispatch after the first uses `--resume`, continuing the same conversation. The session id is recovered from the `run.dispatch_finished` event, not from process memory, so a restarted API can still continue a run. |
| `cancellable` | **yes** | Stop kills the process tree (`taskkill /T /F` on Windows, `SIGTERM` then `SIGKILL` elsewhere). |
| `midDispatchInstructions` | **no** | See below. |
| `midDispatchPause` | **no** | See below. |

### Pause does not interrupt a dispatch

A `claude -p` dispatch runs autonomously to completion. There is no supported
suspend/continue, and `SIGSTOP` would strand in-flight API requests rather than
pausing anything cleanly.

**So pause takes effect at the dispatch boundary.** The run moves to `PAUSED`
immediately, and no further dispatch starts — but a dispatch already in flight
finishes. When that happens the runner records `run.pause_deferred` saying so
explicitly, rather than letting an operator believe work stopped. An operator
who needs work to stop *now* should use stop, which really does kill the
process.

### Instructions are queued, and say when they will arrive

For the same reason, an instruction cannot reach a worker mid-dispatch.

- **Nothing in flight** (`PAUSED`, `REVISION_REQUIRED`, or between dispatches):
  the instruction is delivered immediately by dispatching a continuation of the
  session.
- **A dispatch in flight**: the instruction is queued and `run.instruction_queued`
  records that it will be delivered when the current dispatch finishes. The
  runner then dispatches again, with the queued instructions, instead of
  sending the run to review — so a half-instructed run never reaches a
  reviewer.

The route's event says the instruction was **recorded**, not delivered, because
which of these happened is the runner's to report.

## Testing

| Command | What it covers | Cost |
| --- | --- | --- |
| `pnpm test` | Normalization, the transition table, the argument vector and security flags, workspace containment, binary resolution. No database, no network. | free |
| `pnpm test:integration` | Real routes, real Postgres, real state machine, with a **scripted worker**: dispatch, completion, failure, cancellation, pause honesty, instruction queueing, session resume, diff capture, workspace violation. | free |
| `pnpm --filter @ai-connect/api smoke:runner` | A **real Claude Code process** in a disposable git repository. Proves the events Build Control normalizes are the events Claude Code actually emits, and that the run reaches `REVIEWING`. | real money |

The live smoke is deliberately not a vitest test: it spawns a real worker,
costs money, and needs a Claude Code login, none of which belongs in a suite
someone runs by reflex. `test:integration` covers the same wiring
deterministically and for free.

## Known gaps

- **The workspace is read from `build_runs.worktree_path`**, which nothing
  currently sets — projects do not yet carry a repository path. Until Project
  Genesis provides one, it is set out of band. A run with no workspace it can
  resolve inside the authorized root fails with `workspace_violation`, which is
  the correct failure but not yet a good operator experience.
- **The failure cause lives on the `run.failed` event and in
  `current_activity`**, not in a dedicated column. `stop_reason` was left alone
  on purpose — it means "why an operator stopped this". A `failure_reason`
  column would be cleaner and needs a migration.
- **Live run state is per-process.** Queued instructions and pause intent do
  not survive an API restart; the session id and base commit do, because they
  are on the timeline.
- **No independent reviewer.** A completed run sits in `REVIEWING` until a
  reviewer posts a verdict. That is the next slice, not this one.
