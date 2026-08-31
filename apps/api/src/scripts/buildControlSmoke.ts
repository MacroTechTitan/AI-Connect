// End-to-end smoke test for the DevOS Agentic Build Control API (Issue #19).
//
//   pnpm --filter @ai-connect/api smoke:build-control
//
// Boots the real API against the local staging database (see
// docs/STAGING_DATABASE.md) behind a throwaway local OIDC issuer, then drives
// every Build Run route through the full supervised lifecycle and the failure
// paths around it. Prints a pass/fail line per check and exits non-zero if any
// check failed.
//
// This is a smoke script, not a test suite: it runs against whatever is in the
// staging database, creates its own organization/project through the API, and
// leaves its rows behind so the timeline can be inspected afterwards. The
// assertion-level equivalent that cleans up after itself is
// src/routes/buildRuns.integration.test.ts.

import { randomUUID } from "node:crypto";

import { startLocalApi, type LocalApi } from "./localApiHarness.js";

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed += 1;
    process.stdout.write("  PASS  " + label + "\n");
    return;
  }
  failed += 1;
  process.stdout.write("  FAIL  " + label + "\n");
  if (detail !== undefined) {
    process.stdout.write("        got: " + JSON.stringify(detail) + "\n");
  }
}

function section(title: string): void {
  process.stdout.write("\n" + title + "\n" + "-".repeat(title.length) + "\n");
}

interface Run {
  id: string;
  state: string;
  allowed_actions: string[];
  release_status: string;
  stop_reason: string | null;
  started_at: string | null;
  completed_at: string | null;
  project_id: string;
}

