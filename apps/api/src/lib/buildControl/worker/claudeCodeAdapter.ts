// The Claude Code worker adapter.
//
// This is the only file in AI Connect that knows Claude Code exists. It spawns
// the CLI as a child process in non-interactive mode, streams its NDJSON
// output, hands normalized events to the sink, and reports an outcome.
//
// Invocation shape:
//
//   claude --print
//          --output-format stream-json --verbose
//          --session-id <uuid>   (first dispatch)  |  --resume <uuid> (later)
//          --permission-mode acceptEdits
//          --allowedTools <...> --disallowedTools <...>
//          --append-system-prompt <supervision policy>
//          --add-dir <workspace>
//          <task prompt>
//
// Why the CLI rather than an SDK: `start` is specified to dispatch an actual
// process, the repository already spawns local tool processes this way (see
// lib/mode.ts and OPENCLAW_BIN), and it adds no dependency — which under Issue
// #19 would itself be a review gate. The CLI also gives us `--session-id`, so
// Build Control assigns the session identifier instead of discovering it, and
// a resume is therefore deterministic.
//
// Two boundaries the model cannot argue with:
//
//   cwd + --add-dir     execution is confined to the resolved workspace
//   --disallowedTools   the dangerous verbs are removed, not discouraged
//
// The prose policy in prompt.ts is a third layer, and the weakest one. It is
// there so a well-behaved worker stops and asks; it is not what makes this
// safe.

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

import { env } from "../../env.js";
import {
  activityFor,
  extractMetrics,
  normalizeStreamEvent,
  permissionDenialEvents,
  unparsableLineEvent,
  WORKER_EVENT_TYPES,
  type RawStreamEvent,
} from "./normalize.js";
import { buildSupervisionPolicy, buildTaskPrompt, describeDispatch } from "./prompt.js";
import { resolveWorkerBinary } from "./resolveBinary.js";
import type {
  BuildWorker,
  WorkerAvailability,
  WorkerCapabilities,
  WorkerMetrics,
  WorkerOutcome,
  WorkerRunContext,
  WorkerSink,
} from "./types.js";

export const CLAUDE_CODE_WORKER_TYPE = "claude_code";

/**
 * Tools the worker may use. An allow-list, so a tool added to a future Claude
 * Code release is unavailable here until someone deliberately adds it.
 *
 * Bash is allowed because a build task that cannot run its own tests is not
 * doing the job. It is constrained by cwd, by the deny-list below, and by the
 * stop-and-ask policy — not by hope.
 */
const ALLOWED_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Bash",
  "TodoWrite",
  "NotebookEdit",
];

/**
 * Denied outright. These are the verbs that could take a supervised run
 * outside its remit: reaching the network, publishing anything, or spawning
 * sub-agents whose output Build Control would not see on the timeline.
 */
const DISALLOWED_TOOLS = [
  "WebFetch",
  "WebSearch",
  "Task",
  "Agent",
  "Artifact",
  "SlashCommand",
  "KillShell",
];

/**
 * Bash commands blocked by name. The deny-list is a backstop for the prose
 * policy, covering the operations that are irreversible or that leave the
 * workspace: publishing, deploying, and credential access.
 *
 * Claude Code matches these as command prefixes.
 */
const DENIED_BASH = [
  "Bash(git push:*)",
  "Bash(git remote:*)",
  "Bash(gh pr:*)",
  "Bash(gh release:*)",
  "Bash(gh workflow:*)",
  "Bash(npm publish:*)",
  "Bash(pnpm publish:*)",
  "Bash(yarn publish:*)",
  "Bash(vercel:*)",
  "Bash(render:*)",
  "Bash(fly:*)",
  "Bash(heroku:*)",
  "Bash(kubectl:*)",
  "Bash(docker push:*)",
  "Bash(terraform:*)",
  "Bash(aws:*)",
  "Bash(gcloud:*)",
  "Bash(supabase:*)",
  "Bash(psql:*)",
  "Bash(drizzle-kit migrate:*)",
  "Bash(pnpm db:migrate:*)",
  "Bash(curl:*)",
  "Bash(wget:*)",
  "Bash(ssh:*)",
  "Bash(scp:*)",
];

const CAPABILITIES: WorkerCapabilities = {
  // --session-id / --resume: a later dispatch genuinely continues the same
  // conversation. Verified against the CLI, not assumed.
  resumableSessions: true,
  // A `claude -p` dispatch runs autonomously to completion. There is no
  // supported way to hand it a new instruction mid-flight, so Build Control
  // queues instructions and delivers them on the next dispatch rather than
  // pretending they landed immediately.
  midDispatchInstructions: false,
  // Likewise there is no suspend/continue. Freezing the process with SIGSTOP
  // would strand in-flight API requests, so pause takes effect at the dispatch
  // boundary instead of faking a suspend.
  midDispatchPause: false,
  cancellable: true,
};

