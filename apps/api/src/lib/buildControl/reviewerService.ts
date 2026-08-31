// Running an independent review and applying its verdict.
//
// Where runnerService is the bridge between a worker and the run row, this is
// the bridge between a reviewer and the run row. It deliberately does NOT let
// the reviewer touch the lifecycle: a reviewer returns a verdict, and this
// applies it through the same state machine every operator review goes
// through, with the same transaction guarantees.
//
// Three verdicts, three destinations:
//
//   PASS               REVIEWING -> AWAITING_APPROVAL   (a human still approves)
//   REVISION_REQUIRED  -> REVISION_REQUIRED, findings queued for the worker
//   STOP               -> STOPPED, attributed to the reviewer (never FAILED)
//
// A review that could not be produced is not a verdict. The run stays where it
// is and the failure is recorded — "the reviewer crashed" must never be
// silently rendered as "nothing was found wrong".

import { and, asc, eq } from "drizzle-orm";

import { getDb } from "../../db/client.js";
import { buildEvents, buildReviews, buildRuns } from "../../db/schema.js";
import { env } from "../env.js";
import { logSystem } from "../logging.js";
import { findingsToInstruction } from "./reviewer/parse.js";
import { buildReviewRequest } from "./reviewer/payload.js";
import { getReviewer } from "./reviewer/registry.js";
import type { ReviewOutcome, ReviewResult } from "./reviewer/types.js";
import { queueInstruction, type RunSnapshot } from "./runnerService.js";
import {
  evaluateReleaseStatus,
  isTerminalState,
  nextState,
  type BuildRunState,
  type CompletionGate,
} from "./stateMachine.js";

export interface ReviewerStatus {
  enabled: boolean;
  reason?: string;
  provider: string;
}

export function reviewerStatus(provider?: string): ReviewerStatus {
  const name = provider ?? env.AICONNECT_REVIEWER_PROVIDER;
  const reviewer = getReviewer(name);
  if (!reviewer) {
    return { enabled: false, reason: `unknown reviewer provider '${name}'`, provider: name ?? "" };
  }
  const availability = reviewer.availability();
  return {
    enabled: availability.available,
    ...(availability.reason ? { reason: availability.reason } : {}),
    provider: reviewer.name,
  };
}

export type RequestReviewOutcome =
  | { ok: true; verdict: ReviewResult["verdict"]; state: BuildRunState; reviewId: string }
  | { ok: false; code: string; reason: string };

/**
 * Runs an independent review of a run and applies the verdict.
 *
 * Synchronous from the caller's perspective — reviews take a minute or two,
 * not the length of a build, and an operator asking for one wants the answer.
 */
