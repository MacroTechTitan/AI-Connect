// Assembling what an independent reviewer is given.
//
// The payload is built from the database and the workspace, never from the
// worker: a reviewer must be able to reach its own conclusion about what
// happened rather than being handed the worker's account of it. The worker's
// closing message IS included, but as one input among several, clearly labelled
// as the worker's claim.
//
// Everything that leaves here is redacted first. The diff and the policy files
// are the two places a credential could realistically be sitting.

import { execFile } from "node:child_process";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { and, asc, eq } from "drizzle-orm";

import { getDb } from "../../../db/client.js";
import { buildEvents, buildRuns } from "../../../db/schema.js";
import { env } from "../../env.js";
import { isInsideRoot } from "../worker/workspace.js";
import { redact } from "./redact.js";
import type {
  ReviewContextFile,
  ReviewEventSummary,
  ReviewGate,
  ReviewRequest,
} from "./types.js";

const execFileAsync = promisify(execFile);

/** Caps. A reviewer with a 200k-line diff is not going to review it well. */
const MAX_PATCH_CHARS = 120_000;
const MAX_CONTEXT_FILE_CHARS = 40_000;
const MAX_EVENTS = 300;
const GIT_TIMEOUT_MS = 30_000;

/** Events that say nothing a reviewer needs. */
const NOISE_EVENTS = new Set(["run.state_changed", "worker.rate_limited"]);

export interface BuildPayloadInput {
  runId: string;
  repoRoot: string;
  branch: string;
  baseCommit: string | null;
}

export interface BuiltPayload {
  request: ReviewRequest;
  /** Rule -> count of redactions applied anywhere in the payload. */
  redactionCounts: Record<string, number>;
}

export async function buildReviewRequest(input: BuildPayloadInput): Promise<BuiltPayload> {
  const { runId, repoRoot, branch, baseCommit } = input;
  const db = getDb();

  const [run] = await db
    .select({
      id: buildRuns.id,
      title: buildRuns.title,
      goal: buildRuns.goal,
      acceptanceCriteria: buildRuns.acceptanceCriteria,
      outOfScope: buildRuns.outOfScope,
      stopAndAsk: buildRuns.stopAndAsk,
      featureId: buildRuns.featureId,
      featureWorkPacket: buildRuns.featureWorkPacket,
      filesChanged: buildRuns.filesChanged,
      additions: buildRuns.additions,
      deletions: buildRuns.deletions,
      validationSummary: buildRuns.validationSummary,
      completionGates: buildRuns.completionGates,
      workerType: buildRuns.workerType,
    })
    .from(buildRuns)
    .where(eq(buildRuns.id, runId))
    .limit(1);

  if (!run) throw new Error(`build run ${runId} not found`);

  const events = await db
    .select({
      eventType: buildEvents.eventType,
      summary: buildEvents.summary,
      severity: buildEvents.severity,
      affectedTarget: buildEvents.affectedTarget,
      occurredAt: buildEvents.occurredAt,
      details: buildEvents.details,
    })
    .from(buildEvents)
    .where(eq(buildEvents.buildRunId, runId))
    .orderBy(asc(buildEvents.occurredAt))
    .limit(MAX_EVENTS + 200);

  const eventSummaries: ReviewEventSummary[] = events
    .filter((e) => !NOISE_EVENTS.has(e.eventType))
    .slice(-MAX_EVENTS)
    .map((e) => ({
      at: (e.occurredAt instanceof Date ? e.occurredAt : new Date(String(e.occurredAt))).toISOString(),
      type: e.eventType,
      severity: e.severity,
      summary: e.summary,
      target: e.affectedTarget ?? null,
    }));

  // The worker's own account, taken from the timeline rather than passed in,
  // so the payload is reproducible from the database alone.
  const completion = [...events].reverse().find((e) => e.eventType === "run.worker_completed");
  const completionDetails = (completion?.details ?? {}) as Record<string, unknown>;
  const dispatchFinished = [...events]
    .reverse()
    .find((e) => e.eventType === "run.dispatch_finished");
  const dispatchDetails = (dispatchFinished?.details ?? {}) as Record<string, unknown>;

  const patch = await capturePatch(repoRoot, baseCommit);
  const unmeasured = collectUnmeasured(events);

  const request: ReviewRequest = {
    task: {
      runId: run.id,
      title: run.title,
      goal: run.goal,
      acceptanceCriteria: asStringList(run.acceptanceCriteria),
      outOfScope: asStringList(run.outOfScope),
      stopAndAsk: asStringList(run.stopAndAsk),
    },
    feature: {
      featureId: run.featureId,
      workPacket:
        run.featureWorkPacket && typeof run.featureWorkPacket === "object"
          ? (run.featureWorkPacket as Record<string, unknown>)
          : null,
    },
    workspace: { repoRoot, branch, baseCommit },
    events: eventSummaries,
    diff: {
      filesChanged: asStringList(run.filesChanged),
      additions: run.additions,
      deletions: run.deletions,
      patch: patch.text,
      patchTruncated: patch.truncated,
      unmeasured,
    },
    validation: {
      summary: Array.isArray(run.validationSummary) ? run.validationSummary : [],
      completionGates: asGates(run.completionGates),
    },
    worker: {
      type: run.workerType,
      status: typeof dispatchDetails.status === "string" ? dispatchDetails.status : "unknown",
      finalMessage: completion?.summary ?? null,
      metrics:
        completionDetails.metrics && typeof completionDetails.metrics === "object"
          ? (completionDetails.metrics as Record<string, unknown>)
          : {},
    },
    context: readContextFiles(repoRoot),
  };

  // One redaction pass over the whole assembled payload, so nothing added
  // later can bypass it by being put on a field that was not thought about.
  const counts: Record<string, number> = {};
  const redacted = redactPayload(request, counts);

  return { request: redacted, redactionCounts: counts };
}

