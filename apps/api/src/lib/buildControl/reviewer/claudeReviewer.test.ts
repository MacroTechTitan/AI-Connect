import { describe, expect, it } from "vitest";

import { buildReviewerArgs } from "./claudeReviewer.js";
import { buildArgs as buildWorkerArgs } from "../worker/claudeCodeAdapter.js";
import type { ReviewRequest } from "./types.js";
import type { WorkerRunContext } from "../worker/types.js";

// The reviewer's independence is a property of its argument vector, not of its
// prompt. These tests assert the flags that make it structurally unable to
// change what it is judging, so a refactor that drops one fails here.

const request = (over: Partial<ReviewRequest> = {}): ReviewRequest => ({
  task: {
    runId: "11111111-1111-1111-1111-111111111111",
    title: "Write the architecture page",
    goal: "Add architecture/application-architecture.mdx",
    acceptanceCriteria: ["The page exists", "It follows the sibling pages"],
    outOfScope: ["Editing other pages"],
    stopAndAsk: ["Any dependency change"],
  },
  feature: { featureId: "FEAT-1", workPacket: { origin: "test" } },
  workspace: { repoRoot: "/srv/repos/devos", branch: "build/abc", baseCommit: "deadbeef" },
  events: [
    { at: "2026-08-31T00:00:00.000Z", type: "worker.tool_use", severity: "info", summary: "Write: a.mdx", target: "a.mdx" },
  ],
  diff: {
    filesChanged: ["architecture/application-architecture.mdx"],
    additions: 42,
    deletions: 0,
    patch: "--- /dev/null\n+++ b/architecture/application-architecture.mdx\n+# Title\n",
    patchTruncated: false,
    unmeasured: [],
  },
  validation: { summary: [], completionGates: [] },
  worker: { type: "claude_code", status: "completed", finalMessage: "Wrote the page.", metrics: { costUsd: 0.1 } },
  context: [{ path: "CLAUDE.md", content: "# Project rules", truncated: false }],
  ...over,
});

function flagValues(args: string[], flag: string): string[] {
  const start = args.indexOf(flag);
  if (start === -1) return [];
  const values: string[] = [];
  for (let i = start + 1; i < args.length; i += 1) {
    if (args[i].startsWith("--")) break;
    values.push(args[i]);
  }
  return values;
}

describe("the reviewer cannot change what it reviews", () => {
  const allowed = () => flagValues(buildReviewerArgs(request()), "--allowedTools");
  const denied = () => flagValues(buildReviewerArgs(request()), "--disallowedTools");

  it("is given read-only tools", () => {
    expect(allowed().sort()).toEqual(["Glob", "Grep", "Read"]);
  });

  it("has no tool that can write a file", () => {
    for (const tool of ["Write", "Edit", "NotebookEdit"]) {
      expect(allowed(), tool).not.toContain(tool);
      expect(denied(), tool).toContain(tool);
    }
  });

  it("has no tool that can run a command", () => {
    for (const tool of ["Bash", "PowerShell"]) {
      expect(allowed(), tool).not.toContain(tool);
      expect(denied(), tool).toContain(tool);
    }
  });

  it("cannot reach the network or spawn sub-agents", () => {
    for (const tool of ["WebFetch", "WebSearch", "Task", "Agent"]) {
      expect(denied(), tool).toContain(tool);
    }
  });

  it("never enables permission bypass", () => {
    const args = buildReviewerArgs(request());
    expect(args.join(" ")).not.toContain("bypassPermissions");
    expect(args.join(" ")).not.toContain("--allow-dangerously-skip-permissions");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("plan");
  });
});

