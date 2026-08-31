// Claude Code stream-json -> normalized Build Control events.
//
// Pure and I/O-free on purpose: every interesting decision about what belongs
// on an operator's timeline is made here and can be tested without spawning a
// process or touching a database.
//
// The guiding rule is that build_events is a SUPERVISION timeline, not a
// transcript. The raw NDJSON is written verbatim to the run's raw log, so
// nothing is lost; what lands in the database is the subset an operator would
// actually want to scroll. Chatty frames (hooks, tool results that succeeded,
// partial messages) are dropped here rather than filtered in the UI later.

import type { NormalizedEvent, WorkerMetrics } from "./types.js";

/** Longest text we put in an event summary. Full text lives in the raw log. */
const MAX_SUMMARY = 300;
/** Longest tool input value we echo into event details. */
const MAX_DETAIL_VALUE = 500;

export const WORKER_EVENT_TYPES = {
  sessionStarted: "worker.session_started",
  message: "worker.message",
  thinking: "worker.thinking",
  toolUse: "worker.tool_use",
  toolError: "worker.tool_error",
  permissionDenied: "worker.permission_denied",
  rateLimited: "worker.rate_limited",
  completed: "worker.completed",
  failed: "worker.failed",
  cancelled: "worker.cancelled",
  unparsable: "worker.unparsable_output",
} as const;