function redactPayload(request: ReviewRequest, counts: Record<string, number>): ReviewRequest {
  const apply = (text: string): string => {
    const report = redact(text);
    for (const [k, n] of Object.entries(report.counts)) counts[k] = (counts[k] ?? 0) + n;
    return report.text;
  };

  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return apply(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = walk(v);
      return out;
    }
    return node;
  };

  return walk(request) as ReviewRequest;
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function asGates(value: unknown): ReviewGate[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (g): g is ReviewGate =>
      g !== null && typeof g === "object" && typeof (g as ReviewGate).gate === "string",
  );
}

function collectUnmeasured(
  events: { eventType: string; details: unknown }[],
): string[] {
  const diffEvent = [...events].reverse().find((e) => e.eventType === "run.diff_captured");
  const details = (diffEvent?.details ?? {}) as Record<string, unknown>;
  return asStringList(details.unmeasured);
}

/**
 * The unified diff of the run's work. Untracked files are included explicitly
 * — a plain `git diff` does not see them, and a reviewer that cannot see a
 * newly created file is reviewing the wrong thing.
 */
async function capturePatch(
  repoRoot: string,
  baseCommit: string | null,
): Promise<{ text: string | null; truncated: boolean }> {
  if (!baseCommit) return { text: null, truncated: false };

  const parts: string[] = [];
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoRoot, "diff", baseCommit, "--"],
      { timeout: GIT_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
    );
    if (stdout.trim()) parts.push(stdout);
  } catch {
    /* fall through — an unavailable diff is reported as null, not faked */
  }

  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoRoot, "ls-files", "--others", "--exclude-standard"],
      { timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
    );
    for (const rel of stdout.split("\n").map((l) => l.trim()).filter(Boolean)) {
      const full = resolve(repoRoot, rel);
      if (!isInsideRoot(repoRoot, full) || !existsSync(full)) continue;
      try {
        if (statSync(full).size > MAX_CONTEXT_FILE_CHARS) {
          parts.push(`--- /dev/null\n+++ b/${rel}\n[new file, too large to include]\n`);
          continue;
        }
        const content = readFileSync(full, "utf8");
        parts.push(
          `--- /dev/null\n+++ b/${rel}\n` +
            content.split("\n").map((l) => `+${l}`).join("\n") +
            "\n",
        );
      } catch {
        parts.push(`--- /dev/null\n+++ b/${rel}\n[new file, unreadable]\n`);
      }
    }
  } catch {
    /* untracked enumeration is best effort */
  }

  if (parts.length === 0) return { text: null, truncated: false };

  const joined = parts.join("\n");
  if (joined.length <= MAX_PATCH_CHARS) return { text: joined, truncated: false };
  return {
    text: joined.slice(0, MAX_PATCH_CHARS) + "\n[diff truncated]\n",
    truncated: true,
  };
}

/**
 * Architecture and policy files the reviewer judges against, named by the
 * operator via AICONNECT_REVIEWER_CONTEXT_FILES. Read-only, workspace-relative,
 * and containment-checked — a configured path cannot reach outside the repo.
 */
function readContextFiles(repoRoot: string): ReviewContextFile[] {
  const configured = env.AICONNECT_REVIEWER_CONTEXT_FILES;
  if (!configured) return [];

  const files: ReviewContextFile[] = [];
  for (const raw of configured.split(",").map((p) => p.trim()).filter(Boolean)) {
    const full = resolve(repoRoot, raw);
    // A configured context path is still not allowed to escape the workspace.
    if (!isInsideRoot(repoRoot, full)) continue;
    if (!existsSync(full)) continue;
    try {
      if (!statSync(full).isFile()) continue;
      const content = readFileSync(full, "utf8");
      files.push({
        path: raw,
        content: content.slice(0, MAX_CONTEXT_FILE_CHARS),
        truncated: content.length > MAX_CONTEXT_FILE_CHARS,
      });
    } catch {
      /* an unreadable context file is simply absent, never faked */
    }
  }
  return files;
}
