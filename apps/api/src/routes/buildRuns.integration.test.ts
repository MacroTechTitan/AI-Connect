// Route + database integration tests for DevOS Agentic Build Control.
//
//   pnpm staging:db:up && pnpm db:migrate && pnpm test:integration
//
// These run the real Express app, the real Auth0 JWT middleware, the real
// org-scoping and the real Drizzle queries against a real Postgres — the local
// staging database from docs/STAGING_DATABASE.md. The only substitutions are
// the database itself and the identity provider (an ephemeral keypair on
// 127.0.0.1; see scripts/localIssuer.ts).
//
// What this covers that the unit tests cannot: the transition table is only
// half the lifecycle guarantee. The other half — that the one-active-run
// partial index really rejects a second run, that a state change and its
// timeline event land atomically, that another organization gets a 404 rather
// than a row — lives in Postgres and in the wiring between them.
//
// Every row created here is removed in afterAll.

import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startLocalApi, type LocalApi } from "../scripts/localApiHarness.js";

interface Run {
  id: string;
  project_id: string;
  state: string;
  allowed_actions: string[];
  release_status: string;
  stop_reason: string | null;
  started_at: string | null;
  completed_at: string | null;
}

interface BuildEvent {
  event_type: string;
  severity: string;
  action_required: boolean;
  details: Record<string, unknown>;
}

let api: LocalApi;
let pool: pg.Pool;

const stamp = randomUUID().slice(0, 8);
const OWNER = `it-owner-${stamp}@staging.local`;
const STRANGER = `it-stranger-${stamp}@staging.local`;

let ownerToken: string;
let strangerToken: string;
let projectId: string;

async function post<T = unknown>(path: string, body?: unknown, token = ownerToken) {
  return api.request<T>("POST", path, { token, body });
}
async function get<T = unknown>(path: string, token = ownerToken) {
  return api.request<T>("GET", path, { token });
}

/** Creates a run and drives it to `state`. Returns the run id. */
async function runInState(state: string, title: string): Promise<string> {
  const created = await post<Run>("/api/build-runs", {
    project_id: projectId,
    title,
    goal: "integration fixture",
  });
  expect(created.status).toBe(201);
  const id = created.body.id;

  if (state === "QUEUED") return id;
  await post(`/api/build-runs/${id}/start`);
  if (state === "RUNNING") return id;
  if (state === "PAUSED") {
    await post(`/api/build-runs/${id}/pause`);
    return id;
  }
  if (state === "REVISION_REQUIRED") {
    await post(`/api/build-runs/${id}/review`, {
      reviewer: "test",
      verdict: "REVISION_REQUIRED",
    });
    return id;
  }
  if (state === "AWAITING_APPROVAL") {
    await post(`/api/build-runs/${id}/review`, { reviewer: "test", verdict: "PASS" });
    return id;
  }
  throw new Error(`runInState does not know how to reach ${state}`);
}

/** Moves a run to a terminal state so it stops occupying the project's slot. */
async function release(runId: string): Promise<void> {
  await post(`/api/build-runs/${runId}/stop`, { note: "fixture teardown" });
}

beforeAll(async () => {
  api = await startLocalApi();
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  ownerToken = await api.token(OWNER);
  strangerToken = await api.token(STRANGER);

  // Both identities need their user + organization rows, which /api/me creates.
  expect((await get("/api/me")).status).toBe(200);
  expect((await get("/api/me", strangerToken)).status).toBe(200);

  const project = await post<{ id: string }>("/api/projects", {
    name: `integration ${stamp}`,
  });
  expect(project.status).toBe(201);
  projectId = project.body.id;
});

afterAll(async () => {
  if (pool) {
    const emails = [OWNER, STRANGER];
    // Deleting the organizations cascades projects, which cascades every
    // build_* row. Audit logs are ON DELETE NO ACTION, so they go before users.
    await pool.query(
      `DELETE FROM projects WHERE organization_id IN
         (SELECT organization_id FROM users WHERE email = ANY($1))`,
      [emails],
    );
    await pool.query(
      `DELETE FROM organizations WHERE id IN
         (SELECT organization_id FROM users WHERE email = ANY($1))`,
      [emails],
    );
    await pool.query(
      `DELETE FROM user_audit_logs WHERE user_id IN
         (SELECT id FROM users WHERE email = ANY($1))`,
      [emails],
    );
    await pool.query(`DELETE FROM users WHERE email = ANY($1)`, [emails]);
    await pool.end();
  }
  if (api) await api.stop();
});

