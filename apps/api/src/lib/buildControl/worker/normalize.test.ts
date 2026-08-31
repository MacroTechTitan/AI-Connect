import { describe, expect, it } from "vitest";

import {
  activityFor,
  extractMetrics,
  normalizeStreamEvent,
  permissionDenialEvents,
  unparsableLineEvent,
  WORKER_EVENT_TYPES,
  type RawStreamEvent,
} from "./normalize.js";

// These fixtures are the real shapes emitted by `claude --print
// --output-format stream-json --verbose`, captured from an actual run rather
// than invented, so the normalizer is tested against what the CLI does and not
// against what we assumed it does.

const initFrame: RawStreamEvent = {
  type: "system",
  subtype: "init",
  session_id: "b60bd3e8-7a70-478f-b7a6-21d970192f53",
  model: "claude-opus-5",
  cwd: "/repo",
  permissionMode: "acceptEdits",
  claude_code_version: "2.1.251",
  tools: ["Read", "Write", "Bash"],
};

const resultFrame: RawStreamEvent = {
  type: "result",
  subtype: "success",
  is_error: false,
  stop_reason: "end_turn",
  terminal_reason: "completed",
  result: "Created GREETING.md",
  num_turns: 2,
  duration_ms: 4355,
  duration_api_ms: 4317,
  total_cost_usd: 0.146954,
  session_id: "b60bd3e8-7a70-478f-b7a6-21d970192f53",
  usage: {
    input_tokens: 4,
    output_tokens: 185,
    cache_read_input_tokens: 33478,
    cache_creation_input_tokens: 12557,
  },
  modelUsage: { "claude-opus-5": { costUSD: 0.146954 } },
  permission_denials: [],
};

describe("normalizeStreamEvent — what reaches the timeline", () => {
  it("turns an init frame into a session-started event", () => {
    const [event, ...rest] = normalizeStreamEvent(initFrame);
    expect(rest).toEqual([]);
    expect(event.eventType).toBe(WORKER_EVENT_TYPES.sessionStarted);
    expect(event.summary).toContain("claude-opus-5");
    expect(event.details).toMatchObject({
      model: "claude-opus-5",
      cwd: "/repo",
      permission_mode: "acceptEdits",
      tool_count: 3,
    });
  });

  it("drops hook frames — they are worker plumbing, not supervision", () => {
    expect(
      normalizeStreamEvent({ type: "system", subtype: "hook_started" }),
    ).toEqual([]);
    expect(
      normalizeStreamEvent({ type: "system", subtype: "hook_response" }),
    ).toEqual([]);
  });

  it("records assistant text", () => {
    const events = normalizeStreamEvent({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "Working on it" }] },
    });
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe(WORKER_EVENT_TYPES.message);
    expect(events[0].summary).toBe("Working on it");
  });

  it("ignores empty assistant text", () => {
    const events = normalizeStreamEvent({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "   " }] },
    });
    expect(events).toEqual([]);
  });

  it("emits one event per tool call so parallel work is not collapsed", () => {
    const events = normalizeStreamEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "Write", input: { file_path: "/repo/a.ts" } },
          { type: "tool_use", id: "t2", name: "Bash", input: { command: "pnpm test" } },
        ],
      },
    });
    expect(events).toHaveLength(2);
    expect(events[0].affectedTarget).toBe("/repo/a.ts");
    expect(events[1].summary).toBe("Bash: pnpm test");
    expect(events.every((e) => e.severity === "info")).toBe(true);
  });

  it("keeps read-only tool calls at debug so the timeline stays readable", () => {
    const [event] = normalizeStreamEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "t", name: "Read", input: { file_path: "/repo/x" } }],
      },
    });
    expect(event.severity).toBe("debug");
    expect(event.eventType).toBe(WORKER_EVENT_TYPES.toolUse);
  });

  it("drops successful tool results and keeps failures", () => {
    const ok = normalizeStreamEvent({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "fine" }],
      },
    });
    expect(ok).toEqual([]);

    const bad = normalizeStreamEvent({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t2", is_error: true, content: "ENOENT: nope" },
        ],
      },
    });
    expect(bad).toHaveLength(1);
    expect(bad[0].eventType).toBe(WORKER_EVENT_TYPES.toolError);
    expect(bad[0].severity).toBe("warn");
    expect(bad[0].summary).toContain("ENOENT");
  });

  it("reports only genuine rate limiting, not routine rate-limit frames", () => {
    expect(
      normalizeStreamEvent({
        type: "rate_limit_event",
        rate_limit_info: { status: "allowed" },
      }),
    ).toEqual([]);

    const throttled = normalizeStreamEvent({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected" },
    });
    expect(throttled).toHaveLength(1);
    expect(throttled[0].actionRequired).toBe(true);
  });

  it("leaves the result frame to the adapter", () => {
    expect(normalizeStreamEvent(resultFrame)).toEqual([]);
  });

  it("ignores frame types it does not know", () => {
    expect(normalizeStreamEvent({ type: "something_new" })).toEqual([]);
  });

  it("truncates a very long message instead of storing a wall of text", () => {
    const [event] = normalizeStreamEvent({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "x".repeat(5000) }] },
    });
    expect(event.summary.length).toBeLessThanOrEqual(300);
    expect(event.summary.endsWith("…")).toBe(true);
    // The full length is still recorded, so nothing pretends to be complete.
    expect(event.details?.length).toBe(5000);
  });
});