interface ActiveDispatch {
  child: WorkerProcess;
  sessionId: string;
  cancelled: boolean;
  timedOut: boolean;
  rawLogPath: string;
}

// stdin is "ignore" (a supervised worker must never block on terminal input),
// which is why this is not ChildProcessWithoutNullStreams.
type WorkerProcess = ChildProcessByStdio<null, Readable, Readable>;

function killTree(child: WorkerProcess): void {
  if (child.pid === undefined || child.killed) return;
  if (process.platform === "win32") {
    // The CLI is a node process that spawns its own children; SIGTERM to the
    // parent alone leaves them running.
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    }).on("error", () => child.kill("SIGKILL"));
    return;
  }
  child.kill("SIGTERM");
  setTimeout(() => {
    if (!child.killed) child.kill("SIGKILL");
  }, 5_000).unref();
}

export class ClaudeCodeWorker implements BuildWorker {
  readonly type = CLAUDE_CODE_WORKER_TYPE;
  readonly capabilities = CAPABILITIES;

  private readonly active = new Map<string, ActiveDispatch>();

  availability(): WorkerAvailability {
    if (!env.AICONNECT_RUNNER_ENABLED) {
      return {
        available: false,
        reason:
          "the Build Control runner is disabled — set AICONNECT_RUNNER_ENABLED=1 on a machine with Claude Code installed",
      };
    }
    if (!env.AICONNECT_RUNNER_WORKSPACE_ROOT) {
      return {
        available: false,
        reason:
          "no authorized workspace root — set AICONNECT_RUNNER_WORKSPACE_ROOT",
      };
    }
    // Resolve the executable here, not at spawn time, so an operator finds out
    // Claude Code is missing before they start a run rather than by watching
    // it fail.
    const binary = resolveWorkerBinary(env.CLAUDE_CODE_BIN);
    if (!binary.ok) return { available: false, reason: binary.reason };
    return { available: true };
  }

  isDispatching(runId: string): boolean {
    return this.active.has(runId);
  }

  cancel(runId: string): boolean {
    const dispatch = this.active.get(runId);
    if (!dispatch) return false;
    dispatch.cancelled = true;
    killTree(dispatch.child);
    return true;
  }

  async dispatch(ctx: WorkerRunContext, sink: WorkerSink): Promise<WorkerOutcome> {
    const availability = this.availability();
    if (!availability.available) {
      return {
        status: "failed",
        failureKind: "worker_not_available",
        failureCause: availability.reason ?? "worker unavailable",
        sessionId: ctx.sessionId,
        metrics: {},
      };
    }

    if (this.active.has(ctx.runId)) {
      return {
        status: "failed",
        failureKind: "internal",
        failureCause: "a dispatch is already in flight for this run",
        sessionId: ctx.sessionId,
        metrics: {},
      };
    }

    // Build Control assigns the session id on a fresh run, so a resume never
    // has to go looking for one.
    const sessionId = ctx.sessionId ?? randomUUID();
    const rawLogPath = rawLogPathFor(ctx.runId, sessionId);
    mkdirSync(dirname(rawLogPath), { recursive: true });

    const binary = resolveWorkerBinary(env.CLAUDE_CODE_BIN);
    if (!binary.ok) {
      return {
        status: "failed",
        failureKind: "worker_not_available",
        failureCause: binary.reason,
        sessionId: ctx.sessionId,
        metrics: {},
      };
    }
    const args = [...binary.prefixArgs, ...buildArgs(ctx, sessionId)];
    const bin = binary.command;

    // Note what is NOT emitted here: run.dispatch_started. That is a Build
    // Control lifecycle event and belongs to the runner service — an adapter
    // that forgot to emit it would silently break session recovery for every
    // run. Adapters emit worker.* events only.
    sink.activity(describeDispatch(ctx));

    let child: WorkerProcess;
    try {
      child = spawn(bin, args, {
        cwd: ctx.workspace.repoRoot,
        // stdin is closed: the CLI waits on it otherwise, and a supervised run
        // must never block waiting for terminal input nobody will provide.
        stdio: ["ignore", "pipe", "pipe"],
        // Never shell:true — every argument, including the operator-authored
        // prompt, would then be re-interpreted by cmd.exe or sh.
        shell: false,
        windowsHide: true,
        env: workerEnv(),
      }) as WorkerProcess;
    } catch (err) {
      return {
        status: "failed",
        failureKind: "spawn_failed",
        failureCause: `could not start ${bin}: ${errText(err)}`,
        sessionId,
        metrics: {},
      };
    }

    const dispatch: ActiveDispatch = {
      child,
      sessionId,
      cancelled: false,
      timedOut: false,
      rawLogPath,
    };
    this.active.set(ctx.runId, dispatch);

    const raw: WriteStream = createWriteStream(rawLogPath, { flags: "a" });
    const stderrChunks: string[] = [];
    let resultFrame: RawStreamEvent | null = null;
    let spawnError: string | null = null;

    const timeoutMs = env.AICONNECT_RUNNER_TIMEOUT_MS;
    const timer = setTimeout(() => {
      dispatch.timedOut = true;
      killTree(child);
    }, timeoutMs);
    timer.unref();

    try {
      child.on("error", (err) => {
        spawnError = errText(err);
      });

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderrChunks.push(chunk);
        raw.write(`[stderr] ${chunk}`);
      });

      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      lines.on("line", (line: string) => {
        if (!line.trim()) return;
        raw.write(line + "\n");

        let parsed: RawStreamEvent;
        try {
          parsed = JSON.parse(line) as RawStreamEvent;
        } catch {
          sink.event(unparsableLineEvent(line));
          return;
        }

        if (parsed.type === "result") {
          resultFrame = parsed;
          for (const denial of permissionDenialEvents(parsed)) sink.event(denial);
          return;
        }

        for (const event of normalizeStreamEvent(parsed)) {
          sink.event(event);
          const activity = activityFor(event);
          if (activity) sink.activity(activity);
        }
      });

