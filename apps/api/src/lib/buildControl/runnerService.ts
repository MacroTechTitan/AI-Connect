// The runner service: everything between "a worker said something" and "the
// Build Run row changed".
//
// Division of responsibility, which is the whole point of this file:
//
//   routes/buildRuns.ts   operator-driven transitions. Owns start/pause/
//                         resume/stop/instruct/review/approve/reject.
//   runnerService.ts      worker-driven transitions. Owns RUNNING -> REVIEWING
//                         on completion and -> FAILED on execution fault, plus
//                         current_activity, the event timeline, and diff stats.
//   worker/*              how a particular worker executes. Knows nothing
//                         about the database.
//
// A dispatch is fire-and-forget from the route's perspective: `start` returns
// as soon as the run is RUNNING, and the worker reports in over the timeline.
// Every path out of a dispatch — success, failure, cancellation, a bug in the
// adapter — ends in a persisted state, so a run cannot be left RUNNING with
// nothing running.

import { and, asc, desc, eq } from "drizzle-orm";

import { getDb } from "../../db/client.js";
import { buildEvents, buildRuns } from "../../db/schema.js";
import { env } from "../env.js";
import { logSystem } from "../logging.js";
import {
  isTerminalState,
  nextState,
  type BuildRunState,
  type BuildRunWorkerAction,
} from "./stateMachine.js";
import { getWorker } from "./worker/registry.js";
import {
  branchNameForRun,
  diffStats,
  ensureBranch,
  headCommit,
  resolveWorkspace,
  WorkspaceViolationError,
} from "./worker/workspace.js";
import type {
  DispatchReason,
  NormalizedEvent,
  WorkerOutcome,
  WorkerRunContext,
  WorkerSink,
} from "./worker/types.js";

/** How often current_activity is written. The timeline keeps every event. */
const ACTIVITY_THROTTLE_MS = 1_500;

// ---------------------------------------------------------------------------
// Live, per-process run state
// ---------------------------------------------------------------------------
//
// Durable facts (session id, base commit) live in build_events, so a restart
// can still resume a session. What lives here is only what is meaningless
// after a restart anyway: whether a dispatch is in flight in THIS process, and
// instructions queued for a dispatch that this process is running.

interface LiveRun {
  dispatching: boolean;
  /** Operator paused; no further dispatch until resumed. */
  paused: boolean;
  /** Instructions waiting for the next dispatch, oldest first. */
  queued: string[];
  /** Set when a dispatch should immediately re-dispatch on completion. */
  redispatchReason: DispatchReason | null;
}

const live = new Map<string, LiveRun>();

function liveFor(runId: string): LiveRun {
  let entry = live.get(runId);
  if (!entry) {
    entry = { dispatching: false, paused: false, queued: [], redispatchReason: null };
    live.set(runId, entry);
  }
  return entry;
}

function forget(runId: string): void {
  live.delete(runId);
}

// ---------------------------------------------------------------------------
// Public surface — what routes call
// ---------------------------------------------------------------------------

export interface RunnerStatus {
  enabled: boolean;
  reason?: string;
  workerType: string;
  capabilities?: ReturnType<typeof describeCapabilities>;
}

function describeCapabilities(workerType: string) {
  const worker = getWorker(workerType);
  return worker ? { ...worker.capabilities } : undefined;
}

export function runnerStatus(workerType = "claude_code"): RunnerStatus {
  const worker = getWorker(workerType);
  if (!worker) {
    return { enabled: false, reason: `unknown worker type '${workerType}'`, workerType };
  }
  const availability = worker.availability();
  return {
    enabled: availability.available,
    ...(availability.reason ? { reason: availability.reason } : {}),
    workerType,
    capabilities: describeCapabilities(workerType),
  };
}

/**
 * The run row the runner needs. Passed in by the route, which has just read
 * and updated it, so the runner does not re-read what it was handed.
 */