describe("extractMetrics — reported, never invented", () => {
  it("reads every metric the worker actually reported", () => {
    expect(extractMetrics(resultFrame)).toEqual({
      costUsd: 0.146954,
      inputTokens: 4,
      outputTokens: 185,
      cacheReadInputTokens: 33478,
      cacheCreationInputTokens: 12557,
      turns: 2,
      durationMs: 4355,
      apiDurationMs: 4317,
      model: "claude-opus-5",
      sessionId: "b60bd3e8-7a70-478f-b7a6-21d970192f53",
    });
  });

  it("omits what was not reported rather than defaulting it to zero", () => {
    const metrics = extractMetrics({ type: "result", subtype: "success" });
    expect(metrics).toEqual({});
    expect("costUsd" in metrics).toBe(false);
    expect("turns" in metrics).toBe(false);
  });

  it("keeps a genuine zero distinguishable from a missing value", () => {
    const metrics = extractMetrics({ type: "result", total_cost_usd: 0 });
    expect(metrics.costUsd).toBe(0);
    expect("outputTokens" in metrics).toBe(false);
  });

  it("does not guess a model when several were used", () => {
    const metrics = extractMetrics({
      type: "result",
      modelUsage: { "claude-opus-5": {}, "claude-haiku-4-5": {} },
    });
    expect("model" in metrics).toBe(false);
  });

  it("ignores non-finite numbers", () => {
    const metrics = extractMetrics({
      type: "result",
      total_cost_usd: Number.NaN,
      num_turns: Number.POSITIVE_INFINITY,
    });
    expect(metrics).toEqual({});
  });
});

describe("permission denials", () => {
  it("reports a denial as a boundary that held, needing attention", () => {
    const events = permissionDenialEvents({
      type: "result",
      permission_denials: [{ tool_name: "Bash", tool_input: { command: "git push" } }],
    });
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe(WORKER_EVENT_TYPES.permissionDenied);
    expect(events[0].severity).toBe("warn");
    expect(events[0].actionRequired).toBe(true);
    expect(events[0].summary).toContain("Bash");
  });

  it("returns nothing when there were none", () => {
    expect(permissionDenialEvents(resultFrame)).toEqual([]);
  });
});

describe("unparsable output", () => {
  it("records a non-JSON line rather than silently dropping it", () => {
    const event = unparsableLineEvent("not json at all");
    expect(event.eventType).toBe(WORKER_EVENT_TYPES.unparsable);
    expect(event.severity).toBe("warn");
    expect(event.details?.line).toBe("not json at all");
  });
});

describe("activityFor", () => {
  it("derives activity from the same events the timeline shows", () => {
    const [toolEvent] = normalizeStreamEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "t", name: "Write", input: { file_path: "/repo/a" } }],
      },
    });
    expect(activityFor(toolEvent)).toBe("Write: /repo/a");
  });

  it("has nothing to say about events that are not progress", () => {
    expect(activityFor({ eventType: "worker.completed", summary: "done" })).toBeNull();
  });
});
