// Runner integration: real routes, real database, real state machine — with a
// scripted worker in place of Claude Code.
//
// Splitting it this way is deliberate. Everything between an operator pressing
// a button and a row changing is exercised here, deterministically and for
// free. The one thing a fake worker cannot prove — that a real Claude Code
// process produces events Build Control can read — is proven separately by
// scripts/runnerLiveSmoke.ts against a real process.
//
// The fake worker is registered over `claude_code` for the duration of this
// file and restored afterwards, so it cannot leak into any other suite.

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

// The harness must configure process.env before lib/env.ts is first imported,
// and env.ts parses at import time. runnerService and the worker registry both
// reach it, so they are imported dynamically in beforeAll — AFTER
// startLocalApi() resolves. `import type` is erased at compile time and is
// safe to keep static.
import { startLocalApi, type LocalApi } from "../../scripts/localApiHarness.js";
import type { registerWorker as RegisterWorker } from "./worker/registry.js";
import type { resetRunnerState as ResetRunnerState } from "./runnerService.js";
import type {
  BuildWorker,
  NormalizedEvent,
  WorkerOutcome,
  WorkerRunContext,
  WorkerSink,
} from "./worker/types.js";

// ---------------------------------------------------------------------------
// A worker we can script
// ---------------------------------------------------------------------------

interface Script {
  /** Events the worker emits before finishing. */
  events?: NormalizedEvent[];
  /** How it ends. */
  outcome: Omit<WorkerOutcome, "sessionId"> & { sessionId?: string | null };
  /** Milliseconds to stay "in flight" so cancellation has something to cancel. */
  holdMs?: number;
  /** Files it writes into the workspace, so diff capture has real work to measure. */
  writes?: { path: string; content: string }[];
}

class ScriptedWorker implements BuildWorker {
  readonly type = "claude_code";
  readonly capabilities = {
    resumableSessions: true,
    midDispatchInstructions: false,
    midDispatchPause: false,
    cancellable: true,
  };

  script: Script = { outcome: { status: "completed", metrics: {} } };
  available = true;
  /** Every context it was dispatched with, in order. */
  readonly dispatches: WorkerRunContext[] = [];

  private readonly inFlight = new Map<string, () => void>();

  availability() {
    return this.available
      ? { available: true }
      : { available: false, reason: "scripted worker disabled" };
  }

  isDispatching(runId: string): boolean {
    return this.inFlight.has(runId);
  }

  cancel(runId: string): boolean {
    const abort = this.inFlight.get(runId);
    if (!abort) return false;
    abort();
    return true;
  }

  async dispatch(ctx: WorkerRunContext, sink: WorkerSink): Promise<WorkerOutcome> {
    this.dispatches.push(structuredClone({ ...ctx, workspace: { ...ctx.workspace } }));
    const script = this.script;

    for (const write of script.writes ?? []) {
      writeFileSync(resolve(ctx.workspace.repoRoot, write.path), write.content);
    }
    for (const event of script.events ?? []) {
      sink.event(event);
      sink.activity(event.summary);
    }

    let cancelled = false;
    if (script.holdMs) {
      await new Promise<void>((done) => {
        const timer = setTimeout(done, script.holdMs);
        this.inFlight.set(ctx.runId, () => {
          cancelled = true;
          clearTimeout(timer);
          done();
        });
      });
      this.inFlight.delete(ctx.runId);
    }

    const sessionId = script.outcome.sessionId ?? ctx.sessionId ?? randomUUID();
    if (cancelled) return { ...script.outcome, status: "cancelled", sessionId };
    return { ...script.outcome, sessionId };
  }
}

const worker = new ScriptedWorker();
let restoreWorker: () => void;
let registerWorker: typeof RegisterWorker;
let resetRunnerState: typeof ResetRunnerState;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let api: LocalApi;
let pool: pg.Pool;
let workspaceRoot: string;
let repoRoot: string;

