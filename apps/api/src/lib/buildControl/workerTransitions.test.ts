import { describe, expect, it } from "vitest";

import {
  allowedActions,
  BUILD_RUN_ACTIONS,
  BUILD_RUN_STATES,
  BUILD_RUN_WORKER_ACTIONS,
  isWorkerAction,
  nextState,
  TERMINAL_STATES,
  type BuildRunState,
} from "./stateMachine.js";

// The runner owns two transitions the operator does not. These tests exist
// because getting the split wrong is how a supervised run ends up with an
// execution fault recorded as a human decision, or a worker able to advance a
// run past a gate that belongs to a person.

describe("worker actions are separate from operator actions", () => {
  it("does not leak worker actions into the operator vocabulary", () => {
    for (const action of BUILD_RUN_WORKER_ACTIONS) {
      expect(BUILD_RUN_ACTIONS).not.toContain(action);
    }
  });

  it("never offers a worker action in allowedActions", () => {
    for (const state of BUILD_RUN_STATES) {
      for (const action of allowedActions(state)) {
        expect(isWorkerAction(action)).toBe(false);
      }
    }
  });

  it("identifies worker actions", () => {
    expect(isWorkerAction("complete")).toBe(true);
    expect(isWorkerAction("fail")).toBe(true);
    expect(isWorkerAction("start")).toBe(false);
    expect(isWorkerAction("approve")).toBe(false);
  });
});

describe("complete — the worker finished its work", () => {
  it("moves a running run to review, not to completion", () => {
    const result = nextState({ state: "RUNNING", action: "complete" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // A finished worker is not an approved run. Landing on COMPLETED here
    // would let a worker walk straight past both review and the human gate.
    expect(result.nextState).toBe("REVIEWING");
  });

  it("is illegal from every state except RUNNING", () => {
    for (const state of BUILD_RUN_STATES) {
      if (state === "RUNNING") continue;
      expect(nextState({ state, action: "complete" }).ok, state).toBe(false);
    }
  });

  it("cannot complete a paused run", () => {
    expect(nextState({ state: "PAUSED", action: "complete" }).ok).toBe(false);
  });

  it("cannot complete a run that is already awaiting a human", () => {
    expect(nextState({ state: "AWAITING_APPROVAL", action: "complete" }).ok).toBe(false);
  });
});

describe("fail — the runner's own terminal state", () => {
  it("moves a live run to FAILED", () => {
    for (const state of ["QUEUED", "RUNNING", "PAUSED", "REVISION_REQUIRED"] as const) {
      const result = nextState({ state, action: "fail" });
      expect(result.ok, state).toBe(true);
      if (!result.ok) continue;
      expect(result.nextState).toBe("FAILED");
    }
  });

  it("never produces STOPPED — that word belongs to the operator", () => {
    for (const state of BUILD_RUN_STATES) {
      const result = nextState({ state, action: "fail" });
      if (result.ok) expect(result.nextState).not.toBe("STOPPED");
    }
  });

  it("is illegal once the worker is done and review owns the run", () => {
    expect(nextState({ state: "REVIEWING", action: "fail" }).ok).toBe(false);
    expect(nextState({ state: "AWAITING_APPROVAL", action: "fail" }).ok).toBe(false);
  });

  it("cannot resurrect or overwrite a terminal run", () => {
    for (const state of TERMINAL_STATES) {
      expect(nextState({ state, action: "fail" }).ok, state).toBe(false);
      expect(nextState({ state, action: "complete" }).ok, state).toBe(false);
    }
  });
});

describe("FAILED is reachable only by the runner", () => {
  it("no operator action leads to FAILED from anywhere", () => {
    for (const state of BUILD_RUN_STATES) {
      for (const action of BUILD_RUN_ACTIONS) {
        const result = nextState({
          state,
          action,
          ...(action === "review" ? { verdict: "STOP" as const } : {}),
        });
        if (result.ok) expect(result.nextState, `${state}/${action}`).not.toBe("FAILED");
      }
    }
  });

  it("no operator review verdict leads to FAILED", () => {
    for (const verdict of ["PASS", "REVISION_REQUIRED", "STOP"] as const) {
      const result = nextState({ state: "RUNNING", action: "review", verdict });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.nextState).not.toBe("FAILED");
    }
  });

  it("FAILED is terminal", () => {
    const from: BuildRunState = "FAILED";
    expect(allowedActions(from)).toEqual([]);
    for (const action of [...BUILD_RUN_ACTIONS, ...BUILD_RUN_WORKER_ACTIONS]) {
      expect(
        nextState({ state: from, action, verdict: "PASS" }).ok,
        action,
      ).toBe(false);
    }
  });
});

describe("the worker cannot approve its own work", () => {
  it("has no action that reaches COMPLETED", () => {
    for (const state of BUILD_RUN_STATES) {
      for (const action of BUILD_RUN_WORKER_ACTIONS) {
        const result = nextState({ state, action });
        if (result.ok) expect(result.nextState, `${state}/${action}`).not.toBe("COMPLETED");
      }
    }
  });

  it("leaves AWAITING_APPROVAL reachable only through review", () => {
    for (const action of BUILD_RUN_WORKER_ACTIONS) {
      for (const state of BUILD_RUN_STATES) {
        const result = nextState({ state, action });
        if (result.ok) expect(result.nextState).not.toBe("AWAITING_APPROVAL");
      }
    }
  });
});