      const exitCode = await new Promise<number | null>((resolveExit) => {
        let closed = false;
        const done = (code: number | null) => {
          if (closed) return;
          closed = true;
          resolveExit(code);
        };
        child.on("close", (code) => done(code));
        child.on("error", () => done(null));
      });

      await new Promise<void>((r) => raw.end(r));

      return this.buildOutcome({
        ctx,
        dispatch,
        exitCode,
        spawnError,
        resultFrame,
        stderr: stderrChunks.join(""),
        sink,
      });
    } finally {
      clearTimeout(timer);
      this.active.delete(ctx.runId);
    }
  }

  private buildOutcome(input: {
    ctx: WorkerRunContext;
    dispatch: ActiveDispatch;
    exitCode: number | null;
    spawnError: string | null;
    resultFrame: RawStreamEvent | null;
    stderr: string;
    sink: WorkerSink;
  }): WorkerOutcome {
    const { ctx, dispatch, exitCode, spawnError, resultFrame, stderr, sink } = input;
    const metrics: WorkerMetrics = resultFrame ? extractMetrics(resultFrame) : {};
    const base = {
      sessionId: dispatch.sessionId,
      metrics: { ...metrics, sessionId: dispatch.sessionId },
      rawLogPath: dispatch.rawLogPath,
    };

    // Cancellation is checked first: a killed process also exits non-zero, and
    // reporting an operator's stop as an execution failure is exactly the
    // mislabelling FAILED and STOPPED exist to keep apart.
    if (dispatch.cancelled && !dispatch.timedOut) {
      sink.event({
        eventType: WORKER_EVENT_TYPES.cancelled,
        summary: "Worker process cancelled by operator",
        severity: "info",
        details: { session_id: dispatch.sessionId, exit_code: exitCode },
      });
      return { ...base, status: "cancelled" };
    }

    if (dispatch.timedOut) {
      const cause = `worker exceeded the ${env.AICONNECT_RUNNER_TIMEOUT_MS}ms dispatch timeout and was terminated`;
      sink.event(failureEvent(cause, { session_id: dispatch.sessionId }));
      return { ...base, status: "failed", failureKind: "timeout", failureCause: cause };
    }

    if (spawnError) {
      const cause = `worker process error: ${spawnError}`;
      sink.event(failureEvent(cause, { session_id: dispatch.sessionId }));
      return { ...base, status: "failed", failureKind: "spawn_failed", failureCause: cause };
    }

    // The worker's own verdict outranks the exit code when both are present.
    if (resultFrame && resultFrame.is_error === true) {
      const cause = truncateCause(
        resultFrame.result ??
          resultFrame.subtype ??
          "worker reported an error without a message",
      );
      sink.event(
        failureEvent(cause, {
          session_id: dispatch.sessionId,
          subtype: resultFrame.subtype ?? null,
          stop_reason: resultFrame.stop_reason ?? null,
        }),
      );
      return {
        ...base,
        status: "failed",
        failureKind: "worker_reported_error",
        failureCause: cause,
      };
    }

    if (exitCode !== 0) {
      const cause = truncateCause(
        `worker exited with code ${exitCode ?? "unknown"}${
          stderr.trim() ? `: ${stderr.trim()}` : ""
        }`,
      );
      sink.event(
        failureEvent(cause, { session_id: dispatch.sessionId, exit_code: exitCode }),
      );
      return { ...base, status: "failed", failureKind: "nonzero_exit", failureCause: cause };
    }

    if (!resultFrame) {
      const cause =
        "worker exited cleanly but produced no result frame — its output could not be interpreted";
      sink.event(failureEvent(cause, { session_id: dispatch.sessionId }));
      return { ...base, status: "failed", failureKind: "worker_reported_error", failureCause: cause };
    }

    const finalMessage =
      typeof resultFrame.result === "string" ? resultFrame.result : undefined;

    sink.event({
      eventType: WORKER_EVENT_TYPES.completed,
      summary: finalMessage
        ? `Worker finished: ${finalMessage.replace(/\s+/g, " ").trim().slice(0, 250)}`
        : "Worker finished",
      severity: "info",
      details: {
        session_id: dispatch.sessionId,
        stop_reason: resultFrame.stop_reason ?? null,
        terminal_reason: resultFrame.terminal_reason ?? null,
        // Reported verbatim; never filled in when the worker did not measure it.
        ...metricsDetails(metrics),
      },
    });

    return {
      ...base,
      status: "completed",
      ...(finalMessage ? { finalMessage } : {}),
    };
  }
}