export async function requestIndependentReview(
  run: RunSnapshot,
  provider?: string,
): Promise<RequestReviewOutcome> {
  const name = provider ?? env.AICONNECT_REVIEWER_PROVIDER;
  const reviewer = getReviewer(name);
  if (!reviewer) {
    return { ok: false, code: "unknown_reviewer", reason: `unknown reviewer provider '${name}'` };
  }

  const availability = reviewer.availability();
  if (!availability.available) {
    return {
      ok: false,
      code: "reviewer_unavailable",
      reason: availability.reason ?? "the independent reviewer is not available here",
    };
  }

  // Re-read the state rather than trusting the snapshot: a review is worth
  // minutes of wall clock and the run may have moved.
  const current = await currentState(run.id);
  if (current === null) return { ok: false, code: "not_found", reason: "run not found" };

  const probe = nextState({ state: current, action: "review", verdict: "PASS" });
  if (!probe.ok) {
    return {
      ok: false,
      code: "invalid_state",
      reason: `a run in ${current} cannot be reviewed`,
    };
  }

  if (!run.worktreePath) {
    return {
      ok: false,
      code: "no_workspace",
      reason: "this run has no workspace, so there is nothing to review",
    };
  }

  const baseCommit = await findBaseCommit(run.id);

  let request;
  let redactionCounts: Record<string, number>;
  try {
    const built = await buildReviewRequest({
      runId: run.id,
      repoRoot: run.worktreePath,
      branch: run.branchName ?? "unknown",
      baseCommit,
    });
    request = built.request;
    redactionCounts = built.redactionCounts;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await recordEvent(run, {
      eventType: "review.failed",
      summary: `Could not assemble the review payload: ${reason}`,
      severity: "error",
      actionRequired: true,
      details: { reviewer: reviewer.name, stage: "payload" },
    });
    return { ok: false, code: "payload_failed", reason };
  }

  await recordEvent(run, {
    eventType: "review.started",
    summary: `Independent review started (${reviewer.name})`,
    severity: "info",
    details: {
      reviewer: reviewer.name,
      // Counts only — never the values, and never the payload itself. The
      // payload contains a repository diff and is written to the reviewer's
      // raw log, not to the timeline.
      redactions: redactionCounts,
      event_count: request.events.length,
      files_changed: request.diff.filesChanged.length,
      diff_truncated: request.diff.patchTruncated,
      context_files: request.context.map((c) => c.path),
    },
  });

  let outcome: ReviewOutcome;
  try {
    outcome = await reviewer.review(request);
  } catch (err) {
    outcome = {
      ok: false,
      reason: `reviewer threw: ${err instanceof Error ? err.message : String(err)}`,
      reviewer: reviewer.name,
    };
  }

  if (!outcome.ok) {
    // Not a verdict. The run stays exactly where it is.
    await recordEvent(run, {
      eventType: "review.failed",
      summary: `Independent review failed: ${outcome.reason}`,
      severity: "error",
      actionRequired: true,
      details: {
        reviewer: outcome.reviewer,
        raw_log: outcome.rawLogPath ?? null,
        state_unchanged: current,
      },
    });
    await logSystem("error", "build_control_reviewer", "independent review failed", {
      run_id: run.id,
      reviewer: outcome.reviewer,
      reason: outcome.reason,
    });
    return { ok: false, code: "review_failed", reason: outcome.reason };
  }

  return applyReviewVerdict(run, outcome);
}

/**
 * Applies a reviewer's verdict. Shares the transaction shape with the route's
 * human-review path: the state change, the build_reviews row and the timeline
 * event land together or not at all.
 */
