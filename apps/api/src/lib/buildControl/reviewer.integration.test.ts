// Independent reviewer integration: real routes, real database, real state
// machine, with a scripted reviewer in place of a model.
//
// What a scripted reviewer can prove — and is the whole point of this file —
// is that a verdict moves the run correctly, lands in build_reviews, and
// cannot bypass a gate. What it cannot prove is that a real model returns a
// usable verdict; scripts/reviewerLiveSmoke.ts does that against a real one.

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Imported dynamically in beforeAll — see runner.integration.test.ts for why.
import { startLocalApi, type LocalApi } from "../../scripts/localApiHarness.js";
import type { registerWorker as RegisterWorker } from "./worker/registry.js";
import type { registerReviewer as RegisterReviewer } from "./reviewer/registry.js";
import type { resetRunnerState as ResetRunnerState } from "./runnerService.js";
import type { BuildWorker, WorkerOutcome, WorkerRunContext, WorkerSink } from "./worker/types.js";
import type {
  BuildReviewer,
  ReviewOutcome,
  ReviewRequest,
  ReviewResult,
} from "./reviewer/types.js";

// ---------------------------------------------------------------------------
// Scripted worker and reviewer
// ---------------------------------------------------------------------------

class ScriptedWorker implements BuildWorker {
  readonly type = "claude_code";
  readonly capabilities = {
    resumableSessions: true,
    midDispatchInstructions: false,
    midDispatchPause: false,
    cancellable: true,
  };
  readonly dispatches: WorkerRunContext[] = [];
  writes: { path: string; content: string }[] = [];

  availability() {
    return { available: true };
  }
  isDispatching(): boolean {
    return false;
  }
  cancel(): boolean {
    return false;
  }
  async dispatch(ctx: WorkerRunContext, _sink: WorkerSink): Promise<WorkerOutcome> {
    this.dispatches.push(structuredClone({ ...ctx, workspace: { ...ctx.workspace } }));
    for (const write of this.writes) {
      writeFileSync(resolve(ctx.workspace.repoRoot, write.path), write.content);
    }
    return {
      status: "completed",
      sessionId: ctx.sessionId ?? "worker-session-1",
      metrics: {},
      finalMessage: "Wrote the file as asked.",
    };
  }
}

class ScriptedReviewer implements BuildReviewer {
  readonly name = "scripted_reviewer";
  available = true;
  /** Set to make the reviewer fail instead of returning a verdict. */
  failWith: string | null = null;
  result: ReviewResult = {
    verdict: "PASS",
    summary: "Looks right.",
    findings: [],
    completionGates: [],
  };
  readonly requests: ReviewRequest[] = [];

  availability() {
    return this.available
      ? { available: true }
      : { available: false, reason: "scripted reviewer disabled" };
  }

  async review(request: ReviewRequest): Promise<ReviewOutcome> {
    this.requests.push(request);
    if (this.failWith) {
      return { ok: false, reason: this.failWith, reviewer: this.name };
    }
    return {
      ok: true,
      result: this.result,
      reviewer: this.name,
      reviewerVersion: "scripted-v1",
      metrics: { costUsd: 0.01 },
    };
  }
}

const worker = new ScriptedWorker();
const reviewer = new ScriptedReviewer();

let registerWorker: typeof RegisterWorker;
let registerReviewer: typeof RegisterReviewer;
let resetRunnerState: typeof ResetRunnerState;
let restoreWorker: () => void;
let restoreReviewer: () => void;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let api: LocalApi;
let pool: pg.Pool;
let repoRoot: string;
let workspaceKey: string;
let baseBranch: string;

const stamp = randomUUID().slice(0, 8);
const OWNER = `reviewer-${stamp}@staging.local`;
let token: string;
let projectId: string;

const post = <T = unknown>(path: string, body?: unknown) =>
  api.request<T>("POST", path, { token, body });
const get = <T = unknown>(path: string) => api.request<T>("GET", path, { token });

interface Run {
  id: string;
  state: string;
  current_activity: string | null;
  release_status: string;
  stop_reason: string | null;
  allowed_actions: string[];
}

interface BuildEvent {
  event_type: string;
  summary: string;
  severity: string;
  details: Record<string, unknown>;
}

async function events(runId: string): Promise<BuildEvent[]> {
  const res = await get<{ events: BuildEvent[] }>(`/api/build-runs/${runId}/events?limit=500`);
  return res.body.events;
}

