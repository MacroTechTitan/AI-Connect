// DevOS Agentic Build Control — run lifecycle (Issue #19).
//
// The transition table is the single authority on what a Build Run may do
// next. It is pure and DB-free so the lifecycle can be tested exhaustively
// without a database, and so routes never hand-roll a state comparison.
//
// Product states (Issue #19):
//   QUEUED → RUNNING ↔ PAUSED → REVIEWING
//     → (REVISION_REQUIRED → RUNNING) or AWAITING_APPROVAL
//     → COMPLETED / REJECTED
//   FAILED   — unrecoverable execution, set by the runner, not by an operator
//   STOPPED  — operator abandoned the run
//
// DEVIATION (documented in the PR): Issue #19 enumerates nine states and no
// terminal state for an operator Stop. Mapping Stop onto FAILED would record
// a deliberate human decision as an execution fault, which is precisely the
// kind of unattributable history Build Control exists to prevent. STOPPED is
// therefore added as a distinct terminal state. It is excluded from the
// one-active-run-per-project partial index, exactly like the other terminals.

export const BUILD_RUN_STATES = [
  "QUEUED",
  "RUNNING",
  "PAUSED",
  "REVIEWING",
  "REVISION_REQUIRED",
  "AWAITING_APPROVAL",
  "COMPLETED",
  "FAILED",
  "REJECTED",
  "STOPPED",
] as const;

export type BuildRunState = (typeof BUILD_RUN_STATES)[number];

// States that occupy the "one supervised run per project" slot. MUST stay in
// sync with the partial unique index build_runs_one_active_per_project_idx.
export const ACTIVE_STATES: readonly BuildRunState[] = [
  "QUEUED",
  "RUNNING",
  "PAUSED",
  "REVIEWING",
  "REVISION_REQUIRED",
  "AWAITING_APPROVAL",
];

export const TERMINAL_STATES: readonly BuildRunState[] = [
  "COMPLETED",
  "FAILED",
  "REJECTED",
  "STOPPED",
];

export function isActiveState(state: BuildRunState): boolean {
  return ACTIVE_STATES.includes(state);
}

export function isTerminalState(state: BuildRunState): boolean {
  return TERMINAL_STATES.includes(state);
}

export const BUILD_RUN_ACTIONS = [
  "start",
  "pause",
  "resume",
  "stop",
  "instruct",
  "review",
  "approve",
  "reject",
] as const;

export type BuildRunAction = (typeof BUILD_RUN_ACTIONS)[number];

// Actions the WORKER owns, not the operator. They are deliberately a separate
// vocabulary from BUILD_RUN_ACTIONS: `allowedActions` describes the buttons an
// operator may press, and neither of these is one. No route exposes them — the
// runner calls nextState() with them directly.
//
//   complete  the worker finished its work and the run goes for review
//   fail      the worker could not finish — a genuine execution fault
//
// `fail` is why FAILED exists and is why STOPPED is not reused for it: STOPPED
// records a deliberate human decision, FAILED records an execution fault, and
// collapsing the two produces exactly the unattributable history Build Control
// exists to prevent.
export const BUILD_RUN_WORKER_ACTIONS = ["complete", "fail"] as const;

export type BuildRunWorkerAction = (typeof BUILD_RUN_WORKER_ACTIONS)[number];

export type AnyBuildRunAction = BuildRunAction | BuildRunWorkerAction;

export function isWorkerAction(
  action: AnyBuildRunAction,
): action is BuildRunWorkerAction {
  return (BUILD_RUN_WORKER_ACTIONS as readonly string[]).includes(action);
}

export const REVIEW_VERDICTS = ["PASS", "REVISION_REQUIRED", "STOP"] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

export const RELEASE_STATUSES = ["NOT_EVALUATED", "ELIGIBLE", "BLOCKED"] as const;
export type ReleaseStatus = (typeof RELEASE_STATUSES)[number];

// Actions whose target state does not depend on a payload.
const SIMPLE_TRANSITIONS: Record<
  Exclude<AnyBuildRunAction, "review" | "instruct">,
  { from: readonly BuildRunState[]; to: BuildRunState }