describe("the reviewer is independent of the worker", () => {
  it("never resumes or joins the worker's session", () => {
    // This is what makes the review independent: a fresh session with no
    // sight of the worker's reasoning, only of what it did.
    const args = buildReviewerArgs(request());
    expect(args).not.toContain("--resume");
    expect(args).not.toContain("--session-id");
    expect(args).not.toContain("--continue");
  });

  it("shares no tool grant with the worker that could mutate the repo", () => {
    const workerCtx: WorkerRunContext = {
      runId: "r", organizationId: "o", projectId: "p",
      title: "t", goal: "g",
      acceptanceCriteria: [], outOfScope: [], stopAndAsk: [],
      featureId: null, featureWorkPacket: null,
      workspace: { repoRoot: "/srv/repos/devos", branch: "b", allowedRoot: "/srv/repos" },
      sessionId: null, instructions: [], reason: "start",
    };
    const workerAllowed = flagValues(buildWorkerArgs(workerCtx, "sid"), "--allowedTools");
    const reviewerAllowed = flagValues(buildReviewerArgs(request()), "--allowedTools");

    // The worker may write and run commands; the reviewer may do neither.
    expect(workerAllowed).toContain("Write");
    expect(workerAllowed).toContain("Bash");
    for (const tool of reviewerAllowed) {
      expect(["Read", "Glob", "Grep"]).toContain(tool);
    }
  });

  it("asks for a single JSON document rather than a stream to normalize", () => {
    const args = buildReviewerArgs(request());
    expect(args).toContain("--print");
    expect(args[args.indexOf("--output-format") + 1]).toBe("json");
  });

  it("passes the payload positionally so nothing in it reads as a flag", () => {
    const args = buildReviewerArgs(
      request({ task: { ...request().task, title: "--dangerously-skip-permissions" } }),
    );
    const last = args[args.length - 1];
    expect(last.startsWith("--")).toBe(false);
    expect(last).toContain("Build Run under review");
  });
});

describe("the reviewer policy", () => {
  const policy = () => {
    const args = buildReviewerArgs(request());
    return args[args.indexOf("--append-system-prompt") + 1];
  };

  it("states the three verdicts and only those", () => {
    const text = policy();
    expect(text).toContain("PASS");
    expect(text).toContain("REVISION_REQUIRED");
    expect(text).toContain("STOP");
  });

  it("tells the reviewer it does not approve", () => {
    expect(policy()).toMatch(/You also do not approve|a human, who approves/i);
  });

  it("tells the reviewer it cannot change anything", () => {
    // \s+ rather than a literal space: the policy is wrapped prose and the
    // phrase straddles a newline.
    expect(policy()).toMatch(/cannot\s+edit\s+files,\s+run\s+commands/i);
  });

  it("asks for honesty about what could not be verified", () => {
    expect(policy()).toMatch(/Do not guess a verdict you cannot support/i);
  });

  it("explains the redaction marker so it is not reported as a defect", () => {
    expect(policy()).toContain("[REDACTED]");
  });
});

describe("the review payload reaches the reviewer", () => {
  const prompt = (over: Partial<ReviewRequest> = {}) => {
    const args = buildReviewerArgs(request(over));
    return args[args.length - 1];
  };

  it("carries the task, criteria, scope and stop-and-ask rules", () => {
    const text = prompt();
    expect(text).toContain("Add architecture/application-architecture.mdx");
    expect(text).toContain("The page exists");
    expect(text).toContain("Editing other pages");
    expect(text).toContain("Any dependency change");
  });

  it("carries the Feature Work Packet when there is one", () => {
    const text = prompt();
    expect(text).toContain("FEAT-1");
    expect(text).toContain('"origin": "test"');
  });

  it("carries the normalized event summary and the diff", () => {
    const text = prompt();
    expect(text).toContain("worker.tool_use");
    expect(text).toContain("application-architecture.mdx");
    expect(text).toContain("+# Title");
  });

  it("carries architecture and policy context", () => {
    expect(prompt()).toContain("# Project rules");
  });

  it("labels the worker's message as a claim to check, not as evidence", () => {
    const text = prompt();
    expect(text).toContain("Wrote the page.");
    expect(text).toMatch(/claim to check against the diff, not evidence/i);
  });

  it("says plainly when nothing was validated", () => {
    expect(prompt()).toMatch(/No validation results were recorded/i);
  });

  it("flags a truncated diff so the verdict can account for it", () => {
    const base = request();
    const text = prompt({ diff: { ...base.diff, patchTruncated: true } });
    expect(text).toMatch(/This diff was truncated/i);
  });

  it("says plainly when there is no diff at all", () => {
    const base = request();
    const text = prompt({ diff: { ...base.diff, patch: null } });
    expect(text).toMatch(/No diff was available/i);
  });

  it("names files whose contents could not be measured", () => {
    const base = request();
    const text = prompt({ diff: { ...base.diff, unmeasured: ["logo.png"] } });
    expect(text).toContain("logo.png");
    expect(text).toMatch(/treat their contents as unknown/i);
  });
});