async function applyReviewVerdict(
  run: RunSnapshot,
  outcome: Extract<ReviewOutcome, { ok: true }>,
): Promise<RequestReviewOutcome> {
  const { result } = outcome;

  const from = await currentState(run.id);
  if (from === null) return { ok: false, code: "not_found", reason: "run not found" };

  const transition = nextState({ state: from, action: "review", verdict: result.verdict });
  if (!transition.ok) {
    await recordEvent(run, {
      eventType: "review.verdict_ignored",
      summary: `Reviewer returned ${result.verdict} but the run is ${from}`,
      severity: "warn",
      details: { verdict: result.verdict, current_state: from, reviewer: outcome.reviewer },
    });
    return {
      ok: false,
      code: "invalid_state",
      reason: `the run moved to ${from} while it was being reviewed`,
    };
  }

  const gates = result.completionGates as CompletionGate[];
  // Release eligibility comes from the gates the reviewer actually recorded,
  // never from the verdict — a PASS with a failing required gate is still
  // release-blocked.
  const releaseStatus = evaluateReleaseStatus(gates);
  const target = transition.nextState;
  const now = new Date();

  const stopReason =
    result.verdict === "STOP"
      ? `Stopped by independent review (${outcome.reviewer}): ${
          result.summary || "no summary given"
        }`.slice(0, 2000)
      : undefined;

  const reviewId = await getDb().transaction(async (tx) => {
    const [updated] = await tx
      .update(buildRuns)
      .set({
        state: target,
        updatedAt: now,
        completionGates: gates,
        releaseStatus,
        ...(isTerminalState(target) ? { completedAt: now } : {}),
        // STOP is a deliberate supervisory decision, like an operator's stop —
        // which is why it lands on STOPPED and not FAILED, and why the reason
        // is attributed rather than left blank.
        ...(stopReason ? { stopReason } : {}),
        ...(target === "REVISION_REQUIRED"
          ? { currentActivity: "Revisions requested by independent review" }
          : {}),
        ...(target === "AWAITING_APPROVAL"
          ? { currentActivity: "Awaiting human approval" }
          : {}),
      })
      .where(and(eq(buildRuns.id, run.id), eq(buildRuns.state, from)))
      .returning({ id: buildRuns.id });

    if (!updated) return null;

    const [review] = await tx
      .insert(buildReviews)
      .values({
        organizationId: run.organizationId,
        projectId: run.projectId,
        buildRunId: run.id,
        reviewer: outcome.reviewer,
        reviewerVersion: outcome.reviewerVersion,
        verdict: result.verdict,
        findings: result.findings,
        summary: result.summary || null,
      })
      .returning({ id: buildReviews.id });

    if ("passedThrough" in transition && transition.passedThrough) {
      await tx.insert(buildEvents).values({
        organizationId: run.organizationId,
        projectId: run.projectId,
        buildRunId: run.id,
        eventType: "run.state_changed",
        summary: `State ${from} -> ${transition.passedThrough}`,
        severity: "info",
        details: { from, to: transition.passedThrough, action: "review" },
      });
    }

    await tx.insert(buildEvents).values({
      organizationId: run.organizationId,
      projectId: run.projectId,
      buildRunId: run.id,
      eventType: "review.completed",
      summary: `Independent review: ${result.verdict}${
        result.summary ? ` — ${result.summary.slice(0, 200)}` : ""
      }`,
      worker: outcome.reviewer,
      severity: result.verdict === "PASS" ? "info" : "warn",
      actionRequired: result.verdict !== "PASS",
      details: {
        from,
        to: target,
        verdict: result.verdict,
        reviewer: outcome.reviewer,
        reviewer_version: outcome.reviewerVersion,
        finding_count: result.findings.length,
        release_status: releaseStatus,
        metrics: outcome.metrics,
        raw_log: outcome.rawLogPath ?? null,
      },
    });

    return review?.id ?? null;
  });

  if (reviewId === null) {
    await recordEvent(run, {
      eventType: "review.verdict_ignored",
      summary: `Reviewer returned ${result.verdict} but the run changed state concurrently`,
      severity: "warn",
      details: { verdict: result.verdict, expected_state: from },
    });
    return {
      ok: false,
      code: "state_changed",
      reason: "the run changed state while it was being reviewed",
    };
  }

  // A revision verdict must reach the worker, in the SAME session, on the next
  // dispatch. It is queued rather than dispatched: leaving REVISION_REQUIRED
  // is an operator decision, and a reviewer that could restart a worker would
  // be driving the run rather than judging it.
  if (result.verdict === "REVISION_REQUIRED") {
    const instruction = findingsToInstruction(result);
    const queued = queueInstruction(run.id, instruction);
    await recordEvent(run, {
      eventType: "run.revision_requested",
      summary:
        "Review findings queued for the worker — they will be delivered in the same session on the next dispatch",
      severity: "info",
      actionRequired: true,
      details: {
        reviewer: outcome.reviewer,
        queued_count: queued,
        finding_count: result.findings.length,
        instruction,
      },
    });
  }

  return { ok: true, verdict: result.verdict, state: target, reviewId };
}

// ---------------------------------------------------------------------------

async function currentState(runId: string): Promise<BuildRunState | null> {
  const [row] = await getDb()
    .select({ state: buildRuns.state })
    .from(buildRuns)
    .where(eq(buildRuns.id, runId))
    .limit(1);
  return row ? (row.state as BuildRunState) : null;
}

/** The commit the run started from — the baseline the review diff measures. */
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

interface TimelineEvent {
  eventType: string;
  summary: string;
  severity?: "debug" | "info" | "warn" | "error" | "critical";
  actionRequired?: boolean;
  details?: Record<string, unknown>;
}

async function recordEvent(run: RunSnapshot, event: TimelineEvent): Promise<void> {
  try {
    await getDb().insert(buildEvents).values({
      organizationId: run.organizationId,
      projectId: run.projectId,
      buildRunId: run.id,
      eventType: event.eventType,
      summary: event.summary.slice(0, 2000),
      severity: event.severity ?? "info",
      actionRequired: event.actionRequired ?? false,
      details: event.details ?? null,
    });
  } catch (err) {
    await logSystem("warn", "build_control_reviewer", "failed to record review event", {
      run_id: run.id,
      event_type: event.eventType,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