function truncate(text: string, max = MAX_SUMMARY): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1)}…`;
}

// Tools whose use is worth a timeline entry on its own. Read-only lookups are
// noise: an operator does not need a line for every file Claude opened, but
// does need one for every file it changed and every command it ran.
const NOTABLE_TOOLS = new Set([
  "Bash",
  "PowerShell",
  "Edit",
  "Write",
  "NotebookEdit",
  "Task",
  "WebFetch",
  "WebSearch",
]);

/** The most useful single field to show for a tool call. */
function toolTarget(name: string, input: Record<string, unknown>): string | null {
  const candidates = ["file_path", "path", "command", "notebook_path", "url", "pattern"];
  for (const key of candidates) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) {
      return truncate(value, MAX_DETAIL_VALUE);
    }
  }
  if (name === "Task") {
    const d = input.description;
    if (typeof d === "string") return truncate(d, MAX_DETAIL_VALUE);
  }
  return null;
}

interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

/** Anything the CLI can emit on stdout in --output-format stream-json. */
export interface RawStreamEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  uuid?: string;
  message?: { role?: string; content?: ContentBlock[] | string };
  // result frames
  is_error?: boolean;
  stop_reason?: string;
  terminal_reason?: string;
  result?: string;
  num_turns?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  total_cost_usd?: number;
  usage?: Record<string, unknown>;
  modelUsage?: Record<string, { costUSD?: number }>;
  permission_denials?: unknown[];
  // init frames
  model?: string;
  cwd?: string;
  tools?: string[];
  permissionMode?: string;
  claude_code_version?: string;
  // rate limit frames
  rate_limit_info?: Record<string, unknown>;
}

function blocks(message: RawStreamEvent["message"]): ContentBlock[] {
  if (!message) return [];
  const content = message.content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
}

/**
 * Turns one raw stream frame into zero or more timeline events. Returning an
 * array rather than a single event matters: one assistant message can carry
 * several tool calls, and collapsing them would hide work from the operator.
 */
export function normalizeStreamEvent(raw: RawStreamEvent): NormalizedEvent[] {
  switch (raw.type) {
    case "system":
      return normalizeSystem(raw);
    case "assistant":
      return normalizeAssistant(raw);
    case "user":
      return normalizeUser(raw);
    case "rate_limit_event":
      return normalizeRateLimit(raw);
    // `result` is turned into an outcome by the adapter, which knows about
    // exit codes and cancellation too. Nothing to add here.
    case "result":
      return [];
    default:
      return [];
  }
}

function normalizeSystem(raw: RawStreamEvent): NormalizedEvent[] {
  // Hook frames are the worker's own plumbing and mean nothing to an operator.
  if (raw.subtype !== "init") return [];
  return [
    {
      eventType: WORKER_EVENT_TYPES.sessionStarted,
      summary: `Claude Code session started (${raw.model ?? "unknown model"})`,
      severity: "info",
      affectedTarget: raw.cwd ?? null,
      details: {
        model: raw.model ?? null,
        cwd: raw.cwd ?? null,
        permission_mode: raw.permissionMode ?? null,
        claude_code_version: raw.claude_code_version ?? null,
        tool_count: Array.isArray(raw.tools) ? raw.tools.length : null,
      },
    },
  ];
}

function normalizeAssistant(raw: RawStreamEvent): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];

  for (const block of blocks(raw.message)) {
    if (block.type === "text" && block.text?.trim()) {
      events.push({
        eventType: WORKER_EVENT_TYPES.message,
        summary: truncate(block.text),
        severity: "info",
        details: { length: block.text.length },
      });
      continue;
    }

    if (block.type === "tool_use" && block.name) {
      // Every tool call is recorded, but only notable ones are info-level; the
      // rest stay at debug so a timeline view can hide them by default.
      const input = (block.input ?? {}) as Record<string, unknown>;
      const target = toolTarget(block.name, input);
      events.push({
        eventType: WORKER_EVENT_TYPES.toolUse,
        summary: target ? `${block.name}: ${truncate(target, 160)}` : `${block.name}`,
        severity: NOTABLE_TOOLS.has(block.name) ? "info" : "debug",
        affectedTarget: target,
        details: {
          tool: block.name,
          tool_use_id: block.id ?? null,
          ...(target ? { target } : {}),
        },
      });
    }
  }

  return events;
}

function normalizeUser(raw: RawStreamEvent): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];

  for (const block of blocks(raw.message)) {
    if (block.type !== "tool_result") continue;
    // A successful tool result adds nothing the tool_use event did not already
    // say. A failure is the operator's earliest signal that work is going
    // wrong, so it is kept and raised to warn.
    if (!block.is_error) continue;

    events.push({
      eventType: WORKER_EVENT_TYPES.toolError,
      summary: `Tool call failed: ${truncate(stringifyContent(block.content), 200)}`,
      severity: "warn",
      details: {
        tool_use_id: block.tool_use_id ?? null,
        error: truncate(stringifyContent(block.content), MAX_DETAIL_VALUE),
      },
    });
  }

  return events;
}

function normalizeRateLimit(raw: RawStreamEvent): NormalizedEvent[] {
  const info = raw.rate_limit_info ?? {};
  const status = typeof info.status === "string" ? info.status : null;
  // The CLI emits these routinely, including when nothing is wrong. Only a
  // non-allowed status is worth an operator's attention.
  if (status === null || status === "allowed" || status === "allowed_warning") {
    return [];
  }
  return [
    {
      eventType: WORKER_EVENT_TYPES.rateLimited,
      summary: `Worker rate limited (${status})`,
      severity: "warn",
      actionRequired: true,
      details: { rate_limit: info },
    },
  ];
}

function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        typeof c === "object" && c !== null && "text" in c
          ? String((c as { text?: unknown }).text ?? "")
          : "",
      )
      .filter(Boolean)
      .join(" ");
  }
  if (content === null || content === undefined) return "";
  return JSON.stringify(content);
}

// ---------------------------------------------------------------------------
// Result frame
// ---------------------------------------------------------------------------

/**
 * Metrics from a result frame. Every field is read straight from the worker;
 * nothing is derived, estimated, or defaulted. A missing field stays missing,
 * because a fabricated cost is worse than no cost.
 */
export function extractMetrics(raw: RawStreamEvent): WorkerMetrics {
  const usage = (raw.usage ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;

  const models = raw.modelUsage ? Object.keys(raw.modelUsage) : [];

  const metrics: WorkerMetrics = {
    costUsd: num(raw.total_cost_usd),
    inputTokens: num(usage.input_tokens),
    outputTokens: num(usage.output_tokens),
    cacheReadInputTokens: num(usage.cache_read_input_tokens),
    cacheCreationInputTokens: num(usage.cache_creation_input_tokens),
    turns: num(raw.num_turns),
    durationMs: num(raw.duration_ms),
    apiDurationMs: num(raw.duration_api_ms),
    ...(models.length === 1 && models[0] ? { model: models[0] } : {}),
    ...(raw.session_id ? { sessionId: raw.session_id } : {}),
  };

  // Drop undefined keys so callers can tell "not reported" from "reported 0".
  for (const key of Object.keys(metrics) as (keyof WorkerMetrics)[]) {
    if (metrics[key] === undefined) delete metrics[key];
  }
  return metrics;
}

/** Permission denials the worker recorded, as timeline events. */
export function permissionDenialEvents(raw: RawStreamEvent): NormalizedEvent[] {
  const denials = Array.isArray(raw.permission_denials) ? raw.permission_denials : [];
  return denials.map((denial) => {
    const d = (denial ?? {}) as Record<string, unknown>;
    const tool = typeof d.tool_name === "string" ? d.tool_name : "unknown tool";
    return {
      eventType: WORKER_EVENT_TYPES.permissionDenied,
      summary: `Worker was denied ${tool} — the boundary held`,
      severity: "warn" as const,
      actionRequired: true,
      affectedTarget: tool,
      details: { denial: d },
    };
  });
}

/** A line of stdout that was not valid JSON. Recorded, never silently dropped. */
export function unparsableLineEvent(line: string): NormalizedEvent {
  return {
    eventType: WORKER_EVENT_TYPES.unparsable,
    summary: `Unparsable worker output: ${truncate(line, 160)}`,
    severity: "warn",
    details: { line: truncate(line, MAX_DETAIL_VALUE) },
  };
}

/**
 * The one-line "what is happening now" an operator sees on the run. Derived
 * from the same events, so it can never disagree with the timeline.
 */
export function activityFor(event: NormalizedEvent): string | null {
  switch (event.eventType) {
    case WORKER_EVENT_TYPES.sessionStarted:
      return "Worker session started";
    case WORKER_EVENT_TYPES.toolUse:
      return truncate(event.summary, 200);
    case WORKER_EVENT_TYPES.message:
      return truncate(event.summary, 200);
    case WORKER_EVENT_TYPES.toolError:
      return truncate(event.summary, 200);
    default:
      return null;
  }
}
