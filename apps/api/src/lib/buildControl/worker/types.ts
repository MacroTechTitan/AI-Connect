// DevOS Agentic Build Control — the worker-adapter boundary.
//
// Build Control supervises work; it does not know how any particular worker
// executes it. Everything Claude-specific lives behind this interface in
// claudeCodeAdapter.ts, so the routes and the runner service never spawn a
// process, parse a stream, or know that a "session" is a thing Claude has.
//
// The boundary exists because `worker_type` is a column with a CHECK
// constraint that currently permits one value. When a second worker lands, it
// implements BuildWorker and registers itself; nothing above this line changes.

import type { BuildRunState } from "../stateMachine.js";

// ---------------------------------------------------------------------------
// What a worker is told
// ---------------------------------------------------------------------------

/** A repository + branch a worker is authorized to touch, and nothing else. */
export interface ResolvedWorkspace {
  /** Absolute, symlink-resolved path to the repository root. */
  repoRoot: string;
  /** Branch the worker works on. Already checked out by the time a worker sees it. */
  branch: string;
  /** The configured root every workspace must live inside. Recorded for audit. */
  allowedRoot: string;
}

/**
 * Everything a worker needs to do one dispatch. Assembled by the runner
 * service from the build_runs row; a worker never queries the database.
 */
export interface WorkerRunContext {
  runId: string;
  organizationId: string;
  projectId: string;

  title: string;
  goal: string;
  acceptanceCriteria: string[];
  outOfScope: string[];
  stopAndAsk: string[];

  featureId: string | null;
  featureWorkPacket: Record<string, unknown> | null;

  workspace: ResolvedWorkspace;

  /**
   * Worker session to continue, when one exists. Null starts a fresh session.
   * Opaque above this boundary — only the adapter knows what it means.
   */
  sessionId: string | null;

  /**
   * Operator instructions accumulated since the last dispatch, oldest first.
   * A dispatch consumes all of them; the runner clears the queue only once the
   * dispatch has actually been handed to the worker.
   */
  instructions: string[];

  /** Why this dispatch is happening. Shapes the prompt and the timeline. */
  reason: DispatchReason;
}

export type DispatchReason =
  | "start"
  | "resume"
  | "instruction"
  | "revision";

// ---------------------------------------------------------------------------
// What a worker reports
// ---------------------------------------------------------------------------

export type EventSeverity = "debug" | "info" | "warn" | "error" | "critical";

/**
 * A normalized Build Control event. This is the ONLY shape a worker may emit —
 * raw worker output goes to the raw log, never into build_events. Keeping the
 * two apart is what lets the timeline stay readable while the raw transcript
 * stays complete.
 */
export interface NormalizedEvent {
  eventType: string;
  summary: string;
  severity?: EventSeverity;
  actionRequired?: boolean;
  /** Free-form target the event concerns: a file path, a command, a URL. */
  affectedTarget?: string | null;
  details?: Record<string, unknown>;
  occurredAt?: Date;
}

/** Progress signals a worker pushes as it goes. */
export interface WorkerSink {
  /** Persist a normalized event on the run's timeline. */
  event(event: NormalizedEvent): void;
  /** Update the run's one-line "what is happening right now". */
  activity(text: string): void;
}

/**
 * Metrics a worker reports. Every field is optional on purpose: Build Control
 * records what the worker actually measured and nothing else. A worker that
 * cannot report cost reports no cost — it never estimates one.
 */
export interface WorkerMetrics {
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  turns?: number;
  durationMs?: number;
  apiDurationMs?: number;
  model?: string;
  sessionId?: string;
}

export type WorkerStatus =
  /** The worker finished the work it was given. */
  | "completed"
  /** A genuine execution fault: the worker could not finish. */
  | "failed"
  /** The operator cancelled it. Never reported as a failure. */
  | "cancelled";

export interface WorkerOutcome {
  status: WorkerStatus;
  /** Present when status is "failed". Human-readable, never invented. */
  failureCause?: string;
  /** Machine-readable failure class, for filtering the timeline later. */
  failureKind?: WorkerFailureKind;
  /** Session to resume on the next dispatch, when the worker has one. */
  sessionId: string | null;
  metrics: WorkerMetrics;
  /** The worker's own closing summary, when it produced one. */
  finalMessage?: string;
  /** Path to the raw transcript this dispatch wrote. */
  rawLogPath?: string;
}

export type WorkerFailureKind =
  | "worker_not_available"
  | "spawn_failed"
  | "nonzero_exit"
  | "worker_reported_error"
  | "timeout"
  | "workspace_violation"
  | "internal";

// ---------------------------------------------------------------------------
// What a worker can do
// ---------------------------------------------------------------------------

/**
 * Honest capability reporting. Build Control adapts its behaviour to these
 * rather than pretending every worker supports everything — a pause that does
 * not pause is worse than no pause at all.
 */
export interface WorkerCapabilities {
  /** Can a later dispatch continue an earlier conversation? */
  resumableSessions: boolean;
  /**
   * Can an instruction reach a worker that is mid-dispatch? When false, the
   * runner queues instructions and delivers them on the next dispatch.
   */
  midDispatchInstructions: boolean;
  /**
   * Can an in-flight dispatch be suspended and continued? When false, pause
   * takes effect at the dispatch boundary and the runner says so out loud.
   */
  midDispatchPause: boolean;
  /** Can an in-flight dispatch be cancelled outright? */
  cancellable: boolean;
}

export interface BuildWorker {
  /** Matches build_runs.worker_type. */
  readonly type: string;
  readonly capabilities: WorkerCapabilities;

  /** Whether this worker is usable in the current process/environment. */
  availability(): WorkerAvailability;

  /**
   * Run one dispatch to completion. Resolves with an outcome for every ending
   * including failure and cancellation — it rejects only on a bug in the
   * adapter itself.
   */
  dispatch(ctx: WorkerRunContext, sink: WorkerSink): Promise<WorkerOutcome>;

  /** Cancel the in-flight dispatch for a run. Returns whether one was running. */
  cancel(runId: string): boolean;

  /** Whether a dispatch is currently in flight for a run. */
  isDispatching(runId: string): boolean;
}

export interface WorkerAvailability {
  available: boolean;
  /** Why not, when unavailable. Surfaced to the operator verbatim. */
  reason?: string;
}

/** States in which a dispatch may legally be in flight. */
export const DISPATCHABLE_STATES: readonly BuildRunState[] = [
  "RUNNING",
];
