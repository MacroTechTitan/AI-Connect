import { describe, expect, it } from "vitest";

import {
  ACTIVE_STATES,
  allowedActions,
  BUILD_RUN_ACTIONS,
  BUILD_RUN_STATES,
  evaluateReleaseStatus,
  isActiveState,
  isTerminalState,
  nextState,
  REVIEW_VERDICTS,
  TERMINAL_STATES,
  type BuildRunAction,
  type BuildRunState,
  type CompletionGate,
} from "./stateMachine.js";

// Helper that asserts a transition succeeded and returns the resulting state.
function move(
  state: BuildRunState,
  action: BuildRunAction,
  verdict?: (typeof REVIEW_VERDICTS)[number],
): BuildRunState {
  const result = nextState({ state, action, verdict });
  if (!result.ok) {
    throw new Error(
      `expected ${state} --${action}--> to be legal, got ${result.reason}`,
    );
  }
  return result.nextState;
}

function expectRejected(
  state: BuildRunState,
  action: BuildRunAction,
  verdict?: (typeof REVIEW_VERDICTS)[number],
): void {
  const result = nextState({ state, action, verdict });
  expect(result.ok, `${state} --${action}--> should be rejected`).toBe(false);
}

describe("state vocabulary", () => {
  it("partitions every state into exactly one of active or terminal", () => {
    for (const state of BUILD_RUN_STATES) {
      const active = isActiveState(state);
      const terminal = isTerminalState(state);
      expect(
        active !== terminal,
        `${state} must be exactly one of active/terminal`,
      ).toBe(true);
    }
    expect(ACTIVE_STATES.length + TERMINAL_STATES.length).toBe(
      BUILD_RUN_STATES.length,
    );
  });

  it("treats STOPPED as terminal, so a stopped run frees the project slot", () => {
    // The one-active-run-per-project partial index excludes terminal states.
    // If STOPPED were active, stopping a run would permanently block the
    // project from ever starting another.
    expect(isTerminalState("STOPPED")).toBe(true);
    expect(ACTIVE_STATES).not.toContain("STOPPED");
  });
});

describe("happy path: queued through human approval", () => {
  it("walks QUEUED -> RUNNING -> REVIEWING -> AWAITING_APPROVAL -> COMPLETED", () => {
    let s: BuildRunState = "QUEUED";
    s = move(s, "start");
    expect(s).toBe("RUNNING");

    const reviewed = nextState({ state: s, action: "review", verdict: "PASS" });
    expect(reviewed.ok).toBe(true);
    if (!reviewed.ok) return;
    // Reviewing from RUNNING must record that REVIEWING happened rather than
    // silently jumping the state.
    expect(reviewed.passedThrough).toBe("REVIEWING");
    s = reviewed.nextState;
    expect(s).toBe("AWAITING_APPROVAL");

    s = move(s, "approve");
    expect(s).toBe("COMPLETED");
  });

  it("supports pause and resume without losing the run", () => {
    let s: BuildRunState = move("QUEUED", "start");
    s = move(s, "pause");
    expect(s).toBe("PAUSED");
    s = move(s, "resume");
    expect(s).toBe("RUNNING");
  });

  it("returns a revision instruction to the same run", () => {
    // Issue #19: "Revision instructions return to the same run."
    const afterReview = move("RUNNING", "review", "REVISION_REQUIRED");
    expect(afterReview).toBe("REVISION_REQUIRED");
    expect(move(afterReview, "instruct")).toBe("RUNNING");
  });

  it("rejects at the human gate", () => {
    expect(move("AWAITING_APPROVAL", "reject")).toBe("REJECTED");
  });
});

