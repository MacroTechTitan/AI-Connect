// The independent reviewer boundary.
//
// Deliberately a SEPARATE boundary from the worker adapter, not a second
// method on it. The thing that did the work must never be the thing that
// judges it, and the cleanest way to guarantee that is for the reviewer to
// have no access to the worker's session, its tools, or its process.
//
// A reviewer receives a self-contained payload and returns a verdict. It
// cannot edit files, run commands, push, deploy, or move the run — the
// lifecycle applies its verdict through the same state machine every operator
// action goes through.
//
// Provider-neutral: `claude_code` is the v0.1 implementation, not the
// contract. Nothing in the Build Control lifecycle knows which model reviewed.

/** The three verdicts. Matches build_reviews_verdict_check. */
export const REVIEW_VERDICTS = ["PASS", "REVISION_REQUIRED", "STOP"] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

export const FINDING_SEVERITIES = ["info", "warn", "error", "critical"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export interface ReviewFinding {
  title: string;
  detail?: string;
  severity: FindingSeverity;
  /** File, symbol, or acceptance criterion the finding concerns. */
  target?: string;
}

/** A completion gate the reviewer evaluated. Drives release_status. */
export interface ReviewGate {
  gate: string;
  status: "PASS" | "FAIL";
  required: boolean;
  detail?: string;
}

// ---------------------------------------------------------------------------
// The payload
// ---------------------------------------------------------------------------

/**
 * Everything a reviewer is given, and the only thing it is given. Assembled by
 * reviewer/payload.ts from the run, its timeline and its workspace.
 *
 * It is a plain serializable object on purpose: a reviewer must be able to
 * judge a run without a database handle, a repository checkout it can write
 * to, or any part of the worker's process.
 */
export interface ReviewRequest {
  /** What the run was asked to do. */
  task: {
    runId: string;
    title: string;
    goal: string;
    acceptanceCriteria: string[];
    outOfScope: string[];
    stopAndAsk: string[];
  };

  /** Feature Registry packet, when the run carried one. */
  feature: {
    featureId: string | null;
    workPacket: Record<string, unknown> | null;
  };

  /** Where the work happened. Paths only — the reviewer cannot write here. */
  workspace: {
    repoRoot: string;
    branch: string;
    baseCommit: string | null;
  };

  /** A condensed, ordered account of what the worker did. */
  events: ReviewEventSummary[];

  /** What actually changed, measured rather than claimed. */
  diff: {
    filesChanged: string[];
    additions: number | null;
    deletions: number | null;
    /** Unified diff text, truncated and redacted. Null when unavailable. */
    patch: string | null;
    patchTruncated: boolean;
    /** Files whose line counts could not be measured (binaries). */
    unmeasured: string[];
  };

  /** Validation the run recorded. Empty when none was run — never invented. */
  validation: {
    summary: unknown[];
    completionGates: ReviewGate[];
  };

  /** How the worker said it went. */
  worker: {
    type: string;
    status: string;
    finalMessage: string | null;
    /** Only what the worker actually reported. */
    metrics: Record<string, unknown>;
  };

  /** Architecture and policy the reviewer should judge against. */
  context: ReviewContextFile[];
}

export interface ReviewEventSummary {
  at: string;
  type: string;
  severity: string;
  summary: string;
  target?: string | null;
}

export interface ReviewContextFile {
  path: string;
  content: string;
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// The result
// ---------------------------------------------------------------------------

export interface ReviewResult {
  verdict: ReviewVerdict;
  summary: string;
  findings: ReviewFinding[];
  completionGates: ReviewGate[];
}

export type ReviewOutcome =
  | { ok: true; result: ReviewResult; reviewer: string; reviewerVersion: string | null; metrics: Record<string, unknown>; rawLogPath?: string }
  /**
   * The reviewer could not produce a verdict. This is NOT a verdict: a run
   * whose review failed stays in REVIEWING rather than being moved by a
   * guess. Failing to review is not the same as finding nothing wrong.
   */
  | { ok: false; reason: string; reviewer: string; rawLogPath?: string };

export interface ReviewerAvailability {
  available: boolean;
  reason?: string;
}

export interface BuildReviewer {
  /** Provider name recorded in build_reviews.reviewer. */
  readonly name: string;
  /** Whether this reviewer can run in the current process/environment. */
  availability(): ReviewerAvailability;
  /**
   * Produce a verdict. Resolves with an outcome for every ending including
   * failure; it rejects only on a bug in the adapter itself.
   */
  review(request: ReviewRequest): Promise<ReviewOutcome>;
}
