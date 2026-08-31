// The v0.1 independent reviewer: a second, separate Claude Code process.
//
// "Independent" is enforced structurally, not by instruction:
//
//   * A NEW session every time. No --session-id, no --resume, and no access to
//     the worker's conversation. The reviewer cannot see what the worker was
//     thinking, only what it did.
//   * READ-ONLY tools. Write, Edit, Bash and every other mutating or
//     command-running tool is denied, so a reviewer physically cannot fix what
//     it is judging, run anything, push, or deploy.
//   * No lifecycle access. It returns a verdict; reviewerService applies it
//     through the same state machine an operator's review goes through.
//
// Provider-neutral above this file: reviewerService knows only BuildReviewer.
// Swapping in a different model or vendor is a new file plus a registry entry.

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import type { Readable } from "node:stream";

import { env } from "../../env.js";
import { resolveWorkerBinary } from "../worker/resolveBinary.js";
import { parseReviewResult } from "./parse.js";
import { buildReviewerPolicy, buildReviewPrompt } from "./prompt.js";
import type { BuildReviewer, ReviewOutcome, ReviewRequest, ReviewerAvailability } from "./types.js";

export const CLAUDE_REVIEWER_NAME = "claude_code_reviewer";

/**
 * Read-only. Notably absent: Write, Edit, NotebookEdit, Bash, PowerShell — a
 * reviewer that can edit the code it is reviewing is not a reviewer.
 */
const ALLOWED_TOOLS = ["Read", "Glob", "Grep"];

/**
 * Everything else, named explicitly rather than relying on the allow-list
 * alone, so a future CLI default cannot quietly widen this.
 */
const DISALLOWED_TOOLS = [
  "Write",
  "Edit",
  "NotebookEdit",
  "Bash",
  "PowerShell",
  "WebFetch",
  "WebSearch",
  "Task",
  "Agent",
  "Artifact",
  "SlashCommand",
  "KillShell",
  "TodoWrite",
];

type ReviewerProcess = ChildProcessByStdio<null, Readable, Readable>;

