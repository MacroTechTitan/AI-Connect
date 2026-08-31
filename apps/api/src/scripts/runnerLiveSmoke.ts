// The live proof: a real Claude Code process, driven by Build Control, in a
// disposable repository.
//
//   pnpm --filter @ai-connect/api smoke:runner
//
// This is deliberately NOT a vitest test. It spawns a real worker, costs real
// money, and needs a working Claude Code login on the host — none of which
// belongs in a suite that CI or a colleague runs by reflex. `pnpm
// test:integration` covers the same wiring with a scripted worker, for free
// and deterministically. What only this can prove is that the events Build
// Control normalizes are the events Claude Code actually emits.
//
// It creates its own throwaway git repository under a throwaway workspace
// root, gives Claude a harmless task, and asserts that:
//
//   * a real process was dispatched and reported real progress
//   * normalized worker events reached build_events
//   * the file Claude was asked to write actually exists
//   * diff statistics and cost were captured from the real run
//   * the run reached REVIEWING — and stopped there, awaiting a human
//
// It cleans up the repository and its own database rows afterwards.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

import pg from "pg";

import { loadLocalEnv } from "../lib/loadLocalEnv.js";
import { requireNonProductionTarget } from "./dbTarget.js";

// ---------------------------------------------------------------------------
// Environment — set BEFORE anything imports lib/env.ts
// ---------------------------------------------------------------------------

loadLocalEnv();
requireNonProductionTarget(process.env.DATABASE_URL);

const workspaceRoot = realpathSync(mkdtempSync(resolve(tmpdir(), "aic-live-ws-")));
const repoRoot = resolve(workspaceRoot, "sandbox-repo");
mkdirSync(repoRoot, { recursive: true });

process.env.AICONNECT_RUNNER_ENABLED = "1";
process.env.AICONNECT_RUNNER_WORKSPACE_ROOT = workspaceRoot;
process.env.AICONNECT_RUNNER_LOG_DIR = resolve(workspaceRoot, "logs");
// A harmless one-file task should take well under this. The ceiling is here so
// a wedged worker fails the run rather than hanging the script.
process.env.AICONNECT_RUNNER_TIMEOUT_MS ??= String(10 * 60 * 1000);

// Only now, with the environment settled, may the app be loaded.
const { startLocalApi } = await import("./localApiHarness.js");

// ---------------------------------------------------------------------------

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

function git(...args: string[]): string {
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
}

interface Run {
  id: string;
  state: string;
  current_activity: string | null;
  files_changed: string[];
  additions: number | null;
  deletions: number | null;
  cost_usd: string | null;
  branch_name: string | null;
  worktree_path: string | null;
  stop_reason: string | null;
  allowed_actions: string[];
}

interface BuildEvent {
  event_type: string;
  summary: string;
  severity: string;
  worker: string | null;
  affected_target: string | null;
  details: Record<string, unknown>;
}

const TARGET_FILE = "BUILD_CONTROL_PROOF.md";