async function main(): Promise<void> {
  const api: LocalApi = await startLocalApi();
  process.stdout.write(
    "AI Connect Build Control smoke\n" +
      "  api      : " + api.baseUrl + "\n" +
      "  database : " + api.target.user + "@" + api.target.host + ":" +
      api.target.port + "/" + api.target.database +
      " (" + (api.target.isLocal ? "LOCAL" : "REMOTE-ACKNOWLEDGED") + ")\n" +
      "  issuer   : " + api.issuer.issuer + " (ephemeral)\n",
  );

  const stamp = randomUUID().slice(0, 8);
  const ownerEmail = "smoke-" + stamp + "@staging.local";
  const strangerEmail = "stranger-" + stamp + "@staging.local";

  const owner = await api.token(ownerEmail);
  const stranger = await api.token(strangerEmail);

  const post = <T>(p: string, body?: unknown, token: string = owner) =>
    api.request<T>("POST", p, { token, body });
  const get = <T>(p: string, token: string = owner) =>
    api.request<T>("GET", p, { token });

  try {
    // -----------------------------------------------------------------------
    section("Preconditions");

    const health = await api.request<{ status: string }>("GET", "/health", {
      token: null,
    });
    check("GET /health is 200 and DB-free", health.status === 200, health.body);

    const anon = await api.request("GET", "/api/build-runs", { token: null });
    check("GET /api/build-runs without a token is 401", anon.status === 401, anon.body);

    const badToken = await api.request("GET", "/api/build-runs", {
      token: "not-a-jwt",
    });
    check(
      "GET /api/build-runs with a junk token is 401",
      badToken.status === 401,
      badToken.body,
    );

    const me = await get<{ id: string; organization: { id: string } | null }>("/api/me");
    check(
      "GET /api/me creates the user + organization on first call",
      me.status === 200 && Boolean(me.body.organization?.id),
      me.body,
    );

    const project = await post<{ id: string }>("/api/projects", {
      name: "Build Control smoke " + stamp,
      description: "Created by scripts/buildControlSmoke.ts",
    });
    check(
      "POST /api/projects creates a project",
      project.status === 201 || project.status === 200,
      project.body,
    );
    const projectId = project.body.id;
    if (!projectId) throw new Error("no project id — cannot continue");

    // -----------------------------------------------------------------------
    section("Run 1 — the full happy path with a blocked release gate");

    const bad = await post("/api/build-runs", { project_id: projectId });
    check("create without a goal is 400 invalid_body", bad.status === 400, bad.body);

    const foreign = await post("/api/build-runs", {
      project_id: randomUUID(),
      title: "t",
      goal: "g",
    });
    check("create against an unknown project is 404", foreign.status === 404, foreign.body);

    const created = await post<Run>("/api/build-runs", {
      project_id: projectId,
      title: "Add the Run Inspector",
      goal: "Ship the read-only Build Run inspector",
      acceptance_criteria: ["Timeline renders", "No production writes"],
      out_of_scope: ["The Claude Code runner"],
      stop_and_ask: ["Any schema change"],
      feature_id: "FEAT-BUILD-CONTROL",
      feature_work_packet: { source: "smoke" },
    });
    check(
      "create returns 201 QUEUED",
      created.status === 201 && created.body.state === "QUEUED",
      created.body,
    );
    check(
      "QUEUED allows exactly start+stop",
      JSON.stringify(created.body.allowed_actions) === JSON.stringify(["start", "stop"]),
      created.body.allowed_actions,
    );
    check(
      "a fresh run is release NOT_EVALUATED",
      created.body.release_status === "NOT_EVALUATED",
      created.body.release_status,
    );
    const runId = created.body.id;

    const dupe = await post("/api/build-runs", {
      project_id: projectId,
      title: "second",
      goal: "second",
    });
    check(
      "a second active run on the same project is 409 active_run_exists",
      dupe.status === 409 && (dupe.body as { error?: string }).error === "active_run_exists",
      dupe.body,
    );

    const resumeTooEarly = await post("/api/build-runs/" + runId + "/resume");
    check(
      "resume from QUEUED is 409 invalid_transition",
      resumeTooEarly.status === 409 &&
        (resumeTooEarly.body as { error?: string }).error === "invalid_transition",
      resumeTooEarly.body,
    );

    const started = await post<Run>("/api/build-runs/" + runId + "/start");
    check(
      "start -> RUNNING",
      started.status === 200 && started.body.state === "RUNNING",
      started.body,
    );
    check("start stamps started_at", Boolean(started.body.started_at), started.body.started_at);

    const paused = await post<Run>("/api/build-runs/" + runId + "/pause", {
      note: "operator stepped away",
    });
    check("pause -> PAUSED", paused.body.state === "PAUSED", paused.body);

    const resumed = await post<Run>("/api/build-runs/" + runId + "/resume");
    check("resume -> RUNNING", resumed.body.state === "RUNNING", resumed.body);

    const instructed = await post<Run>("/api/build-runs/" + runId + "/instruct", {
      instruction: "Prefer the existing orgScopeFilter helper",
    });
    check(
      "instruct from RUNNING keeps RUNNING",
      instructed.status === 200 && instructed.body.state === "RUNNING",
      instructed.body,
    );

    const emptyInstruct = await post("/api/build-runs/" + runId + "/instruct", {
      instruction: "",
    });
    check("instruct with an empty instruction is 400", emptyInstruct.status === 400, emptyInstruct.body);

    const revision = await post<Run>("/api/build-runs/" + runId + "/review", {
      reviewer: "claude-reviewer",
      verdict: "REVISION_REQUIRED",
      summary: "Org scoping missing on the events query",
      findings: [{ title: "Unscoped SELECT", severity: "error", target: "routes/x.ts" }],
    });
    check(
      "review REVISION_REQUIRED from RUNNING -> REVISION_REQUIRED",
      revision.body.state === "REVISION_REQUIRED",
      revision.body,
    );

    const revised = await post<Run>("/api/build-runs/" + runId + "/instruct", {
      instruction: "Add the org filter and re-run",
    });
    check(
      "instruct from REVISION_REQUIRED returns the run to RUNNING",
      revised.body.state === "RUNNING",
      revised.body,
    );

    const passReview = await post<Run>("/api/build-runs/" + runId + "/review", {
      reviewer: "claude-reviewer",
      reviewer_version: "opus-5",
      verdict: "PASS",
      summary: "Implementation matches the acceptance criteria",
      completion_gates: [
        { gate: "tests", status: "PASS", required: true },
        { gate: "docs", status: "FAIL", required: true, detail: "No SPRINT_LOG entry" },
      ],
    });
    check(
      "review PASS -> AWAITING_APPROVAL",
      passReview.body.state === "AWAITING_APPROVAL",
      passReview.body,
    );
    check(
      "a failing required gate makes the release BLOCKED despite a PASS verdict",
      passReview.body.release_status === "BLOCKED",
      passReview.body.release_status,
    );

    const approved = await post<Run>("/api/build-runs/" + runId + "/approve", {
      note: "shipping anyway",
    });
    check("approve -> COMPLETED", approved.body.state === "COMPLETED", approved.body);
    check(
      "approve stamps completed_at",
      Boolean(approved.body.completed_at),
      approved.body.completed_at,
    );
    check(
      "approve does NOT launder a BLOCKED release into ELIGIBLE",
      approved.body.release_status === "BLOCKED",
      approved.body.release_status,
    );
    check(
      "a terminal run offers no actions",
      Array.isArray(approved.body.allowed_actions) && approved.body.allowed_actions.length === 0,
      approved.body.allowed_actions,
    );

    const restart = await post("/api/build-runs/" + runId + "/start");
    check("start on a COMPLETED run is 409", restart.status === 409, restart.body);
    const reapprove = await post("/api/build-runs/" + runId + "/approve");
    check("approving a COMPLETED run again is 409", reapprove.status === 409, reapprove.body);

    // -----------------------------------------------------------------------
    section("Run 1 — event timeline");

    const events = await get<{
      events: { event_type: string; details: Record<string, unknown> }[];
    }>("/api/build-runs/" + runId + "/events");
    const types = events.body.events.map((e) => e.event_type);
    const expected = [
      "run.created",
      "run.started",
      "run.paused",
      "run.resumed",
      "run.instruction",
      "run.state_changed",
      "run.reviewed",
      "run.approved",
    ];
    const missing = expected.filter((t) => !types.includes(t));
    check("every lifecycle action left an event", missing.length === 0, { missing, types });
    check(
      "the RUNNING -> REVIEWING pass-through is recorded, not implied",
      events.body.events.some(
        (e) => e.event_type === "run.state_changed" && e.details?.to === "REVIEWING",
      ),
      types,
    );
    check("events are newest-first", types[0] === "run.approved", types);

    const badLimit = await get("/api/build-runs/" + runId + "/events?limit=0");
    check("events?limit=0 is 400", badLimit.status === 400, badLimit.body);
    const hugeLimit = await get("/api/build-runs/" + runId + "/events?limit=501");
    check("events?limit=501 is 400", hugeLimit.status === 400, hugeLimit.body);

    // -----------------------------------------------------------------------
    section("Run 2 — reject path with a clean release gate");

    const run2 = await post<Run>("/api/build-runs", {
      project_id: projectId,
      title: "Second run",
      goal: "Exercise the reject path",
    });
    check("a new run is allowed once the previous one is terminal", run2.status === 201, run2.body);

    await post("/api/build-runs/" + run2.body.id + "/start");
    const run2Review = await post<Run>("/api/build-runs/" + run2.body.id + "/review", {
      reviewer: "claude-reviewer",
      verdict: "PASS",
      completion_gates: [
        { gate: "tests", status: "PASS", required: true },
        { gate: "lint", status: "FAIL", required: false },
      ],
    });
    check(
      "only REQUIRED gate failures block a release",
      run2Review.body.release_status === "ELIGIBLE",
      run2Review.body.release_status,
    );

    const rejected = await post<Run>("/api/build-runs/" + run2.body.id + "/reject", {
      note: "Scope crept past the out-of-scope list",
    });
    check("reject -> REJECTED", rejected.body.state === "REJECTED", rejected.body);

    // -----------------------------------------------------------------------
    section("Run 3 — operator stop");

    const run3 = await post<Run>("/api/build-runs", {
      project_id: projectId,
      title: "Third run",
      goal: "Exercise operator stop",
    });
    const stopped = await post<Run>("/api/build-runs/" + run3.body.id + "/stop", {
      note: "Superseded by a different approach",
    });
    check("stop from QUEUED -> STOPPED", stopped.body.state === "STOPPED", stopped.body);
    check(
      "the stop note is persisted as stop_reason",
      stopped.body.stop_reason === "Superseded by a different approach",
      stopped.body.stop_reason,
    );

    // -----------------------------------------------------------------------
    section("Run 4 — reviewer STOP verdict");

    const run4 = await post<Run>("/api/build-runs", {
      project_id: projectId,
      title: "Fourth run",
      goal: "Exercise the reviewer STOP verdict",
    });
    await post("/api/build-runs/" + run4.body.id + "/start");
    const vetoed = await post<Run>("/api/build-runs/" + run4.body.id + "/review", {
      reviewer: "claude-reviewer",
      verdict: "STOP",
      summary: "The approach is unsafe",
    });
    check("a STOP verdict terminates the run", vetoed.body.state === "STOPPED", vetoed.body);

    const badVerdict = await post("/api/build-runs/" + run4.body.id + "/review", {
      reviewer: "x",
      verdict: "MAYBE",
    });
    check("an unknown verdict is 400", badVerdict.status === 400, badVerdict.body);

    // -----------------------------------------------------------------------
    section("Organization isolation");

    const strangerMe = await get("/api/me", stranger);
    check("a second identity gets its own organization", strangerMe.status === 200, strangerMe.body);

    const peek = await api.request("GET", "/api/build-runs/" + runId, { token: stranger });
    check("another org cannot read this run (404, not 403)", peek.status === 404, peek.body);

    const drive = await api.request("POST", "/api/build-runs/" + runId + "/stop", {
      token: stranger,
    });
    check("another org cannot drive this run", drive.status === 404, drive.body);

    const strangerList = await api.request<{ build_runs: Run[] }>("GET", "/api/build-runs", {
      token: stranger,
    });
    check(
      "another org's list is empty",
      strangerList.status === 200 && strangerList.body.build_runs.length === 0,
      strangerList.body,
    );

    const list = await get<{ build_runs: Run[] }>(
      "/api/build-runs?project_id=" + projectId,
    );
    check(
      "the owner sees all four runs for the project",
      list.body.build_runs.length === 4,
      list.body.build_runs.map((r) => r.state),
    );
  } finally {
    section("Result");
    process.stdout.write("  " + passed + " passed, " + failed + " failed\n\n");
    await api.stop();
  }

  process.exit(failed === 0 ? 0 : 1);
}

await main();