describe("POST /api/build-runs", () => {
  it("rejects an unauthenticated caller", async () => {
    const res = await api.request("POST", "/api/build-runs", { token: null });
    expect(res.status).toBe(401);
  });

  it("creates a QUEUED run and persists it", async () => {
    const res = await post<Run>("/api/build-runs", {
      project_id: projectId,
      title: "persisted run",
      goal: "verify the row lands",
      acceptance_criteria: ["a", "b"],
      feature_id: "FEAT-1",
      feature_work_packet: { origin: "integration" },
    });
    expect(res.status).toBe(201);
    expect(res.body.state).toBe("QUEUED");
    expect(res.body.release_status).toBe("NOT_EVALUATED");
    expect(res.body.allowed_actions).toEqual(["start", "stop"]);

    const { rows } = await pool.query(
      `SELECT state, feature_id, acceptance_criteria, feature_work_packet
         FROM build_runs WHERE id = $1`,
      [res.body.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe("QUEUED");
    expect(rows[0].feature_id).toBe("FEAT-1");
    expect(rows[0].acceptance_criteria).toEqual(["a", "b"]);
    expect(rows[0].feature_work_packet).toEqual({ origin: "integration" });

    await release(res.body.id);
  });

  it("writes a run.created event in the same transaction as the run", async () => {
    const res = await post<Run>("/api/build-runs", {
      project_id: projectId,
      title: "event run",
      goal: "verify the timeline",
    });
    const { rows } = await pool.query(
      `SELECT event_type FROM build_events WHERE build_run_id = $1`,
      [res.body.id],
    );
    expect(rows.map((r) => r.event_type)).toEqual(["run.created"]);
    await release(res.body.id);
  });

  it("returns 409 active_run_exists rather than a 500 from the partial index", async () => {
    const first = await runInState("QUEUED", "slot holder");
    const second = await post<{ error: string }>("/api/build-runs", {
      project_id: projectId,
      title: "contender",
      goal: "should be refused",
    });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("active_run_exists");

    // …and the slot frees up the moment the first run reaches a terminal state.
    await release(first);
    const third = await post<Run>("/api/build-runs", {
      project_id: projectId,
      title: "successor",
      goal: "should be allowed",
    });
    expect(third.status).toBe(201);
    await release(third.body.id);
  });

  it("404s a project outside the caller's organization", async () => {
    const res = await post("/api/build-runs", {
      project_id: projectId,
      title: "trespass",
      goal: "should not be created",
    }, strangerToken);
    expect(res.status).toBe(404);
  });

  it("400s a malformed body", async () => {
    const res = await post("/api/build-runs", { project_id: projectId, title: "no goal" });
    expect(res.status).toBe(400);
  });
});

describe("lifecycle transitions", () => {
  it("drives QUEUED -> RUNNING -> PAUSED -> RUNNING", async () => {
    const id = await runInState("QUEUED", "lifecycle");

    const started = await post<Run>(`/api/build-runs/${id}/start`);
    expect(started.body.state).toBe("RUNNING");
    expect(started.body.started_at).toBeTruthy();

    expect((await post<Run>(`/api/build-runs/${id}/pause`)).body.state).toBe("PAUSED");
    expect((await post<Run>(`/api/build-runs/${id}/resume`)).body.state).toBe("RUNNING");

    await release(id);
  });

  it("rejects an illegal transition with 409 and the allowed set", async () => {
    const id = await runInState("QUEUED", "illegal");
    const res = await post<{
      error: string;
      from: string;
      allowed_actions: string[];
    }>(`/api/build-runs/${id}/resume`);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("invalid_transition");
    expect(res.body.from).toBe("QUEUED");
    expect(res.body.allowed_actions).toEqual(["start", "stop"]);

    // The rejected action must not have moved the run or written an event.
    const { rows } = await pool.query(
      `SELECT state, (SELECT count(*)::int FROM build_events WHERE build_run_id = $1) AS events
         FROM build_runs WHERE id = $1`,
      [id],
    );
    expect(rows[0].state).toBe("QUEUED");
    expect(rows[0].events).toBe(1);

    await release(id);
  });

  it("returns a revision instruction to RUNNING", async () => {
    const id = await runInState("REVISION_REQUIRED", "revision");
    const res = await post<Run>(`/api/build-runs/${id}/instruct`, {
      instruction: "address the findings",
    });
    expect(res.body.state).toBe("RUNNING");
    await release(id);
  });

  it("keeps the run in place when instructing a RUNNING worker", async () => {
    const id = await runInState("RUNNING", "instruct running");
    const res = await post<Run>(`/api/build-runs/${id}/instruct`, {
      instruction: "prefer the existing helper",
    });
    expect(res.body.state).toBe("RUNNING");

    const { rows } = await pool.query(
      `SELECT details, action_required FROM build_events
        WHERE build_run_id = $1 AND event_type = 'run.instruction'`,
      [id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].action_required).toBe(true);
    expect(rows[0].details.instruction).toBe("prefer the existing helper");

    await release(id);
  });

  it("records the RUNNING -> REVIEWING pass-through instead of implying a jump", async () => {
    const id = await runInState("RUNNING", "passthrough");
    await post(`/api/build-runs/${id}/review`, { reviewer: "test", verdict: "PASS" });

    const events = await get<{ events: BuildEvent[] }>(`/api/build-runs/${id}/events`);
    const passthrough = events.body.events.find(
      (e) => e.event_type === "run.state_changed" && e.details.to === "REVIEWING",
    );
    expect(passthrough).toBeDefined();
    expect(passthrough?.details.from).toBe("RUNNING");

    await release(id);
  });

  it("persists a stop note as stop_reason", async () => {
    const id = await runInState("QUEUED", "stop note");
    const res = await post<Run>(`/api/build-runs/${id}/stop`, { note: "changed our minds" });
    expect(res.body.state).toBe("STOPPED");
    expect(res.body.stop_reason).toBe("changed our minds");
    expect(res.body.completed_at).toBeTruthy();
    expect(res.body.allowed_actions).toEqual([]);
  });
});

describe("review verdicts and release gates", () => {
  it("routes each verdict to its state and writes a build_reviews row", async () => {
    const cases: { verdict: string; expected: string }[] = [
      { verdict: "PASS", expected: "AWAITING_APPROVAL" },
      { verdict: "REVISION_REQUIRED", expected: "REVISION_REQUIRED" },
      { verdict: "STOP", expected: "STOPPED" },
    ];

    for (const { verdict, expected } of cases) {
      const id = await runInState("RUNNING", `verdict ${verdict}`);
      const res = await post<Run>(`/api/build-runs/${id}/review`, {
        reviewer: "claude-reviewer",
        reviewer_version: "opus-5",
        verdict,
        summary: `verdict ${verdict}`,
        findings: [{ title: "a finding", severity: "warn" }],
      });
      expect(res.body.state).toBe(expected);

      const { rows } = await pool.query(
        `SELECT verdict, reviewer, reviewer_version, findings
           FROM build_reviews WHERE build_run_id = $1`,
        [id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].verdict).toBe(verdict);
      expect(rows[0].reviewer_version).toBe("opus-5");
      expect(rows[0].findings).toHaveLength(1);

      if (expected !== "STOPPED") await release(id);
    }
  });

  it("blocks the release when a REQUIRED gate fails, even on a PASS verdict", async () => {
    const id = await runInState("RUNNING", "blocked gate");
    const res = await post<Run>(`/api/build-runs/${id}/review`, {
      reviewer: "test",
      verdict: "PASS",
      completion_gates: [
        { gate: "tests", status: "PASS", required: true },
        { gate: "docs", status: "FAIL", required: true },
      ],
    });
    expect(res.body.state).toBe("AWAITING_APPROVAL");
    expect(res.body.release_status).toBe("BLOCKED");
    await release(id);
  });

  it("ignores an OPTIONAL gate failure", async () => {
    const id = await runInState("RUNNING", "optional gate");
    const res = await post<Run>(`/api/build-runs/${id}/review`, {
      reviewer: "test",
      verdict: "PASS",
      completion_gates: [
        { gate: "tests", status: "PASS", required: true },
        { gate: "lint", status: "FAIL", required: false },
      ],
    });
    expect(res.body.release_status).toBe("ELIGIBLE");
    await release(id);
  });

  it("400s an unknown verdict", async () => {
    const id = await runInState("RUNNING", "bad verdict");
    const res = await post(`/api/build-runs/${id}/review`, {
      reviewer: "test",
      verdict: "LGTM",
    });
    expect(res.status).toBe(400);
    await release(id);
  });
});

describe("the approval gate", () => {
  it("approves to COMPLETED and records the decision", async () => {
    const id = await runInState("AWAITING_APPROVAL", "approve me");
    const res = await post<Run>(`/api/build-runs/${id}/approve`, { note: "ship it" });

    expect(res.body.state).toBe("COMPLETED");
    expect(res.body.completed_at).toBeTruthy();
    expect(res.body.allowed_actions).toEqual([]);

    const { rows } = await pool.query(
      `SELECT decision, note FROM build_approvals WHERE build_run_id = $1`,
      [id],
    );
    expect(rows).toEqual([{ decision: "APPROVE", note: "ship it" }]);
  });

  it("rejects to REJECTED and records the decision", async () => {
    const id = await runInState("AWAITING_APPROVAL", "reject me");
    const res = await post<Run>(`/api/build-runs/${id}/reject`, { note: "scope crept" });

    expect(res.body.state).toBe("REJECTED");

    const { rows } = await pool.query(
      `SELECT decision, note FROM build_approvals WHERE build_run_id = $1`,
      [id],
    );
    expect(rows).toEqual([{ decision: "REJECT", note: "scope crept" }]);
  });

  it("emits run.rejected, not a misspelled event type", async () => {
    const id = await runInState("AWAITING_APPROVAL", "reject event");
    await post(`/api/build-runs/${id}/reject`);

    const { rows } = await pool.query(
      `SELECT event_type FROM build_events
        WHERE build_run_id = $1 AND event_type LIKE 'run.reject%'`,
      [id],
    );
    expect(rows.map((r) => r.event_type)).toEqual(["run.rejected"]);
  });

  it("does not let approval launder a BLOCKED release into ELIGIBLE", async () => {
    const id = await runInState("RUNNING", "blocked approval");
    await post(`/api/build-runs/${id}/review`, {
      reviewer: "test",
      verdict: "PASS",
      completion_gates: [{ gate: "security", status: "FAIL", required: true }],
    });
    const approved = await post<Run>(`/api/build-runs/${id}/approve`);
    expect(approved.body.state).toBe("COMPLETED");
    expect(approved.body.release_status).toBe("BLOCKED");
  });

  it("409s a second decision on a decided run", async () => {
    const id = await runInState("AWAITING_APPROVAL", "double decision");
    expect((await post(`/api/build-runs/${id}/approve`)).status).toBe(200);
    expect((await post(`/api/build-runs/${id}/approve`)).status).toBe(409);
    expect((await post(`/api/build-runs/${id}/reject`)).status).toBe(409);

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM build_approvals WHERE build_run_id = $1`,
      [id],
    );
    expect(rows[0].n).toBe(1);
  });
});

describe("reads", () => {
  it("lists events newest-first and honours limit", async () => {
    const id = await runInState("RUNNING", "event reads");
    await post(`/api/build-runs/${id}/pause`);
    await post(`/api/build-runs/${id}/resume`);

    const all = await get<{ events: BuildEvent[] }>(`/api/build-runs/${id}/events`);
    expect(all.body.events[0].event_type).toBe("run.resumed");

    const one = await get<{ events: BuildEvent[] }>(`/api/build-runs/${id}/events?limit=1`);
    expect(one.body.events).toHaveLength(1);

    expect((await get(`/api/build-runs/${id}/events?limit=0`)).status).toBe(400);
    expect((await get(`/api/build-runs/${id}/events?limit=501`)).status).toBe(400);

    await release(id);
  });

  it("404s a well-formed but unknown run id", async () => {
    expect((await get(`/api/build-runs/${randomUUID()}`)).status).toBe(404);
  });

  it("404s a malformed run id instead of 500ing", async () => {
    expect((await get("/api/build-runs/not-a-uuid")).status).toBe(404);
  });

  it("400s a malformed project_id filter", async () => {
    expect((await get("/api/build-runs?project_id=nope")).status).toBe(400);
  });
});

describe("organization isolation", () => {
  it("hides another organization's run behind a 404", async () => {
    const id = await runInState("RUNNING", "private run");

    expect((await get(`/api/build-runs/${id}`, strangerToken)).status).toBe(404);
    expect((await get(`/api/build-runs/${id}/events`, strangerToken)).status).toBe(404);
    expect((await post(`/api/build-runs/${id}/stop`, {}, strangerToken)).status).toBe(404);
    expect((await post(`/api/build-runs/${id}/approve`, {}, strangerToken)).status).toBe(404);

    // The refused actions must not have touched the run.
    const after = await get<Run>(`/api/build-runs/${id}`);
    expect(after.body.state).toBe("RUNNING");

    await release(id);
  });

  it("scopes the list to the caller's organization", async () => {
    const mine = await get<{ build_runs: Run[] }>("/api/build-runs");
    const theirs = await get<{ build_runs: Run[] }>("/api/build-runs", strangerToken);

    expect(mine.body.build_runs.length).toBeGreaterThan(0);
    expect(theirs.body.build_runs).toEqual([]);
  });
});