export interface RunSnapshot {
  id: string;
  organizationId: string;
  projectId: string;
  workerType: string;
  title: string;
  goal: string;
  acceptanceCriteria: unknown;
  outOfScope: unknown;
  stopAndAsk: unknown;
  featureId: string | null;
  featureWorkPacket: unknown;
  branchName: string | null;
  worktreePath: string | null;
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Called after a run transitions to RUNNING. Returns immediately; the dispatch
 * continues in the background and reports over the timeline.
 *
 * A disabled runner is not an error — it is the documented state of every
 * cloud instance. `start` then behaves exactly as it did before the runner
 * existed, and says so once on the timeline rather than silently doing nothing.
 */
export function onRunStarted(run: RunSnapshot, reason: DispatchReason = "start"): void {
  // A disabled runner is silent, not an event. Writing "nothing happened" onto
  // every start would put noise on the timeline of every cloud instance, and
  // an async write racing the operator's response would make the timeline
  // non-deterministic. GET /api/build-runs/runner answers this question
  // properly, before an operator starts a run rather than after.
  if (!runnerStatus(run.workerType).enabled) return;

  const entry = liveFor(run.id);
  if (entry.dispatching) {
    // A dispatch is already in flight; whatever prompted this will be picked
    // up when it finishes.
    entry.redispatchReason = reason;
    return;
  }
  entry.paused = false;

  void dispatchLoop(run, reason).catch((err) => {
    void logSystem("error", "build_control_runner", "dispatch loop crashed", {
      run_id: run.id,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

/** Operator paused. Records the honest scope of what that means for this worker. */
export function onRunPaused(run: RunSnapshot): void {
  if (!runnerStatus(run.workerType).enabled) return;

  const entry = liveFor(run.id);
  entry.paused = true;
  entry.redispatchReason = null;

  const worker = getWorker(run.workerType);
  if (!worker) return;

  if (entry.dispatching && !worker.capabilities.midDispatchPause) {
    // Say so plainly rather than letting an operator believe work stopped.
    void recordEvent(run, {
      eventType: "run.pause_deferred",
      summary:
        "Run paused — the worker cannot be suspended mid-dispatch, so the current dispatch will finish and no further work will start",
      severity: "warn",
      actionRequired: false,
      details: {
        worker_type: run.workerType,
        mid_dispatch_pause_supported: false,
      },
    });
  }
}

/** Operator resumed. Dispatches a continuation of the existing session. */
export function onRunResumed(run: RunSnapshot): void {
  if (!runnerStatus(run.workerType).enabled) return;
  liveFor(run.id).paused = false;
  onRunStarted(run, "resume");
}

/** Operator stopped. Cancels a live worker process if there is one. */
export function onRunStopped(run: RunSnapshot): void {
  if (!runnerStatus(run.workerType).enabled) return;

  const entry = liveFor(run.id);
  entry.paused = true;
  entry.queued = [];
  entry.redispatchReason = null;

  const worker = getWorker(run.workerType);
  const cancelled = worker?.cancel(run.id) ?? false;

  if (!cancelled) {
    forget(run.id);
    return;
  }

  void recordEvent(run, {
    eventType: "run.dispatch_cancelled",
    summary: "Worker process cancelled",
    severity: "info",
    details: { worker_type: run.workerType },
  });
}

/**
 * Operator instruction. This worker cannot take one mid-dispatch, so the
 * honest behaviour is to queue it and say exactly when it will be consumed —
 * not to claim it was delivered.
 */
export function onRunInstruction(
  run: RunSnapshot,
  instruction: string,
  currentState: BuildRunState,
): void {
  const status = runnerStatus(run.workerType);
  if (!status.enabled) return;

  const worker = getWorker(run.workerType);
  const entry = liveFor(run.id);
  entry.queued.push(instruction);

  const dispatching = worker?.isDispatching(run.id) ?? false;

  if (dispatching && !worker?.capabilities.midDispatchInstructions) {
    void recordEvent(run, {
      eventType: "run.instruction_queued",
      summary:
        "Instruction queued — it will be delivered to the worker as soon as the current dispatch finishes",
      severity: "info",
      actionRequired: false,
      details: {
        queued_count: entry.queued.length,
        mid_dispatch_instructions_supported: false,
      },
    });
    entry.redispatchReason = "instruction";
    return;
  }

  if (entry.paused) {
    void recordEvent(run, {
      eventType: "run.instruction_queued",
      summary: "Instruction queued — it will be delivered when the run is resumed",
      severity: "info",
      details: { queued_count: entry.queued.length, paused: true },
    });
    return;
  }

  // Nothing in flight: deliver it now by continuing the session. An instruct
  // from REVISION_REQUIRED has already moved the run back to RUNNING.
  onRunStarted(run, currentState === "REVISION_REQUIRED" ? "revision" : "instruction");
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function dispatchLoop(run: RunSnapshot, reason: DispatchReason): Promise<void> {
  const entry = liveFor(run.id);
  let nextReason: DispatchReason | null = reason;

  while (nextReason !== null) {
    const current: DispatchReason = nextReason;
    nextReason = null;
    entry.redispatchReason = null;

    const finished = await dispatchOnce(run, current);
    if (!finished.continueLoop) break;

    if (entry.paused) break;
    if (entry.redispatchReason) {
      nextReason = entry.redispatchReason;
    } else if (entry.queued.length > 0) {
      nextReason = "instruction";
    }
  }
}

async function dispatchOnce(
  run: RunSnapshot,
  reason: DispatchReason,
): Promise<{ continueLoop: boolean }> {
  const entry = liveFor(run.id);
  const worker = getWorker(run.workerType);
  if (!worker) {
    await failRun(run, `unknown worker type '${run.workerType}'`, "internal");
    return { continueLoop: false };
  }

  entry.dispatching = true;
  const sink = createSink(run);

  try {
    // --- workspace -------------------------------------------------------
    const branch = run.branchName ?? branchNameForRun(run.id, run.title);
    let workspace;
    try {
      workspace = resolveWorkspace({
        allowedRoot: env.AICONNECT_RUNNER_WORKSPACE_ROOT,
        repoPath: run.worktreePath ?? env.AICONNECT_RUNNER_WORKSPACE_ROOT ?? "",
        branch,
      });
      await ensureBranch(workspace.repoRoot, workspace.branch);
    } catch (err) {
      const cause =
        err instanceof WorkspaceViolationError
          ? err.message
          : `workspace could not be prepared: ${err instanceof Error ? err.message : String(err)}`;
      await sink.flush();
      await failRun(run, cause, "workspace_violation");
      return { continueLoop: false };
    }

    const sessionId = await findSessionId(run.id);
    const baseCommit = (await findBaseCommit(run.id)) ?? (await headCommit(workspace.repoRoot));

    // Record the branch and workspace on the run the first time we resolve them.
    if (run.branchName !== workspace.branch || run.worktreePath !== workspace.repoRoot) {
      await getDb()
        .update(buildRuns)
        .set({ branchName: workspace.branch, worktreePath: workspace.repoRoot, updatedAt: new Date() })
        .where(eq(buildRuns.id, run.id));
      run.branchName = workspace.branch;
      run.worktreePath = workspace.repoRoot;
    }

    // --- instructions ----------------------------------------------------
    // Taken before dispatch so an instruction arriving mid-dispatch is queued
    // for the NEXT one rather than silently dropped.
    const instructions = entry.queued.splice(0, entry.queued.length);

    const ctx: WorkerRunContext = {
      runId: run.id,
      organizationId: run.organizationId,
      projectId: run.projectId,
      title: run.title,
      goal: run.goal,
      acceptanceCriteria: asStringList(run.acceptanceCriteria),
      outOfScope: asStringList(run.outOfScope),
      stopAndAsk: asStringList(run.stopAndAsk),
      featureId: run.featureId,
      featureWorkPacket:
        run.featureWorkPacket && typeof run.featureWorkPacket === "object"
          ? (run.featureWorkPacket as Record<string, unknown>)
          : null,
      workspace,
      sessionId,
      instructions,
      reason,
    };

    // --- run it ----------------------------------------------------------
    // Emitted HERE rather than in the adapter: it is a Build Control lifecycle
    // event, and an adapter that forgot it would silently break the timeline.
    await recordEvent(run, {
      eventType: "run.dispatch_started",
      summary:
        sessionId === null
          ? `Dispatching ${run.workerType} worker`
          : `Continuing ${run.workerType} session`,
      severity: "info",
      details: {
        worker_type: run.workerType,
        reason,
        resumed: sessionId !== null,
        session_id: sessionId,
        workspace: workspace.repoRoot,
        branch: workspace.branch,
        base_commit: baseCommit,
        instruction_count: instructions.length,
      },
    });

    let outcome: WorkerOutcome;
    try {
      outcome = await worker.dispatch(ctx, sink.sink);
    } catch (err) {
      outcome = {
        status: "failed",
        failureKind: "internal",
        failureCause: `adapter threw: ${err instanceof Error ? err.message : String(err)}`,
        sessionId,
        metrics: {},
      };
    }

    // Record the base commit on the first dispatch so later diffs measure the
    // whole run rather than only the last dispatch.
    // session_id and base_commit are recorded here because this is the event
    // findSessionId() and findBaseCommit() read: the run's memory of its own
    // worker lives on the timeline, so a restarted API can still resume it.
    await recordEvent(run, {
      eventType: "run.dispatch_finished",
      summary: `Dispatch finished: ${outcome.status}`,
      severity: outcome.status === "failed" ? "error" : "info",
      details: {
        status: outcome.status,
        reason,
        session_id: outcome.sessionId,
        base_commit: baseCommit,
        raw_log: outcome.rawLogPath ?? null,
        ...(outcome.failureCause ? { failure_cause: outcome.failureCause } : {}),
      },
    });

    await sink.flush();

    // --- capture what actually changed -----------------------------------
    await captureWorkspaceResults(run, workspace.repoRoot, baseCommit, outcome);

    // --- apply the outcome ------------------------------------------------
    if (outcome.status === "cancelled") {
      // The operator's stop already moved the run to STOPPED. Nothing here.
      return { continueLoop: false };
    }

    if (outcome.status === "failed") {
      await failRun(run, outcome.failureCause ?? "worker failed", outcome.failureKind ?? "internal");
      return { continueLoop: false };
    }

    // Completed. If more work was queued while this dispatch ran, keep the run
    // RUNNING and go round again instead of sending a half-instructed run to
    // review.
    if (!entry.paused && (entry.redispatchReason !== null || entry.queued.length > 0)) {
      return { continueLoop: true };
    }

    await completeRun(run, outcome);
    return { continueLoop: false };
  } finally {
    entry.dispatching = false;
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Buffers timeline writes behind a single promise chain. Events arrive from a
 * stream faster than Postgres round-trips, and firing inserts concurrently
 * would let occurred_at ordering scramble. Each event is stamped when it
 * happens, then written in order.
 */
function createSink(run: RunSnapshot) {
  let chain: Promise<unknown> = Promise.resolve();
  let lastActivityWrite = 0;
  let pendingActivity: string | null = null;

  const sink: WorkerSink = {
    event(event: NormalizedEvent) {
      const stamped = { ...event, occurredAt: event.occurredAt ?? new Date() };
      chain = chain.then(() => recordEvent(run, stamped)).catch(() => undefined);
    },
    activity(text: string) {
      pendingActivity = text;
      const now = Date.now();
      if (now - lastActivityWrite < ACTIVITY_THROTTLE_MS) return;
      lastActivityWrite = now;
      const value = pendingActivity;
      chain = chain.then(() => writeActivity(run.id, value)).catch(() => undefined);
    },
  };

  return {
    sink,
    /** Drains the queue and writes the final activity, if one is outstanding. */
    async flush(): Promise<void> {
      if (pendingActivity !== null) {
        const value = pendingActivity;
        pendingActivity = null;
        chain = chain.then(() => writeActivity(run.id, value)).catch(() => undefined);
      }
      await chain;
    },
  };
}

async function recordEvent(run: RunSnapshot, event: NormalizedEvent): Promise<void> {
  try {
    await getDb()
      .insert(buildEvents)
      .values({
        organizationId: run.organizationId,
        projectId: run.projectId,
        buildRunId: run.id,
        eventType: event.eventType,
        summary: event.summary.slice(0, 2000),
        worker: run.workerType,
        affectedTarget: event.affectedTarget ?? null,
        severity: event.severity ?? "info",
        actionRequired: event.actionRequired ?? false,
        details: event.details ?? null,
        ...(event.occurredAt ? { occurredAt: event.occurredAt } : {}),
      });
  } catch (err) {
    // The timeline is observability, not the transaction. A failed insert must
    // never take down a running dispatch.
    await logSystem("warn", "build_control_runner", "failed to record build event", {
      run_id: run.id,
      event_type: event.eventType,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function writeActivity(runId: string, text: string): Promise<void> {
  try {
    await getDb()
      .update(buildRuns)
      .set({ currentActivity: text.slice(0, 500), updatedAt: new Date() })
      .where(eq(buildRuns.id, runId));
  } catch {
    /* activity is a nicety; never fail a dispatch over it */
  }
}

/**
 * The session id to resume, recovered from the timeline rather than held in
 * memory, so a restarted API can still continue a worker's conversation.
 */
export async function findSessionId(runId: string): Promise<string | null> {
  // Read from dispatch_finished, not dispatch_started: on a fresh run the
  // worker generates its own session id, so only the outcome knows it.
  const rows = await getDb()
    .select({ details: buildEvents.details })
    .from(buildEvents)
    .where(
      and(
        eq(buildEvents.buildRunId, runId),
        eq(buildEvents.eventType, "run.dispatch_finished"),
      ),
    )
    .orderBy(desc(buildEvents.occurredAt))
    .limit(5);

  for (const row of rows) {
    const details = row.details as Record<string, unknown> | null | undefined;
    const sessionId = details?.session_id;
    if (typeof sessionId === "string" && sessionId.length > 0) return sessionId;
  }
  return null;
}

/** The commit the run started from — the baseline every diff stat measures against. */
async function findBaseCommit(runId: string): Promise<string | null> {
  const rows = await getDb()
    .select({ details: buildEvents.details })
    .from(buildEvents)
    .where(
      and(
        eq(buildEvents.buildRunId, runId),
        eq(buildEvents.eventType, "run.dispatch_finished"),
      ),
    )
    .orderBy(asc(buildEvents.occurredAt))
    .limit(1);

  const details = rows[0]?.details as Record<string, unknown> | null | undefined;
  const base = details?.base_commit;
  return typeof base === "string" ? base : null;
}

/**
 * Records what the worker actually did to the repository. Everything here is
 * measured, never estimated: when a count cannot be determined the run says so
 * rather than reporting a confident zero.
 */
async function captureWorkspaceResults(
  run: RunSnapshot,
  repoRoot: string,
  baseCommit: string,
  outcome: WorkerOutcome,
): Promise<void> {
  const patch: Record<string, unknown> = { updatedAt: new Date() };

  try {
    const stats = await diffStats(repoRoot, baseCommit);
    patch.filesChanged = stats.filesChanged;
    patch.additions = stats.additions;
    patch.deletions = stats.deletions;

    await recordEvent(run, {
      eventType: "run.diff_captured",
      summary: `${stats.filesChanged.length} file(s) changed, +${stats.additions}/-${stats.deletions}${
        stats.partial ? " (some files unmeasurable)" : ""
      }`,
      severity: "info",
      details: {
        files_changed: stats.filesChanged,
        additions: stats.additions,
        deletions: stats.deletions,
        base_commit: baseCommit,
        partial: stats.partial,
        unmeasured: stats.unmeasured,
      },
    });
  } catch (err) {
    // A diff we could not compute is reported as uncomputed. It is NOT written
    // as zeroes — a fabricated "0 files changed" would be a lie about the work.
    await recordEvent(run, {
      eventType: "run.diff_unavailable",
      summary: "Diff statistics could not be captured for this run",
      severity: "warn",
      details: { error: err instanceof Error ? err.message : String(err) },
    });
  }

  // Cost is written only when the worker actually reported one.
  if (outcome.metrics.costUsd !== undefined) {
    patch.costUsd = outcome.metrics.costUsd.toFixed(6);
  }

  try {
    await getDb().update(buildRuns).set(patch).where(eq(buildRuns.id, run.id));
  } catch (err) {
    await logSystem("warn", "build_control_runner", "failed to record workspace results", {
      run_id: run.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Worker-owned transitions
// ---------------------------------------------------------------------------

/**
 * Applies a worker-owned transition. Guarded by the same state machine the
 * routes use, and predicated on the run still being in the state we read — so
 * a worker finishing at the same moment an operator stops the run cannot
 * overwrite the operator's decision.
 */
async function applyWorkerTransition(
  run: RunSnapshot,
  action: BuildRunWorkerAction,
  event: NormalizedEvent,
  extraRunValues: Record<string, unknown> = {},
): Promise<boolean> {
  const [current] = await getDb()
    .select({ state: buildRuns.state })
    .from(buildRuns)
    .where(eq(buildRuns.id, run.id))
    .limit(1);

  if (!current) return false;
  const from = current.state as BuildRunState;

  if (isTerminalState(from)) {
    // The operator got there first. Record why the worker's ending is being
    // dropped rather than silently discarding it.
    await recordEvent(run, {
      eventType: "run.worker_outcome_ignored",
      summary: `Worker reported '${action}' but the run is already ${from}`,
      severity: "info",
      details: { attempted: action, current_state: from },
    });
    forget(run.id);
    return false;
  }

  const transition = nextState({ state: from, action });
  if (!transition.ok) {
    await recordEvent(run, {
      eventType: "run.worker_outcome_ignored",
      summary: `Worker reported '${action}', which is not legal from ${from}`,
      severity: "warn",
      details: { attempted: action, current_state: from, reason: transition.reason },
    });
    return false;
  }

  const now = new Date();
  const [updated] = await getDb()
    .update(buildRuns)
    .set({
      state: transition.nextState,
      updatedAt: now,
      ...(isTerminalState(transition.nextState) ? { completedAt: now } : {}),
      ...extraRunValues,
    })
    .where(and(eq(buildRuns.id, run.id), eq(buildRuns.state, from)))
    .returning({ id: buildRuns.id });

  if (!updated) {
    await recordEvent(run, {
      eventType: "run.worker_outcome_ignored",
      summary: `Worker reported '${action}' but the run changed state concurrently`,
      severity: "warn",
      details: { attempted: action, expected_state: from },
    });
    return false;
  }

  await recordEvent(run, {
    ...event,
    details: { ...(event.details ?? {}), from, to: transition.nextState, action },
  });

  if (isTerminalState(transition.nextState)) forget(run.id);
  return true;
}

async function completeRun(run: RunSnapshot, outcome: WorkerOutcome): Promise<void> {
  const summary = outcome.finalMessage
    ? `Worker completed: ${outcome.finalMessage.replace(/\s+/g, " ").trim().slice(0, 250)}`
    : "Worker completed its work";

  await applyWorkerTransition(
    run,
    "complete",
    {
      eventType: "run.worker_completed",
      summary,
      severity: "info",
      // A completed worker is not a completed run — a human still approves it.
      actionRequired: true,
      details: {
        session_id: outcome.sessionId,
        raw_log: outcome.rawLogPath ?? null,
        metrics: outcome.metrics,
      },
    },
    { currentActivity: "Awaiting independent review" },
  );
}

/**
 * The runner-owned path to FAILED. STOPPED is never used here: it records an
 * operator's decision, and an execution fault is not one.
 *
 * The cause is recorded on the run.failed event and mirrored into
 * current_activity so it is visible without opening the timeline.
 * `stop_reason` is deliberately left alone — it belongs to operator stop.
 */
async function failRun(
  run: RunSnapshot,
  cause: string,
  kind: string,
): Promise<void> {
  const flat = cause.replace(/\s+/g, " ").trim();
  await applyWorkerTransition(
    run,
    "fail",
    {
      eventType: "run.failed",
      summary: `Run failed: ${flat.slice(0, 250)}`,
      severity: "error",
      actionRequired: true,
      details: { failure_cause: flat, failure_kind: kind, worker_type: run.workerType },
    },
    { currentActivity: `Failed: ${flat.slice(0, 400)}` },
  );

  await logSystem("error", "build_control_runner", "build run failed", {
    run_id: run.id,
    failure_kind: kind,
    failure_cause: flat,
  });
}

// ---------------------------------------------------------------------------
// Test seam
// ---------------------------------------------------------------------------

/** Clears per-process run state. Tests only. */
export function resetRunnerState(): void {
  live.clear();
}

/** Live view for assertions and diagnostics. Tests only. */
export function inspectRunnerState(runId: string): LiveRun | undefined {
  return live.get(runId);
}
