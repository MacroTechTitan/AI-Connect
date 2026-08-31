// The supported way to run one supervised Build Run against a real repository,
// end to end, from a terminal.
//
//   pnpm --filter @ai-connect/api dogfood -- \
//     --workspace devos \
//     --title "Write the application architecture page" \
//     --goal-file ./task.md \
//     --criterion "architecture/application-architecture.mdx exists" \
//     --out-of-scope "Editing any other page" \
//     --stop-and-ask "Any dependency or config change"
//
// It boots the API locally against the staging database (docs/STAGING_DATABASE.md)
// behind the throwaway local issuer, creates a project and a Build Run against
// the chosen workspace, starts it, follows the timeline, and then runs the
// independent reviewer — stopping at whatever the reviewer decides.
//
// It is a THIN client. Every decision it makes is an ordinary authenticated API
// call, listed in --print-api, so the same thing can be done by hand or by a UI
// later. Nothing here is a private back door into Build Control.
//
// It never approves. A PASS leaves the run in AWAITING_APPROVAL and prints the
// command a human runs to approve it, because that gate is the point.

import { readFileSync } from "node:fs";

import { loadLocalEnv } from "../lib/loadLocalEnv.js";
import { requireNonProductionTarget } from "./dbTarget.js";

// Environment first — lib/env.ts parses process.env at import time.
loadLocalEnv();
requireNonProductionTarget(process.env.DATABASE_URL);

if (!process.env.AICONNECT_RUNNER_ENABLED) process.env.AICONNECT_RUNNER_ENABLED = "1";

const { startLocalApi } = await import("./localApiHarness.js");

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

interface Args {
  workspace?: string;
  title?: string;
  goal?: string;
  goalFile?: string;
  criteria: string[];
  outOfScope: string[];
  stopAndAsk: string[];
  featureId?: string;
  project?: string;
  reviewer?: string;
  autoReview: boolean;
  listWorkspaces: boolean;
  printApi: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    criteria: [],
    outOfScope: [],
    stopAndAsk: [],
    autoReview: true,
    listWorkspaces: false,
    printApi: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] ?? "";
    const next = () => argv[++i] ?? "";
    switch (flag) {
      case "--workspace": args.workspace = next(); break;
      case "--title": args.title = next(); break;
      case "--goal": args.goal = next(); break;
      case "--goal-file": args.goalFile = next(); break;
      case "--criterion": args.criteria.push(next()); break;
      case "--out-of-scope": args.outOfScope.push(next()); break;
      case "--stop-and-ask": args.stopAndAsk.push(next()); break;
      case "--feature-id": args.featureId = next(); break;
      case "--project": args.project = next(); break;
      case "--reviewer": args.reviewer = next(); break;
      case "--no-review": args.autoReview = false; break;
      case "--list-workspaces": args.listWorkspaces = true; break;
      case "--print-api": args.printApi = true; break;
      case "-h":
      case "--help": args.help = true; break;
      // pnpm forwards its own `--` separator through to the script.
      case "--":
        break;
      default:
        if (flag.startsWith("--")) {
          process.stderr.write(`unknown flag: ${flag}\n`);
          process.exit(2);
        }
    }
  }
  return args;
}

const HELP = `
AI Connect Build Control — supervised dogfood run

  --workspace <key>       repository to work in (see --list-workspaces)
  --title <text>          run title
  --goal <text>           what to do
  --goal-file <path>      read the goal from a file instead
  --criterion <text>      acceptance criterion (repeatable)
  --out-of-scope <text>   out-of-scope rule (repeatable)
  --stop-and-ask <text>   stop-and-ask condition (repeatable)
  --feature-id <id>       Feature Registry reference
  --project <name>        project name to create/reuse (default: derived)
  --reviewer <provider>   reviewer provider (default: configured)
  --no-review             stop at REVIEWING; do not run the reviewer
  --list-workspaces       print selectable workspaces and exit
  --print-api             print the equivalent API calls and exit
  -h, --help              this

Requires: AICONNECT_RUNNER_WORKSPACE_ROOT, a staging DATABASE_URL, and Claude
Code installed. See docs/BUILD_CONTROL_RUNNER.md.
`.trim();

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  process.stdout.write(HELP + "\n");
  process.exit(0);
}