const stamp = randomUUID().slice(0, 8);
const OWNER = `runner-${stamp}@staging.local`;
let token: string;
let projectId: string;

const post = <T = unknown>(path: string, body?: unknown) =>
  api.request<T>("POST", path, { token, body });
const get = <T = unknown>(path: string) => api.request<T>("GET", path, { token });

interface Run {
  id: string;
  state: string;
  current_activity: string | null;
  files_changed: string[];
  additions: number | null;
  deletions: number | null;
  cost_usd: string | null;
  branch_name: string | null;
  stop_reason: string | null;
}

interface BuildEvent {
  event_type: string;
  summary: string;
  severity: string;
  details: Record<string, unknown>;
}

/** Waits for the fire-and-forget dispatch to reach a settled state. */
async function waitForState(runId: string, states: string[], timeoutMs = 15_000): Promise<Run> {
  const deadline = Date.now() + timeoutMs;
  let last: Run | undefined;
  while (Date.now() < deadline) {
    const res = await get<Run>(`/api/build-runs/${runId}`);
    last = res.body;
    if (states.includes(last.state)) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(
    `run ${runId} never reached ${states.join("|")}; last state ${last?.state ?? "unknown"}`,
  );
}

async function events(runId: string): Promise<BuildEvent[]> {
  const res = await get<{ events: BuildEvent[] }>(`/api/build-runs/${runId}/events?limit=500`);
  return res.body.events;
}

async function createRun(title: string, over: Record<string, unknown> = {}): Promise<string> {
  const res = await post<Run>("/api/build-runs", {
    project_id: projectId,
    title,
    goal: "runner integration fixture",
    acceptance_criteria: ["it works"],
    ...over,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  // The workspace is not yet modelled on projects, so the runner reads it from
  // the run. Set it directly — the create route does not accept a path, by
  // design: a caller must never be able to choose where execution happens.
  await pool.query(`UPDATE build_runs SET worktree_path = $1 WHERE id = $2`, [
    repoRoot,
    res.body.id,
  ]);
  return res.body.id;
}

beforeAll(async () => {
  workspaceRoot = process.env.AICONNECT_RUNNER_WORKSPACE_ROOT!;
  repoRoot = resolve(workspaceRoot, `repo-${stamp}`);
  mkdirSync(repoRoot, { recursive: true });
  execFileSync("git", ["-C", repoRoot, "init", "-q"], { windowsHide: true });
  execFileSync("git", ["-C", repoRoot, "config", "user.email", "t@example.com"]);
  execFileSync("git", ["-C", repoRoot, "config", "user.name", "Test"]);
  writeFileSync(resolve(repoRoot, "README.md"), "base\n");
  execFileSync("git", ["-C", repoRoot, "add", "-A"], { windowsHide: true });
  execFileSync("git", ["-C", repoRoot, "commit", "-qm", "init"], { windowsHide: true });

  api = await startLocalApi();

  // Only now is it safe to pull in the modules that read lib/env.ts.
  ({ registerWorker } = await import("./worker/registry.js"));
  ({ resetRunnerState } = await import("./runnerService.js"));
  restoreWorker = registerWorker(worker);
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  token = await api.token(OWNER);

  expect((await get("/api/me")).status).toBe(200);
  const project = await post<{ id: string }>("/api/projects", { name: `runner ${stamp}` });
  expect(project.status).toBe(201);
  projectId = project.body.id;
});

afterEach(async () => {
  resetRunnerState?.();
  worker.script = { outcome: { status: "completed", metrics: {} } };
  worker.available = true;
  worker.dispatches.length = 0;

  // Every test creates a run on the same project, and the one-active-run
  // partial index allows exactly one non-terminal run at a time. Retiring them
  // here keeps each test independent of what the previous one left behind.
  await pool.query(
    `UPDATE build_runs SET state = 'STOPPED', completed_at = now()
      WHERE project_id = $1
        AND state NOT IN ('COMPLETED','FAILED','REJECTED','STOPPED')`,
    [projectId],
  );
});

afterAll(async () => {
  restoreWorker?.();
  if (pool) {
    await pool.query(
      `DELETE FROM projects WHERE organization_id IN
         (SELECT organization_id FROM users WHERE email = $1)`,
      [OWNER],
    );
    await pool.query(
      `DELETE FROM organizations WHERE id IN
         (SELECT organization_id FROM users WHERE email = $1)`,
      [OWNER],
    );
    await pool.query(
      `DELETE FROM user_audit_logs WHERE user_id IN (SELECT id FROM users WHERE email = $1)`,
      [OWNER],
    );
    await pool.query(`DELETE FROM users WHERE email = $1`, [OWNER]);
    await pool.end();
  }
  if (api) await api.stop();
  try {
    rmSync(repoRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// ---------------------------------------------------------------------------

describe("GET /api/build-runs/runner", () => {
  it("reports whether starting a run will actually dispatch anything", async () => {
    const res = await get<{ enabled: boolean; capabilities: Record<string, boolean> }>(
      "/api/build-runs/runner",
    );
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    // The capability report is what stops a UI promising a pause that cannot
    // happen.
    expect(res.body.capabilities).toMatchObject({
      resumableSessions: true,
      midDispatchInstructions: false,
      midDispatchPause: false,
      cancellable: true,
    });
  });
});

describe("start dispatches a worker", () => {
  it("hands the worker the full brief from the run", async () => {
    const runId = await createRun("brief run", {
      goal: "do the thing",
      acceptance_criteria: ["criterion one"],
      out_of_scope: ["not this"],
      stop_and_ask: ["ask about that"],
      feature_id: "FEAT-9",
      feature_work_packet: { k: "v" },
    });
    await post(`/api/build-runs/${runId}/start`);
    await waitForState(runId, ["REVIEWING"]);

    expect(worker.dispatches).toHaveLength(1);
    const ctx = worker.dispatches[0];
    expect(ctx.goal).toBe("do the thing");
    expect(ctx.acceptanceCriteria).toEqual(["criterion one"]);
    expect(ctx.outOfScope).toEqual(["not this"]);
    expect(ctx.stopAndAsk).toEqual(["ask about that"]);
    expect(ctx.featureId).toBe("FEAT-9");
    expect(ctx.featureWorkPacket).toEqual({ k: "v" });
    expect(ctx.reason).toBe("start");
    expect(ctx.sessionId).toBeNull();
  });

  it("gives the worker a resolved workspace and a branch, and records both", async () => {
    const runId = await createRun("workspace run");
    await post(`/api/build-runs/${runId}/start`);
    const run = await waitForState(runId, ["REVIEWING"]);

    const ctx = worker.dispatches[0];
    expect(ctx.workspace.repoRoot).toContain(`repo-${stamp}`);
    expect(ctx.workspace.branch).toMatch(/^build\//);
    expect(run.branch_name).toBe(ctx.workspace.branch);

    const branch = execFileSync("git", ["-C", repoRoot, "rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
    }).trim();
    expect(branch).toBe(ctx.workspace.branch);
  });

  it("persists the worker's normalized events on the timeline", async () => {
    worker.script = {
      events: [
        { eventType: "worker.session_started", summary: "session up", severity: "info" },
        {
          eventType: "worker.tool_use",
          summary: "Write: src/a.ts",
          severity: "info",
          affectedTarget: "src/a.ts",
          details: { tool: "Write" },
        },
      ],
      outcome: { status: "completed", metrics: {} },
    };
    const runId = await createRun("events run");
    await post(`/api/build-runs/${runId}/start`);
    await waitForState(runId, ["REVIEWING"]);

    const types = (await events(runId)).map((e) => e.event_type);
    expect(types).toContain("worker.session_started");
    expect(types).toContain("worker.tool_use");
    expect(types).toContain("run.dispatch_started");
    expect(types).toContain("run.dispatch_finished");
    expect(types).toContain("run.worker_completed");

    const tool = (await events(runId)).find((e) => e.event_type === "worker.tool_use");
    expect(tool?.details.tool).toBe("Write");
  });

  it("updates current_activity as work progresses", async () => {
    worker.script = {
      events: [{ eventType: "worker.tool_use", summary: "Editing src/b.ts", severity: "info" }],
      outcome: { status: "completed", metrics: {} },
    };
    const runId = await createRun("activity run");
    await post(`/api/build-runs/${runId}/start`);
    const run = await waitForState(runId, ["REVIEWING"]);
    expect(run.current_activity).toBe("Awaiting independent review");
  });

  it("does not dispatch twice for one start", async () => {
    const runId = await createRun("single dispatch");
    await post(`/api/build-runs/${runId}/start`);
    await waitForState(runId, ["REVIEWING"]);
    expect(worker.dispatches).toHaveLength(1);
  });
});

describe("completion moves RUNNING -> REVIEWING", () => {
  it("sends a finished run to review, never straight to completed", async () => {
    const runId = await createRun("completion run");
    await post(`/api/build-runs/${runId}/start`);
    const run = await waitForState(runId, ["REVIEWING", "COMPLETED", "FAILED"]);
    // The worker finishing is not the run finishing: review and a human
    // approval still stand between here and COMPLETED.
    expect(run.state).toBe("REVIEWING");
  });

  it("records completion as needing attention, with the metrics the worker reported", async () => {
    worker.script = {
      outcome: {
        status: "completed",
        metrics: { costUsd: 0.1234, turns: 3, durationMs: 1000 },
        finalMessage: "did the work",
      },
    };
    const runId = await createRun("metrics run");
    await post(`/api/build-runs/${runId}/start`);
    const run = await waitForState(runId, ["REVIEWING"]);

    const completed = (await events(runId)).find((e) => e.event_type === "run.worker_completed");
    expect(completed?.summary).toContain("did the work");
    expect((completed?.details.metrics as Record<string, unknown>).costUsd).toBe(0.1234);
    expect(run.cost_usd).toBe("0.123400");
  });

  it("records no cost at all when the worker did not report one", async () => {
    worker.script = { outcome: { status: "completed", metrics: { turns: 1 } } };
    const runId = await createRun("no cost run");
    await post(`/api/build-runs/${runId}/start`);
    const run = await waitForState(runId, ["REVIEWING"]);
    // A fabricated 0.00 would be a lie about what the run cost.
    expect(run.cost_usd).toBeNull();
  });

  it("captures real diff statistics for the work the worker did", async () => {
    worker.script = {
      writes: [{ path: "NEW_FILE.md", content: "one\ntwo\nthree\n" }],
      outcome: { status: "completed", metrics: {} },
    };
    const runId = await createRun("diff run");
    await post(`/api/build-runs/${runId}/start`);
    const run = await waitForState(runId, ["REVIEWING"]);

    expect(run.files_changed).toContain("NEW_FILE.md");
    expect(run.additions).toBe(3);
    expect(run.deletions).toBe(0);

    const diff = (await events(runId)).find((e) => e.event_type === "run.diff_captured");
    expect(diff?.details.additions).toBe(3);

    rmSync(resolve(repoRoot, "NEW_FILE.md"), { force: true });
  });
});

describe("failure is the runner's own path, and is never STOPPED", () => {
  it("moves a run to FAILED and records the cause", async () => {
    worker.script = {
      outcome: {
        status: "failed",
        failureKind: "nonzero_exit",
        failureCause: "worker exited with code 1: boom",
        metrics: {},
      },
    };
    const runId = await createRun("failure run");
    await post(`/api/build-runs/${runId}/start`);
    const run = await waitForState(runId, ["FAILED"]);

    expect(run.state).toBe("FAILED");
    // STOPPED records a human decision. An execution fault is not one, so the
    // stop_reason column stays empty.
    expect(run.stop_reason).toBeNull();
    expect(run.current_activity).toContain("boom");

    const failed = (await events(runId)).find((e) => e.event_type === "run.failed");
    expect(failed?.severity).toBe("error");
    expect(failed?.details.failure_cause).toContain("boom");
    expect(failed?.details.failure_kind).toBe("nonzero_exit");
    expect(failed?.details.from).toBe("RUNNING");
    expect(failed?.details.to).toBe("FAILED");
  });

  it("fails the run when the adapter throws rather than leaving it RUNNING forever", async () => {
    // A full object, not a spread of the class instance: spreading would drop
    // the prototype methods and produce a different failure than the one under
    // test.
    const throwing: BuildWorker = {
      type: "claude_code",
      capabilities: worker.capabilities,
      availability: () => ({ available: true }),
      isDispatching: () => false,
      cancel: () => false,
      dispatch: async () => {
        throw new Error("adapter exploded");
      },
    };
    const restore = registerWorker(throwing);
    try {
      const runId = await createRun("throwing adapter");
      await post(`/api/build-runs/${runId}/start`);
      const run = await waitForState(runId, ["FAILED"]);
      const failed = (await events(runId)).find((e) => e.event_type === "run.failed");
      expect(run.state).toBe("FAILED");
      expect(failed?.details.failure_cause).toContain("adapter exploded");
    } finally {
      restore();
    }
  });

  it("fails the run when the workspace is outside the authorized root", async () => {
    const runId = await createRun("escape attempt");
    await pool.query(`UPDATE build_runs SET worktree_path = $1 WHERE id = $2`, [
      resolve(workspaceRoot, "..", "somewhere-else"),
      runId,
    ]);
    await post(`/api/build-runs/${runId}/start`);
    const run = await waitForState(runId, ["FAILED"]);

    const failed = (await events(runId)).find((e) => e.event_type === "run.failed");
    expect(run.state).toBe("FAILED");
    expect(failed?.details.failure_kind).toBe("workspace_violation");
    // Nothing was dispatched: the boundary is checked before the worker runs.
    expect(worker.dispatches).toHaveLength(0);
  });
});

describe("stop cancels the real worker", () => {
  it("cancels an in-flight dispatch and leaves the run STOPPED", async () => {
    worker.script = { holdMs: 10_000, outcome: { status: "completed", metrics: {} } };
    const runId = await createRun("cancel run");
    await post(`/api/build-runs/${runId}/start`);

    // Wait until the worker is genuinely in flight before stopping it.
    const deadline = Date.now() + 5_000;
    while (!worker.isDispatching(runId) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(worker.isDispatching(runId)).toBe(true);

    const stopped = await post<Run>(`/api/build-runs/${runId}/stop`, { note: "enough" });
    expect(stopped.body.state).toBe("STOPPED");

    // The cancelled dispatch must not then overwrite the operator's decision.
    await new Promise((r) => setTimeout(r, 500));
    const after = await get<Run>(`/api/build-runs/${runId}`);
    expect(after.body.state).toBe("STOPPED");
    expect(after.body.stop_reason).toBe("enough");

    const types = (await events(runId)).map((e) => e.event_type);
    expect(types).toContain("run.dispatch_cancelled");
    expect(types).not.toContain("run.failed");
  });

  it("a worker that finishes after an operator stop cannot revive the run", async () => {
    worker.script = { holdMs: 300, outcome: { status: "completed", metrics: {} } };
    const runId = await createRun("late completion");
    await post(`/api/build-runs/${runId}/start`);
    await new Promise((r) => setTimeout(r, 50));
    await post(`/api/build-runs/${runId}/stop`);

    await new Promise((r) => setTimeout(r, 800));
    const after = await get<Run>(`/api/build-runs/${runId}`);
    expect(after.body.state).toBe("STOPPED");
  });
});

describe("pause is honest about what it can do", () => {
  it("says out loud that an in-flight dispatch will finish", async () => {
    worker.script = { holdMs: 1_500, outcome: { status: "completed", metrics: {} } };
    const runId = await createRun("pause run");
    await post(`/api/build-runs/${runId}/start`);

    const deadline = Date.now() + 5_000;
    while (!worker.isDispatching(runId) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }

    const paused = await post<Run>(`/api/build-runs/${runId}/pause`);
    expect(paused.body.state).toBe("PAUSED");

    await new Promise((r) => setTimeout(r, 300));
    const deferred = (await events(runId)).find((e) => e.event_type === "run.pause_deferred");
    expect(deferred).toBeDefined();
    expect(deferred?.severity).toBe("warn");
    expect(deferred?.details.mid_dispatch_pause_supported).toBe(false);
  });
});

describe("resume continues the same worker session", () => {
  it("passes the earlier session id back to the worker", async () => {
    worker.script = { outcome: { status: "completed", metrics: {}, sessionId: "session-abc" } };
    const runId = await createRun("resume run");
    await post(`/api/build-runs/${runId}/start`);
    await waitForState(runId, ["REVIEWING"]);

    // Put the run back into a state a resume is legal from, the way an
    // operator would: review asks for a revision, then instruct.
    await post(`/api/build-runs/${runId}/review`, {
      reviewer: "test",
      verdict: "REVISION_REQUIRED",
    });
    worker.dispatches.length = 0;
    await post(`/api/build-runs/${runId}/instruct`, { instruction: "try again" });
    await waitForState(runId, ["REVIEWING"]);

    expect(worker.dispatches).toHaveLength(1);
    // The session is recovered from the timeline, not from process memory, so
    // a restarted API can still continue the conversation.
    expect(worker.dispatches[0].sessionId).toBe("session-abc");
    expect(worker.dispatches[0].reason).toBe("revision");
    expect(worker.dispatches[0].instructions).toEqual(["try again"]);
  });
});

describe("instructions are queued, not faked", () => {
  it("queues an instruction that arrives mid-dispatch and says so", async () => {
    worker.script = { holdMs: 800, outcome: { status: "completed", metrics: {} } };
    const runId = await createRun("queued instruction");
    await post(`/api/build-runs/${runId}/start`);

    const deadline = Date.now() + 5_000;
    while (!worker.isDispatching(runId) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }

    await post(`/api/build-runs/${runId}/instruct`, { instruction: "also do this" });

    const queued = (await events(runId)).find((e) => e.event_type === "run.instruction_queued");
    expect(queued).toBeDefined();
    expect(queued?.details.mid_dispatch_instructions_supported).toBe(false);

    // And it is genuinely delivered on the next dispatch, not dropped.
    await waitForState(runId, ["REVIEWING"], 20_000);
    expect(worker.dispatches).toHaveLength(2);
    expect(worker.dispatches[1].instructions).toEqual(["also do this"]);
    expect(worker.dispatches[1].reason).toBe("instruction");
  });
});

describe("the runner cannot bypass Build Control gates", () => {
  it("never advances a run past review or approval on its own", async () => {
    const runId = await createRun("gate run");
    await post(`/api/build-runs/${runId}/start`);
    await waitForState(runId, ["REVIEWING"]);

    // Nothing the worker did produced a review row or an approval.
    const reviews = await pool.query(`SELECT 1 FROM build_reviews WHERE build_run_id = $1`, [runId]);
    const approvals = await pool.query(`SELECT 1 FROM build_approvals WHERE build_run_id = $1`, [
      runId,
    ]);
    expect(reviews.rowCount).toBe(0);
    expect(approvals.rowCount).toBe(0);
  });
});