async function waitForState(runId: string, states: string[], timeoutMs = 15_000): Promise<Run> {
  const deadline = Date.now() + timeoutMs;
  let last: Run | undefined;
  while (Date.now() < deadline) {
    const res = await get<Run>(`/api/build-runs/${runId}`);
    last = res.body;
    if (states.includes(last.state)) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`run ${runId} never reached ${states.join("|")}; last ${last?.state}`);
}

/** Creates a run and drives it to REVIEWING through the real worker path. */
async function runReadyForReview(title: string): Promise<string> {
  const created = await post<Run>("/api/build-runs", {
    project_id: projectId,
    title,
    goal: "reviewer integration fixture",
    acceptance_criteria: ["the file exists"],
    out_of_scope: ["anything else"],
    stop_and_ask: ["a dependency change"],
    feature_id: "FEAT-REVIEW",
    feature_work_packet: { origin: "reviewer-integration" },
    workspace: workspaceKey,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  await post(`/api/build-runs/${created.body.id}/start`);
  await waitForState(created.body.id, ["REVIEWING"]);
  // Getting to REVIEWING is setup. Clearing here lets each test assert about
  // the dispatches ITS actions caused, not the one that got it here.
  worker.dispatches.length = 0;
  return created.body.id;
}

beforeAll(async () => {
  api = await startLocalApi();

  ({ registerWorker } = await import("./worker/registry.js"));
  ({ registerReviewer } = await import("./reviewer/registry.js"));
  ({ resetRunnerState } = await import("./runnerService.js"));
  restoreWorker = registerWorker(worker);
  restoreReviewer = registerReviewer("scripted_reviewer", reviewer);

  const root = process.env.AICONNECT_RUNNER_WORKSPACE_ROOT!;
  workspaceKey = `review-${stamp}`;
  repoRoot = resolve(root, workspaceKey);
  mkdirSync(repoRoot, { recursive: true });
  execFileSync("git", ["-C", repoRoot, "init", "-q"], { windowsHide: true });
  execFileSync("git", ["-C", repoRoot, "config", "user.email", "t@example.com"]);
  execFileSync("git", ["-C", repoRoot, "config", "user.name", "Test"]);
  writeFileSync(resolve(repoRoot, "README.md"), "base\n");
  writeFileSync(resolve(repoRoot, "POLICY.md"), "# Policy\nNo secrets in the repo.\n");
  execFileSync("git", ["-C", repoRoot, "add", "-A"], { windowsHide: true });
  execFileSync("git", ["-C", repoRoot, "commit", "-qm", "init"], { windowsHide: true });
  baseBranch = execFileSync("git", ["-C", repoRoot, "rev-parse", "--abbrev-ref", "HEAD"], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();

  worker.writes = [{ path: "OUTPUT.md", content: "one\ntwo\n" }];

  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  token = await api.token(OWNER);
  expect((await get("/api/me")).status).toBe(200);
  const project = await post<{ id: string }>("/api/projects", { name: `reviewer ${stamp}` });
  expect(project.status).toBe(201);
  projectId = project.body.id;
});

/**
 * Returns the fixture repository to its committed state.
 *
 * Each run gets its own branch, and ensureBranch deliberately refuses to switch
 * branches over uncommitted work — starting a supervised run on top of someone
 * else's changes would make the resulting diff statistics a lie. The scripted
 * worker leaves a file behind on every dispatch, so without this the second
 * test in the file fails with a workspace violation.
 */
function resetRepo(): void {
  execFileSync("git", ["-C", repoRoot, "checkout", "-q", "--", "."], { windowsHide: true });
  execFileSync("git", ["-C", repoRoot, "clean", "-qfd"], { windowsHide: true });
  execFileSync("git", ["-C", repoRoot, "checkout", "-q", baseBranch], { windowsHide: true });
}

afterEach(async () => {
  resetRunnerState?.();
  reviewer.failWith = null;
  reviewer.available = true;
  reviewer.result = { verdict: "PASS", summary: "Looks right.", findings: [], completionGates: [] };
  reviewer.requests.length = 0;
  worker.dispatches.length = 0;

  await pool.query(
    `UPDATE build_runs SET state = 'STOPPED', completed_at = now()
      WHERE project_id = $1 AND state NOT IN ('COMPLETED','FAILED','REJECTED','STOPPED')`,
    [projectId],
  );
  resetRepo();
});

afterAll(async () => {
  restoreWorker?.();
  restoreReviewer?.();
  if (pool) {
    await pool.query(
      `DELETE FROM projects WHERE organization_id IN
         (SELECT organization_id FROM users WHERE email = $1)`, [OWNER]);
    await pool.query(
      `DELETE FROM organizations WHERE id IN
         (SELECT organization_id FROM users WHERE email = $1)`, [OWNER]);
    await pool.query(
      `DELETE FROM user_audit_logs WHERE user_id IN (SELECT id FROM users WHERE email = $1)`,
      [OWNER]);
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

const REVIEW = (runId: string) =>
  post<{ verdict: string; review_id: string; build_run: Run }>(
    `/api/build-runs/${runId}/review/independent`,
    { provider: "scripted_reviewer" },
  );

// ---------------------------------------------------------------------------

describe("the review payload", () => {
  it("carries everything the reviewer needs to judge independently", async () => {
    const runId = await runReadyForReview("payload run");
    await REVIEW(runId);

    expect(reviewer.requests).toHaveLength(1);
    const req = reviewer.requests[0];

    expect(req.task.goal).toBe("reviewer integration fixture");
    expect(req.task.acceptanceCriteria).toEqual(["the file exists"]);
    expect(req.task.outOfScope).toEqual(["anything else"]);
    expect(req.task.stopAndAsk).toEqual(["a dependency change"]);
    expect(req.feature.featureId).toBe("FEAT-REVIEW");
    expect(req.feature.workPacket).toEqual({ origin: "reviewer-integration" });

    // The normalized timeline, the measured diff and the worker's own claim.
    expect(req.events.length).toBeGreaterThan(0);
    expect(req.diff.filesChanged).toContain("OUTPUT.md");
    expect(req.diff.patch).toContain("OUTPUT.md");
    expect(req.worker.finalMessage).toContain("Wrote the file as asked");
    expect(req.worker.type).toBe("claude_code");
    expect(req.workspace.repoRoot).toBe(repoRoot);
    expect(req.workspace.baseCommit).toBeTruthy();
  });

  it("includes the real file contents so a new file can actually be reviewed", async () => {
    // A plain `git diff` does not show untracked files; a reviewer that cannot
    // see a newly created file is reviewing the wrong thing.
    const runId = await runReadyForReview("untracked run");
    await REVIEW(runId);
    expect(reviewer.requests[0].diff.patch).toContain("+one");
  });

  it("reports validation as absent rather than inventing it", async () => {
    const runId = await runReadyForReview("no validation run");
    await REVIEW(runId);
    expect(reviewer.requests[0].validation.summary).toEqual([]);
  });
});

describe("PASS", () => {
  it("moves REVIEWING -> AWAITING_APPROVAL, not to COMPLETED", async () => {
    const runId = await runReadyForReview("pass run");
    const res = await REVIEW(runId);

    expect(res.status).toBe(200);
    expect(res.body.verdict).toBe("PASS");
    // A passing review is not an approval. A human still stands between here
    // and COMPLETED.
    expect(res.body.build_run.state).toBe("AWAITING_APPROVAL");
    expect(res.body.build_run.allowed_actions).toContain("approve");
    expect(res.body.build_run.allowed_actions).toContain("reject");
  });

  it("persists the review in build_reviews with its attribution", async () => {
    reviewer.result = {
      verdict: "PASS",
      summary: "Meets the criteria.",
      findings: [{ title: "Consider a test", severity: "info" }],
      completionGates: [],
    };
    const runId = await runReadyForReview("persist run");
    await REVIEW(runId);

    const { rows } = await pool.query(
      `SELECT reviewer, reviewer_version, verdict, summary, findings
         FROM build_reviews WHERE build_run_id = $1`,
      [runId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].reviewer).toBe("scripted_reviewer");
    expect(rows[0].reviewer_version).toBe("scripted-v1");
    expect(rows[0].verdict).toBe("PASS");
    expect(rows[0].summary).toBe("Meets the criteria.");
    expect(rows[0].findings).toHaveLength(1);
  });

  it("derives release status from the gates, not from the verdict", async () => {
    reviewer.result = {
      verdict: "PASS",
      summary: "Passes, but docs are missing.",
      findings: [],
      completionGates: [
        { gate: "acceptance_criteria", status: "PASS", required: true },
        { gate: "docs", status: "FAIL", required: true },
      ],
    };
    const runId = await runReadyForReview("blocked run");
    const res = await REVIEW(runId);
    expect(res.body.build_run.state).toBe("AWAITING_APPROVAL");
    expect(res.body.build_run.release_status).toBe("BLOCKED");
  });
});

describe("REVISION_REQUIRED", () => {
  beforeEach(() => {
    reviewer.result = {
      verdict: "REVISION_REQUIRED",
      summary: "Two things to fix.",
      findings: [
        { title: "Add the heading", detail: "The page has no H1.", severity: "error", target: "OUTPUT.md" },
      ],
      completionGates: [{ gate: "acceptance_criteria", status: "FAIL", required: true }],
    };
  });

  it("moves the run to REVISION_REQUIRED", async () => {
    const runId = await runReadyForReview("revision run");
    const res = await REVIEW(runId);
    expect(res.body.verdict).toBe("REVISION_REQUIRED");
    expect(res.body.build_run.state).toBe("REVISION_REQUIRED");
    expect(res.body.build_run.current_activity).toMatch(/Revisions requested/i);
  });

  it("queues the findings for the worker rather than restarting it", async () => {
    const runId = await runReadyForReview("queue run");
    await REVIEW(runId);

    const queued = (await events(runId)).find((e) => e.event_type === "run.revision_requested");
    expect(queued).toBeDefined();
    expect(queued?.details.queued_count).toBe(1);
    expect(String(queued?.details.instruction)).toContain("Add the heading");

    // A reviewer that could restart a worker would be driving the run rather
    // than judging it. Leaving REVISION_REQUIRED is the operator's call.
    expect(worker.dispatches).toHaveLength(0);
  });

  it("delivers the findings into the SAME session on the next dispatch", async () => {
    const runId = await runReadyForReview("same session run");
    await REVIEW(runId);

    // The operator decides to continue.
    await post(`/api/build-runs/${runId}/instruct`, { instruction: "go ahead" });
    await waitForState(runId, ["REVIEWING"]);

    expect(worker.dispatches).toHaveLength(1);
    const dispatch = worker.dispatches[0];
    // Same worker session as the first dispatch — the revision continues the
    // conversation rather than starting over.
    expect(dispatch.sessionId).toBe("worker-session-1");
    expect(dispatch.reason).toBe("revision");
    expect(dispatch.instructions.join("\n")).toContain("Add the heading");
    expect(dispatch.instructions.join("\n")).toContain("go ahead");
  });
});

describe("STOP", () => {
  beforeEach(() => {
    reviewer.result = {
      verdict: "STOP",
      summary: "The approach is wrong.",
      findings: [{ title: "Wrong approach", severity: "critical" }],
      completionGates: [],
    };
  });

  it("moves the run to STOPPED, never to FAILED", async () => {
    const runId = await runReadyForReview("stop run");
    const res = await REVIEW(runId);
    // STOP is a supervisory decision, not an execution fault. FAILED would
    // record it as the worker having broken.
    expect(res.body.build_run.state).toBe("STOPPED");
    expect(res.body.build_run.state).not.toBe("FAILED");
  });

  it("attributes the stop to the reviewer", async () => {
    const runId = await runReadyForReview("attribution run");
    const res = await REVIEW(runId);
    expect(res.body.build_run.stop_reason).toContain("independent review");
    expect(res.body.build_run.stop_reason).toContain("scripted_reviewer");
    expect(res.body.build_run.stop_reason).toContain("The approach is wrong.");
  });

  it("still records the review", async () => {
    const runId = await runReadyForReview("stop review row");
    await REVIEW(runId);
    const { rows } = await pool.query(
      `SELECT verdict FROM build_reviews WHERE build_run_id = $1`, [runId]);
    expect(rows[0].verdict).toBe("STOP");
  });
});

describe("a failed review is not a verdict", () => {
  it("leaves the run in REVIEWING when the reviewer fails", async () => {
    reviewer.failWith = "the model returned nothing usable";
    const runId = await runReadyForReview("failed review run");
    const res = await REVIEW(runId);

    expect(res.status).toBe(502);
    // "The reviewer crashed" must never be rendered as "nothing was found
    // wrong" — the run stays exactly where it was.
    const after = await get<Run>(`/api/build-runs/${runId}`);
    expect(after.body.state).toBe("REVIEWING");

    const failed = (await events(runId)).find((e) => e.event_type === "review.failed");
    expect(failed?.severity).toBe("error");
    expect(failed?.details.state_unchanged).toBe("REVIEWING");
  });

  it("writes no build_reviews row for a failed review", async () => {
    reviewer.failWith = "boom";
    const runId = await runReadyForReview("no row run");
    await REVIEW(runId);
    const { rows } = await pool.query(
      `SELECT 1 FROM build_reviews WHERE build_run_id = $1`, [runId]);
    expect(rows).toHaveLength(0);
  });

  it("reports an unavailable reviewer as unavailable, not as a pass", async () => {
    reviewer.available = false;
    const runId = await runReadyForReview("unavailable run");
    const res = await REVIEW(runId);
    expect(res.status).toBe(503);
    expect((await get<Run>(`/api/build-runs/${runId}`)).body.state).toBe("REVIEWING");
  });

  it("400s an unknown provider", async () => {
    const runId = await runReadyForReview("unknown provider run");
    const res = await post(`/api/build-runs/${runId}/review/independent`, {
      provider: "no_such_reviewer",
    });
    expect(res.status).toBe(400);
  });
});

describe("the reviewer cannot bypass Build Control", () => {
  it("cannot be run against a state that is not reviewable", async () => {
    const created = await post<Run>("/api/build-runs", {
      project_id: projectId,
      title: "queued run",
      goal: "not started",
      workspace: workspaceKey,
    });
    const res = await post(`/api/build-runs/${created.body.id}/review/independent`, {
      provider: "scripted_reviewer",
    });
    expect(res.status).toBe(409);
  });

  it("never produces an approval", async () => {
    const runId = await runReadyForReview("no approval run");
    await REVIEW(runId);
    const { rows } = await pool.query(
      `SELECT 1 FROM build_approvals WHERE build_run_id = $1`, [runId]);
    expect(rows).toHaveLength(0);
  });

  it("never reaches COMPLETED on its own", async () => {
    for (const verdict of ["PASS", "REVISION_REQUIRED", "STOP"] as const) {
      reviewer.result = { verdict, summary: "s", findings: [], completionGates: [] };
      const runId = await runReadyForReview(`terminal ${verdict}`);
      const res = await REVIEW(runId);
      expect(res.body.build_run.state, verdict).not.toBe("COMPLETED");
      await pool.query(
        `UPDATE build_runs SET state='STOPPED', completed_at=now()
          WHERE id=$1 AND state NOT IN ('COMPLETED','FAILED','REJECTED','STOPPED')`,
        [runId],
      );
      // afterEach does not run between loop iterations, and each run needs a
      // clean tree to switch onto its own branch.
      resetRepo();
    }
  });

  it("is refused for another organization's run", async () => {
    const runId = await runReadyForReview("isolation run");
    const stranger = await api.token(`stranger-${stamp}@staging.local`);
    await api.request("GET", "/api/me", { token: stranger });
    const res = await api.request("POST", `/api/build-runs/${runId}/review/independent`, {
      token: stranger,
      body: { provider: "scripted_reviewer" },
    });
    expect(res.status).toBe(404);
  });
});

describe("the timeline records the review", () => {
  it("records the start and the verdict", async () => {
    const runId = await runReadyForReview("timeline run");
    await REVIEW(runId);

    const types = (await events(runId)).map((e) => e.event_type);
    expect(types).toContain("review.started");
    expect(types).toContain("review.completed");

    const completed = (await events(runId)).find((e) => e.event_type === "review.completed");
    expect(completed?.details.verdict).toBe("PASS");
    expect(completed?.details.reviewer).toBe("scripted_reviewer");
  });

  it("records redaction counts but never the payload itself", async () => {
    const runId = await runReadyForReview("redaction run");
    await REVIEW(runId);

    const started = (await events(runId)).find((e) => e.event_type === "review.started");
    expect(started?.details).toHaveProperty("redactions");
    // The payload carries a repository diff; it belongs in the reviewer's raw
    // log, not on a timeline anyone with run access can read.
    expect(JSON.stringify(started?.details)).not.toContain("+one");
  });
});