async function main(): Promise<void> {
  // --- disposable repository ------------------------------------------------
  git("init", "-q");
  git("config", "user.email", "runner@example.com");
  git("config", "user.name", "Build Control Live Smoke");
  writeFileSync(resolve(repoRoot, "README.md"), "Disposable sandbox repository.\n");
  git("add", "-A");
  git("commit", "-qm", "init");

  const api = await startLocalApi();
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  const stamp = randomUUID().slice(0, 8);
  const email = `live-runner-${stamp}@staging.local`;
  const token = await api.token(email);

  const post = <T>(path: string, body?: unknown) =>
    api.request<T>("POST", path, { token, body });
  const get = <T>(path: string) => api.request<T>("GET", path, { token });

  process.stdout.write(
    "AI Connect Build Control — LIVE Claude Code runner smoke\n" +
      "  api        : " + api.baseUrl + "\n" +
      "  database   : " + api.target.host + ":" + api.target.port + "/" + api.target.database + "\n" +
      "  workspace  : " + repoRoot + "\n" +
      "  raw logs   : " + process.env.AICONNECT_RUNNER_LOG_DIR + "\n",
  );

  try {
    // --- preconditions ------------------------------------------------------
    section("Preconditions");

    // /api/me first: every other route requires a hydrated user, and it is
    // /api/me that lazily creates the user + organization on first sign-in.
    await get("/api/me");

    const runner = await get<{ enabled: boolean; capabilities: Record<string, boolean> }>(
      "/api/build-runs/runner",
    );
    check("the runner reports itself enabled", runner.body.enabled === true, runner.body);
    check(
      "capabilities are reported honestly (no pause it cannot do)",
      runner.body.capabilities?.midDispatchPause === false &&
        runner.body.capabilities?.resumableSessions === true,
      runner.body.capabilities,
    );

    const project = await post<{ id: string }>("/api/projects", {
      name: `live runner ${stamp}`,
    });
    const projectId = project.body.id;

    // --- create and start ---------------------------------------------------
    section("Dispatching a real Claude Code process");

    const created = await post<Run>("/api/build-runs", {
      project_id: projectId,
      title: "Write the Build Control proof file",
      goal:
        `Create a file named ${TARGET_FILE} in the repository root. It must contain ` +
        `exactly one line of text: "Build Control dispatched this." Do not change any ` +
        `other file. Do not run any commands. Then stop and summarize what you did.`,
      acceptance_criteria: [
        `${TARGET_FILE} exists in the repository root`,
        `It contains the single line "Build Control dispatched this."`,
        "No other file is modified",
      ],
      out_of_scope: ["Anything other than creating that one file"],
      stop_and_ask: ["Any change to a file other than the target file"],
      feature_id: "FEAT-LIVE-SMOKE",
      feature_work_packet: { source: "runnerLiveSmoke" },
    });
    check("run created", created.status === 201, created.body);
    const runId = created.body.id;

    // The workspace is not yet modelled on projects, so point the run at the
    // sandbox. The create route deliberately does not accept a path.
    await pool.query(`UPDATE build_runs SET worktree_path = $1 WHERE id = $2`, [repoRoot, runId]);

    const started = await post<Run>(`/api/build-runs/${runId}/start`);
    check("start returns RUNNING immediately, without waiting for the worker",
      started.status === 200 && started.body.state === "RUNNING", started.body);

    // --- watch it work ------------------------------------------------------
    section("Waiting for the worker (this runs a real model)");

    const deadline = Date.now() + 8 * 60 * 1000;
    let run: Run = started.body;
    let lastActivity = "";
    while (Date.now() < deadline) {
      const res = await get<Run>(`/api/build-runs/${runId}`);
      run = res.body;
      if (run.current_activity && run.current_activity !== lastActivity) {
        lastActivity = run.current_activity;
        process.stdout.write("        · " + lastActivity + "\n");
      }
      if (["REVIEWING", "FAILED", "STOPPED", "COMPLETED"].includes(run.state)) break;
      await new Promise((r) => setTimeout(r, 1000));
    }

    // --- the proof ----------------------------------------------------------
    section("What Build Control observed");

    check(
      "the run reached REVIEWING on worker completion",
      run.state === "REVIEWING",
      { state: run.state, activity: run.current_activity },
    );
    check(
      "it stopped at REVIEWING rather than completing itself",
      run.state !== "COMPLETED",
      run.state,
    );
    check(
      "a human approval is still required",
      Array.isArray(run.allowed_actions) && run.allowed_actions.includes("review"),
      run.allowed_actions,
    );

    const eventsRes = await get<{ events: BuildEvent[] }>(
      `/api/build-runs/${runId}/events?limit=500`,
    );
    const events = eventsRes.body.events;
    const types = events.map((e) => e.event_type);

    check("Build Control dispatched a worker", types.includes("run.dispatch_started"), types);
    check(
      "the real Claude Code session announced itself",
      types.includes("worker.session_started"),
      types,
    );
    check(
      "real tool use reached the timeline",
      types.includes("worker.tool_use"),
      types,
    );
    check("the worker reported completion", types.includes("worker.completed"), types);
    check("the run recorded worker completion", types.includes("run.worker_completed"), types);

    const sessionStarted = events.find((e) => e.event_type === "worker.session_started");
    check(
      "the session event carries the real model and workspace",
      typeof sessionStarted?.details.model === "string" &&
        sessionStarted?.details.cwd !== null,
      sessionStarted?.details,
    );

    const toolUse = events.filter((e) => e.event_type === "worker.tool_use");
    check(
      "a real file-writing tool call was recorded with its target",
      toolUse.some((e) => (e.affected_target ?? "").includes(TARGET_FILE)),
      toolUse.map((e) => e.summary),
    );

    check(
      "every worker event is attributed to the worker type",
      events.filter((e) => e.event_type.startsWith("worker.")).every((e) => e.worker === "claude_code"),
      events.filter((e) => e.event_type.startsWith("worker.")).map((e) => e.worker),
    );

    // --- the filesystem does not lie ----------------------------------------
    section("What actually happened on disk");

    const targetPath = resolve(repoRoot, TARGET_FILE);
    check("Claude really created the file", existsSync(targetPath), targetPath);
    if (existsSync(targetPath)) {
      const content = readFileSync(targetPath, "utf8").trim();
      check(
        "the file contains what was asked for",
        content === "Build Control dispatched this.",
        content,
      );
    }

    check(
      "work happened on the run's own branch, not on the base branch",
      git("rev-parse", "--abbrev-ref", "HEAD").trim() === run.branch_name,
      { head: git("rev-parse", "--abbrev-ref", "HEAD").trim(), branch: run.branch_name },
    );

    check(
      "diff statistics were captured from the real workspace",
      Array.isArray(run.files_changed) && run.files_changed.includes(TARGET_FILE),
      run.files_changed,
    );
    check(
      "the line count is measured, not guessed",
      run.additions === 1 && run.deletions === 0,
      { additions: run.additions, deletions: run.deletions },
    );

    // --- metrics ------------------------------------------------------------
    section("Metrics — recorded only because the worker reported them");

    const completed = events.find((e) => e.event_type === "run.worker_completed");
    const metrics = (completed?.details.metrics ?? {}) as Record<string, unknown>;
    check("cost came from the real run", typeof metrics.costUsd === "number", metrics.costUsd);
    check("cost was persisted on the run", run.cost_usd !== null, run.cost_usd);
    check("token usage was captured", typeof metrics.outputTokens === "number", metrics);
    check("the session id was captured for resume", typeof metrics.sessionId === "string", metrics.sessionId);

    const finished = events.find((e) => e.event_type === "run.dispatch_finished");
    const rawLog = finished?.details.raw_log;
    check(
      "the raw transcript was written outside the repository",
      typeof rawLog === "string" && existsSync(rawLog) && !rawLog.startsWith(repoRoot),
      rawLog,
    );
    check(
      "the raw transcript is not in build_events — the timeline is a summary, not a log",
      events.every((e) => JSON.stringify(e).length < 20_000),
      events.length,
    );

    // --- the gates still hold -----------------------------------------------
    section("The worker did not bypass anything");

    const reviews = await pool.query(`SELECT 1 FROM build_reviews WHERE build_run_id = $1`, [runId]);
    const approvals = await pool.query(`SELECT 1 FROM build_approvals WHERE build_run_id = $1`, [runId]);
    check("the worker created no review of its own work", reviews.rowCount === 0, reviews.rowCount);
    check("the worker created no approval", approvals.rowCount === 0, approvals.rowCount);
    check("stop_reason is untouched — that column belongs to the operator", run.stop_reason === null, run.stop_reason);

    const commits = git("rev-list", "--count", "HEAD").trim();
    check("nothing was pushed anywhere (no remote exists)", git("remote").trim() === "", git("remote"));
    check("the base commit history is intact", commits === "1", commits);

    // --- cleanup ------------------------------------------------------------
    await pool.query(
      `DELETE FROM projects WHERE organization_id IN
         (SELECT organization_id FROM users WHERE email = $1)`, [email]);
    await pool.query(
      `DELETE FROM organizations WHERE id IN
         (SELECT organization_id FROM users WHERE email = $1)`, [email]);
    await pool.query(
      `DELETE FROM user_audit_logs WHERE user_id IN (SELECT id FROM users WHERE email = $1)`, [email]);
    await pool.query(`DELETE FROM users WHERE email = $1`, [email]);
    await pool.end();
  } finally {
    section("Result");
    process.stdout.write("  " + passed + " passed, " + failed + " failed\n");
    process.stdout.write("  workspace left at " + workspaceRoot + "\n\n");
    await api.stop();
  }

  if (failed === 0) {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
  process.exit(failed === 0 ? 0 : 1);
}

await main();