> = {
  // Worker-owned. `complete` is only legal from RUNNING: a paused or already
  // reviewed run is not something a worker may declare finished.
  complete: { from: ["RUNNING"], to: "REVIEWING" },
  // A genuine execution fault can arrive whenever a worker is live or was
  // about to be. Not from REVIEWING or AWAITING_APPROVAL — by then the worker
  // is done and any fault belongs to review, not to execution.
  fail: { from: ["QUEUED", "RUNNING", "PAUSED", "REVISION_REQUIRED"], to: "FAILED" },
  start: { from: ["QUEUED"], to: "RUNNING" },
  pause: { from: ["RUNNING"], to: "PAUSED" },
  resume: { from: ["PAUSED"], to: "RUNNING" },
  // Stop is available from every non-terminal state: an operator must always
  // be able to end a supervised run.
  stop: {
    from: ["QUEUED", "RUNNING", "PAUSED", "REVIEWING", "REVISION_REQUIRED", "AWAITING_APPROVAL"],
    to: "STOPPED",
  },
  approve: { from: ["AWAITING_APPROVAL"], to: "COMPLETED" },
  reject: { from: ["AWAITING_APPROVAL"], to: "REJECTED" },
};

// An instruction is accepted while the worker is live or awaiting revision.
// From REVISION_REQUIRED it returns the run to RUNNING — Issue #19: "Revision
// instructions return to the same run." From RUNNING/PAUSED the run keeps its
// state and only records an event.
const INSTRUCT_FROM: readonly BuildRunState[] = ["RUNNING", "PAUSED", "REVISION_REQUIRED"];

// A review may be submitted while the worker is still RUNNING (the runner has
// finished its work but nothing has moved the run yet) or once the run is
// already REVIEWING. Submitting from RUNNING passes through REVIEWING so the
// timeline still records that the state existed.
const REVIEW_FROM: readonly BuildRunState[] = ["RUNNING", "REVIEWING"];

const VERDICT_TO_STATE: Record<ReviewVerdict, BuildRunState> = {
  PASS: "AWAITING_APPROVAL",
  REVISION_REQUIRED: "REVISION_REQUIRED",
  STOP: "STOPPED",
};

export interface TransitionInput {
  state: BuildRunState;
  action: AnyBuildRunAction;
  verdict?: ReviewVerdict;
}

export type TransitionResult =
  | { ok: true; nextState: BuildRunState; passedThrough?: BuildRunState }
  | { ok: false; reason: "invalid_transition"; from: BuildRunState; action: AnyBuildRunAction; allowedFrom: readonly BuildRunState[] }
  | { ok: false; reason: "verdict_required"; from: BuildRunState; action: AnyBuildRunAction; allowedFrom: readonly BuildRunState[] };

export function nextState(input: TransitionInput): TransitionResult {
  const { state, action, verdict } = input;

  if (action === "review") {
    if (!REVIEW_FROM.includes(state)) {
      return { ok: false, reason: "invalid_transition", from: state, action, allowedFrom: REVIEW_FROM };
    }
    if (!verdict) {
      return { ok: false, reason: "verdict_required", from: state, action, allowedFrom: REVIEW_FROM };
    }
    return {
      ok: true,
      nextState: VERDICT_TO_STATE[verdict],
      ...(state === "RUNNING" ? { passedThrough: "REVIEWING" as BuildRunState } : {}),
    };
  }

  if (action === "instruct") {
    if (!INSTRUCT_FROM.includes(state)) {
      return { ok: false, reason: "invalid_transition", from: state, action, allowedFrom: INSTRUCT_FROM };
    }
    return { ok: true, nextState: state === "REVISION_REQUIRED" ? "RUNNING" : state };
  }

  const rule = SIMPLE_TRANSITIONS[action];
  if (!rule.from.includes(state)) {
    return { ok: false, reason: "invalid_transition", from: state, action, allowedFrom: rule.from };
  }
  return { ok: true, nextState: rule.to };
}

// Which actions are legal right now. Drives the UI's button states later and
// is returned on every run response so a client never has to re-derive it.
export function allowedActions(state: BuildRunState): BuildRunAction[] {
  return BUILD_RUN_ACTIONS.filter((action) => {
    const result = nextState({
      state,
      action,
      // A probe verdict — presence, not value, is what "review" needs here.
      ...(action === "review" ? { verdict: "PASS" as ReviewVerdict } : {}),
    });
    return result.ok;
  });
}

// A completion gate as described in docs/FEATURE_REGISTRY_INTEGRATION.md.
export interface CompletionGate {
  gate: string;
  status: "PASS" | "FAIL";
  required: boolean;
  detail?: string;
}

// Release eligibility is a product gate, not a worker result: a run may end
// technically implemented and still be release-blocked. A run with no gates
// recorded is NOT_EVALUATED rather than ELIGIBLE — absence of evidence is not
// evidence of passing.
export function evaluateReleaseStatus(gates: readonly CompletionGate[]): ReleaseStatus {
  if (gates.length === 0) return "NOT_EVALUATED";
  const blocked = gates.some((g) => g.required && g.status === "FAIL");
  return blocked ? "BLOCKED" : "ELIGIBLE";
}