// ---------------------------------------------------------------------------

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
  release_status: string;
  stop_reason: string | null;
  allowed_actions: string[];
}

function line(text = ""): void {
  process.stdout.write(text + "\n");
}

function section(title: string): void {
  line();
  line(title);
  line("-".repeat(title.length));
}

async function main(): Promise<void> {
  const api = await startLocalApi();
  const email = process.env.ADMIN_EMAIL ?? "operator@staging.local";
  const token = await api.token(email);

  const post = <T>(path: string, body?: unknown) => api.request<T>("POST", path, { token, body });
  const get = <T>(path: string) => api.request<T>("GET", path, { token });

  let exitCode = 0;
  try {
    // /api/me first: it lazily creates the user and organization.
    await get("/api/me");

    if (args.listWorkspaces) {
      const res = await get<{
        workspace_root: string | null;
        allow_list: boolean;
        workspaces: { key: string; path: string | null; available: boolean; reason?: string }[];
      }>("/api/build-runs/workspaces");
      section("Selectable workspaces");
      line(`  root      : ${res.body.workspace_root ?? "(not configured)"}`);
      line(`  allow-list: ${res.body.allow_list ? "yes" : "no (any git repo under the root)"}`);
      line();
      for (const ws of res.body.workspaces) {
        line(
          `  ${ws.available ? "OK  " : "--  "} ${ws.key.padEnd(24)} ${ws.path ?? ws.reason ?? ""}`,
        );
      }
      line();
      return;
    }

    const goal = args.goalFile ? readFileSync(args.goalFile, "utf8").trim() : args.goal;
    if (!args.workspace || !args.title || !goal) {
      process.stderr.write("--workspace, --title and --goal (or --goal-file) are required\n\n");
      process.stderr.write(HELP + "\n");
      exitCode = 2;
      return;
    }

    const createBody = {
      title: args.title,
      goal,
      acceptance_criteria: args.criteria,
      out_of_scope: args.outOfScope,
      stop_and_ask: args.stopAndAsk,
      workspace: args.workspace,
      ...(args.featureId ? { feature_id: args.featureId } : {}),
    };

    if (args.printApi) {
      section("Equivalent API calls");
      line("  GET  /api/build-runs/workspaces");
      line("  POST /api/projects            { \"name\": \"<project>\" }");
      line("  POST /api/build-runs          " + JSON.stringify({ project_id: "<id>", ...createBody }));
      line("  POST /api/build-runs/:id/start");
      line("  GET  /api/build-runs/:id            (poll until REVIEWING)");
      line("  POST /api/build-runs/:id/review/independent");
      line("  POST /api/build-runs/:id/approve    (a human, after reading the review)");
      line();
      return;
    }

    // --- preflight --------------------------------------------------------
    section("Preflight");
    const status = await get<{
      enabled: boolean;
      reason?: string;
      capabilities?: Record<string, boolean>;
      reviewer: { enabled: boolean; reason?: string; provider: string };
    }>("/api/build-runs/runner");
    line(`  runner   : ${status.body.enabled ? "ready" : `NOT READY — ${status.body.reason}`}`);
    line(
      `  reviewer : ${status.body.reviewer.enabled ? `ready (${status.body.reviewer.provider})` : `NOT READY — ${status.body.reviewer.reason}`}`,
    );
    if (!status.body.enabled) {
      exitCode = 1;
      return;
    }

    // --- project ----------------------------------------------------------
    const projectName = args.project ?? `dogfood-${args.workspace}`;
    const existing = await get<{ projects: { id: string; name: string }[] }>("/api/projects");
    let projectId = existing.body.projects?.find((p) => p.name === projectName)?.id;
    if (!projectId) {
      const created = await post<{ id: string }>("/api/projects", { name: projectName });
      if (created.status !== 201) {
        line(`  could not create project: ${JSON.stringify(created.body)}`);
        exitCode = 1;
        return;
      }
      projectId = created.body.id;
    }
    line(`  project  : ${projectName} (${projectId})`);

    // --- create + start ---------------------------------------------------
    section("Creating the Build Run");
    const created = await post<Run>("/api/build-runs", { project_id: projectId, ...createBody });
    if (created.status !== 201) {
      line(`  refused: ${JSON.stringify(created.body)}`);
      exitCode = 1;
      return;
    }
    const runId = created.body.id;
    line(`  run      : ${runId}`);
    line(`  workspace: ${created.body.worktree_path}`);
    line(`  branch   : ${created.body.branch_name}`);

    const started = await post<Run>(`/api/build-runs/${runId}/start`, {});
    if (started.status !== 200) {
      line(`  could not start: ${JSON.stringify(started.body)}`);
      exitCode = 1;
      return;
    }

    // --- watch ------------------------------------------------------------
    section("Worker (a real Claude Code process)");
    let run = started.body;
    let lastActivity = "";
    const deadline = Date.now() + 60 * 60 * 1000;
    while (Date.now() < deadline) {
      const res = await get<Run>(`/api/build-runs/${runId}`);
      run = res.body;
      if (run.current_activity && run.current_activity !== lastActivity) {
        lastActivity = run.current_activity;
        line(`  · ${lastActivity}`);
      }
      if (["REVIEWING", "FAILED", "STOPPED", "COMPLETED", "REJECTED"].includes(run.state)) break;
      await new Promise((r) => setTimeout(r, 2000));
    }

    line();
    line(`  state    : ${run.state}`);
    line(`  changed  : ${run.files_changed?.length ?? 0} file(s), +${run.additions ?? "?"}/-${run.deletions ?? "?"}`);
    line(`  cost     : ${run.cost_usd ?? "not reported"}`);

    if (run.state !== "REVIEWING") {
      line();
      line(`  The run ended in ${run.state} rather than reaching review.`);
      if (run.stop_reason) line(`  reason: ${run.stop_reason}`);
      exitCode = 1;
      return;
    }

    if (!args.autoReview) {
      line();
      line("  --no-review was set; stopping at REVIEWING.");
      return;
    }

    // --- independent review ------------------------------------------------
    section("Independent review");
    const review = await post<{ verdict: string; build_run: Run }>(
      `/api/build-runs/${runId}/review/independent`,
      args.reviewer ? { provider: args.reviewer } : {},
    );
    if (review.status !== 200) {
      line(`  review did not produce a verdict: ${JSON.stringify(review.body)}`);
      line("  The run stays in REVIEWING — a failed review is not a verdict.");
      exitCode = 1;
      return;
    }

    line(`  verdict  : ${review.body.verdict}`);
    line(`  state    : ${review.body.build_run.state}`);
    line(`  release  : ${review.body.build_run.release_status}`);

    const reviews = await get<{ events: { event_type: string; summary: string }[] }>(
      `/api/build-runs/${runId}/events?limit=500`,
    );
    const completed = reviews.body.events.find((e) => e.event_type === "review.completed");
    if (completed) line(`  summary  : ${completed.summary}`);

    section("Next");
    switch (review.body.build_run.state) {
      case "AWAITING_APPROVAL":
        line("  The reviewer passed it. A HUMAN now approves or rejects:");
        line(`    POST /api/build-runs/${runId}/approve`);
        line(`    POST /api/build-runs/${runId}/reject`);
        line();
        line("  Build Control will not approve its own work, so this is where it stops.");
        break;
      case "REVISION_REQUIRED":
        line("  The reviewer asked for revisions. Its findings are queued for the");
        line("  worker and will be delivered in the SAME session on the next dispatch:");
        line(`    POST /api/build-runs/${runId}/instruct  {"instruction":"proceed"}`);
        break;
      case "STOPPED":
        line("  The reviewer stopped the run.");
        line(`  reason: ${review.body.build_run.stop_reason ?? "(none recorded)"}`);
        break;
      default:
        line(`  Run is in ${review.body.build_run.state}.`);
    }
    line();
    line(`  Timeline: GET /api/build-runs/${runId}/events?limit=500`);
    line();
  } finally {
    await api.stop();
  }

  process.exit(exitCode);
}

await main();