describe("review verdicts", () => {
  it("maps each verdict to its state", () => {
    expect(move("REVIEWING", "review", "PASS")).toBe("AWAITING_APPROVAL");
    expect(move("REVIEWING", "review", "REVISION_REQUIRED")).toBe(
      "REVISION_REQUIRED",
    );
    expect(move("REVIEWING", "review", "STOP")).toBe("STOPPED");
  });

  it("requires a verdict", () => {
    const result = nextState({ state: "REVIEWING", action: "review" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("verdict_required");
  });

  it("does not accept a review from a state that has not run", () => {
    expectRejected("QUEUED", "review", "PASS");
    expectRejected("PAUSED", "review", "PASS");
    expectRejected("AWAITING_APPROVAL", "review", "PASS");
  });
});

describe("stop", () => {
  it("is available from every non-terminal state", () => {
    for (const state of ACTIVE_STATES) {
      expect(move(state, "stop")).toBe("STOPPED");
    }
  });

  it("is not available once the run has ended", () => {
    for (const state of TERMINAL_STATES) {
      expectRejected(state, "stop");
    }
  });
});

describe("terminal states are final", () => {
  it("rejects every action from every terminal state", () => {
    for (const state of TERMINAL_STATES) {
      for (const action of BUILD_RUN_ACTIONS) {
        expectRejected(
          state,
          action,
          action === "review" ? "PASS" : undefined,
        );
      }
      expect(allowedActions(state)).toEqual([]);
    }
  });
});

describe("invalid transitions", () => {
  it("cannot start a run twice", () => {
    expectRejected("RUNNING", "start");
  });

  it("cannot resume a run that is not paused", () => {
    expectRejected("RUNNING", "resume");
    expectRejected("QUEUED", "resume");
  });

  it("cannot pause a run that is not running", () => {
    expectRejected("QUEUED", "pause");
    expectRejected("PAUSED", "pause");
  });

  it("cannot approve or reject before review has passed", () => {
    for (const state of ["QUEUED", "RUNNING", "PAUSED", "REVIEWING", "REVISION_REQUIRED"] as const) {
      expectRejected(state, "approve");
      expectRejected(state, "reject");
    }
  });

  it("cannot instruct a queued run", () => {
    // Nothing is executing yet, so there is no worker to instruct.
    expectRejected("QUEUED", "instruct");
  });

  it("reports which states the action was legal from", () => {
    const result = nextState({ state: "QUEUED", action: "pause" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_transition");
    expect(result.allowedFrom).toEqual(["RUNNING"]);
  });
});

describe("allowedActions", () => {
  it("agrees with nextState for every state/action pair", () => {
    for (const state of BUILD_RUN_STATES) {
      const allowed = allowedActions(state);
      for (const action of BUILD_RUN_ACTIONS) {
        const probe = nextState({
          state,
          action,
          ...(action === "review" ? { verdict: "PASS" as const } : {}),
        });
        expect(
          allowed.includes(action),
          `${state}/${action} disagreement`,
        ).toBe(probe.ok);
      }
    }
  });

  it("offers exactly start and stop on a queued run", () => {
    expect(allowedActions("QUEUED").sort()).toEqual(["start", "stop"]);
  });
});

describe("release eligibility", () => {
  const gate = (
    name: string,
    status: "PASS" | "FAIL",
    required = true,
  ): CompletionGate => ({ gate: name, status, required });

  it("is NOT_EVALUATED when no gates were recorded", () => {
    // Absence of evidence is not evidence of passing.
    expect(evaluateReleaseStatus([])).toBe("NOT_EVALUATED");
  });

  it("is BLOCKED when a required gate fails", () => {
    expect(
      evaluateReleaseStatus([gate("tests", "PASS"), gate("changelog", "FAIL")]),
    ).toBe("BLOCKED");
  });

  it("is ELIGIBLE when only optional gates fail", () => {
    expect(
      evaluateReleaseStatus([
        gate("tests", "PASS"),
        gate("homepage", "FAIL", false),
      ]),
    ).toBe("ELIGIBLE");
  });

  it("is ELIGIBLE when every required gate passes", () => {
    expect(
      evaluateReleaseStatus([gate("tests", "PASS"), gate("guide", "PASS")]),
    ).toBe("ELIGIBLE");
  });

  it("lets a run pass review and still be release blocked", () => {
    // docs/FEATURE_REGISTRY_INTEGRATION.md: a successful Build Run may end
    // with a technically implemented feature that remains release-blocked.
    const afterPass = move("RUNNING", "review", "PASS");
    expect(afterPass).toBe("AWAITING_APPROVAL");
    expect(
      evaluateReleaseStatus([gate("implementation", "PASS"), gate("guide", "FAIL")]),
    ).toBe("BLOCKED");
  });
});