function killTree(child: ReviewerProcess): void {
  if (child.pid === undefined || child.killed) return;
  if (process.platform === "win32") {
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

/**
 * The reviewer's environment. Same filtering as the worker's, and for the same
 * reason: a review payload already crosses a process boundary, and there is no
 * version of "review this diff" that needs the database URL or the vault key.
 */
export function reviewerEnv(): NodeJS.ProcessEnv {
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
    if (key === "ANTHROPIC_API_KEY") {
      out[key] = value;
      continue;
    }
    if (blocked.some((re) => re.test(key))) continue;
    out[key] = value;
  }
  return out;
}

export function buildReviewerArgs(request: ReviewRequest): string[] {
  const args = [
    "--print",
    // A single JSON document is all we want back; the reviewer's reasoning
    // belongs in its summary, not in a stream we would have to normalize.
    "--output-format",
    "json",
    // No --session-id and no --resume: a fresh session, with no sight of the
    // worker's conversation. This is what makes the review independent.
    "--permission-mode",
    // The reviewer has no mutating tools at all, so there is nothing for a
    // permission prompt to gate. `plan` additionally refuses edits outright.
    "plan",
    "--allowedTools",
    ...ALLOWED_TOOLS,
    "--disallowedTools",
    ...DISALLOWED_TOOLS,
    "--append-system-prompt",
    buildReviewerPolicy(request),
  ];

  if (env.AICONNECT_REVIEWER_MODEL) {
    args.push("--model", env.AICONNECT_REVIEWER_MODEL);
  }

  // Positional and last, so nothing in the payload can be read as a flag.
  args.push(buildReviewPrompt(request));
  return args;
}

export class ClaudeCodeReviewer implements BuildReviewer {
  readonly name = CLAUDE_REVIEWER_NAME;

  availability(): ReviewerAvailability {
    const binary = resolveWorkerBinary(env.CLAUDE_CODE_BIN);
    if (!binary.ok) return { available: false, reason: binary.reason };
    return { available: true };
  }

  async review(request: ReviewRequest): Promise<ReviewOutcome> {
    const availability = this.availability();
    if (!availability.available) {
      return {
        ok: false,
        reason: availability.reason ?? "reviewer unavailable",
        reviewer: this.name,
      };
    }

    const binary = resolveWorkerBinary(env.CLAUDE_CODE_BIN);
    if (!binary.ok) {
      return { ok: false, reason: binary.reason, reviewer: this.name };
    }

    const rawLogPath = reviewLogPathFor(request.task.runId);
    mkdirSync(dirname(rawLogPath), { recursive: true });
    const raw = createWriteStream(rawLogPath, { flags: "a" });

    const args = [...binary.prefixArgs, ...buildReviewerArgs(request)];

    let child: ReviewerProcess;
    try {
      child = spawn(binary.command, args, {
        // The workspace is the reviewer's cwd so Read/Glob/Grep resolve
        // relative paths, but it holds no mutating tool to use them with.
        cwd: request.workspace.repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
        env: reviewerEnv(),
      }) as ReviewerProcess;
    } catch (err) {
      return {
        ok: false,
        reason: `could not start reviewer: ${err instanceof Error ? err.message : String(err)}`,
        reviewer: this.name,
        rawLogPath,
      };
    }

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, env.AICONNECT_REVIEWER_TIMEOUT_MS);
    timer.unref();

    const stdout: string[] = [];
    const stderr: string[] = [];
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      stdout.push(c);
      raw.write(c);
    });
    child.stderr.on("data", (c: string) => {
      stderr.push(c);
      raw.write(`[stderr] ${c}`);
    });

    let spawnError: string | null = null;
    child.on("error", (err) => {
      spawnError = err.message;
    });

    const exitCode = await new Promise<number | null>((resolveExit) => {
      let done = false;
      const finish = (code: number | null) => {
        if (done) return;
        done = true;
        resolveExit(code);
      };
      child.on("close", (code) => finish(code));
      child.on("error", () => finish(null));
    });

    clearTimeout(timer);
    await new Promise<void>((r) => raw.end(r));

    if (timedOut) {
      return {
        ok: false,
        reason: `reviewer exceeded the ${env.AICONNECT_REVIEWER_TIMEOUT_MS}ms timeout`,
        reviewer: this.name,
        rawLogPath,
      };
    }
    if (spawnError) {
      return { ok: false, reason: `reviewer process error: ${spawnError}`, reviewer: this.name, rawLogPath };
    }
    if (exitCode !== 0) {
      const tail = stderr.join("").trim().slice(0, 500);
      return {
        ok: false,
        reason: `reviewer exited with code ${exitCode ?? "unknown"}${tail ? `: ${tail}` : ""}`,
        reviewer: this.name,
        rawLogPath,
      };
    }

    // --output-format json wraps the model's text in an envelope carrying cost
    // and usage. Read the verdict out of the text, and the metrics out of the
    // envelope — but only the metrics that are actually there.
    const envelope = safeJson(stdout.join(""));
    const text =
      envelope && typeof envelope.result === "string" ? envelope.result : stdout.join("");

    const parsed = parseReviewResult(text);
    if (!parsed.ok) {
      return {
        ok: false,
        reason: `reviewer did not return a usable verdict: ${parsed.reason}`,
        reviewer: this.name,
        rawLogPath,
      };
    }

    return {
      ok: true,
      result: parsed.result,
      reviewer: this.name,
      reviewerVersion: modelOf(envelope),
      metrics: metricsOf(envelope),
      rawLogPath,
    };
  }
}

function safeJson(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function modelOf(envelope: Record<string, unknown> | null): string | null {
  const usage = envelope?.modelUsage;
  if (usage !== null && typeof usage === "object") {
    const keys = Object.keys(usage as Record<string, unknown>);
    if (keys.length === 1 && keys[0]) return keys[0];
  }
  return env.AICONNECT_REVIEWER_MODEL ?? null;
}

/** Only what the provider reported. Nothing derived, nothing defaulted. */
function metricsOf(envelope: Record<string, unknown> | null): Record<string, unknown> {
  if (!envelope) return {};
  const out: Record<string, unknown> = {};
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const cost = num(envelope.total_cost_usd);
  const turns = num(envelope.num_turns);
  const duration = num(envelope.duration_ms);
  if (cost !== undefined) out.costUsd = cost;
  if (turns !== undefined) out.turns = turns;
  if (duration !== undefined) out.durationMs = duration;
  const usage = envelope.usage;
  if (usage !== null && typeof usage === "object") {
    const u = usage as Record<string, unknown>;
    const inTok = num(u.input_tokens);
    const outTok = num(u.output_tokens);
    if (inTok !== undefined) out.inputTokens = inTok;
    if (outTok !== undefined) out.outputTokens = outTok;
  }
  return out;
}

export function reviewLogPathFor(runId: string): string {
  const dir = env.AICONNECT_RUNNER_LOG_DIR ?? resolve(tmpdir(), "ai-connect-runs");
  return resolve(dir, runId, `review-${randomUUID()}.json`);
}

export const claudeCodeReviewer = new ClaudeCodeReviewer();