function failureEvent(cause: string, details: Record<string, unknown>) {
  return {
    eventType: WORKER_EVENT_TYPES.failed,
    summary: `Worker failed: ${cause}`,
    severity: "error" as const,
    actionRequired: true,
    details: { ...details, failure_cause: cause },
  };
}

function metricsDetails(metrics: WorkerMetrics): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (metrics.costUsd !== undefined) out.cost_usd = metrics.costUsd;
  if (metrics.turns !== undefined) out.turns = metrics.turns;
  if (metrics.durationMs !== undefined) out.duration_ms = metrics.durationMs;
  if (metrics.inputTokens !== undefined) out.input_tokens = metrics.inputTokens;
  if (metrics.outputTokens !== undefined) out.output_tokens = metrics.outputTokens;
  if (metrics.model !== undefined) out.model = metrics.model;
  return out;
}

function truncateCause(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 900 ? `${flat.slice(0, 899)}…` : flat;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function rawLogPathFor(runId: string, sessionId: string): string {
  // Defaults to the OS temp directory, NOT the process cwd: cwd is often a
  // repository, and a transcript written there would show up in the run's own
  // diff statistics as work the worker did.
  const dir = env.AICONNECT_RUNNER_LOG_DIR ?? resolve(tmpdir(), "ai-connect-runs");
  return resolve(dir, runId, `${sessionId}-${Date.now()}.ndjson`);
}

/**
 * Environment for the child. Deliberately a filtered copy rather than a
 * passthrough: a supervised worker has no business inheriting the API's
 * database URL, master key, diagnostics token or platform credentials.
 */
function workerEnv(): NodeJS.ProcessEnv {
  const blocked = [
    /^DATABASE_URL$/,
    /^MASTER_KEY$/,
    /^DIAGNOSTICS_TOKEN$/,
    /^AUTH0_/,
    /^STRIPE_/,
    /^GITHUB_APP_/,
    /^GITHUB_STATE_/,
    /^CLOUDFLARE_/,
    /^AICONNECT_/,
    /SECRET/i,
    /TOKEN$/i,
    /PASSWORD/i,
    /_KEY$/i,
  ];
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    // ANTHROPIC_API_KEY is the one credential the worker legitimately needs,
    // and only when the machine is not using an interactive Claude login.
    if (key === "ANTHROPIC_API_KEY") {
      out[key] = value;
      continue;
    }
    if (blocked.some((re) => re.test(key))) continue;
    out[key] = value;
  }
  return out;
}

export function buildArgs(ctx: WorkerRunContext, sessionId: string): string[] {
  const args = [
    "--print",
    "--output-format",
    "stream-json",
    // stream-json in print mode requires --verbose; without it the CLI emits
    // only the final result and the timeline would have nothing in it.
    "--verbose",
    "--permission-mode",
    // Edits inside the workspace proceed without a prompt (there is no
    // terminal to answer one); everything dangerous is removed by the tool
    // lists rather than left to a prompt nobody can see.
    "acceptEdits",
    "--allowedTools",
    ...ALLOWED_TOOLS,
    "--disallowedTools",
    ...DISALLOWED_TOOLS,
    ...DENIED_BASH,
    "--add-dir",
    ctx.workspace.repoRoot,
    "--append-system-prompt",
    buildSupervisionPolicy(ctx),
  ];

  if (ctx.sessionId === null) {
    args.push("--session-id", sessionId);
  } else {
    args.push("--resume", sessionId);
  }

  if (env.AICONNECT_RUNNER_MODEL) {
    args.push("--model", env.AICONNECT_RUNNER_MODEL);
  }

  // The prompt goes last, positionally, so nothing in it can be read as a flag.
  args.push(buildTaskPrompt(ctx));
  return args;
}

export const claudeCodeWorker = new ClaudeCodeWorker();
