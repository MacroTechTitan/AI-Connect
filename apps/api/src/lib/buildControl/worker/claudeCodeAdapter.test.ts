import { describe, expect, it } from "vitest";

import { buildArgs, claudeCodeWorker } from "./claudeCodeAdapter.js";
import type { WorkerRunContext } from "./types.js";

// The argument vector IS the security boundary. Everything the prose policy
// asks for politely, these flags enforce — so they are asserted rather than
// assumed, and a future refactor that drops one fails here.

const ctx = (over: Partial<WorkerRunContext> = {}): WorkerRunContext => ({
  runId: "11111111-1111-1111-1111-111111111111",
  organizationId: "22222222-2222-2222-2222-222222222222",
  projectId: "33333333-3333-3333-3333-333333333333",
  title: "Add the Run Inspector",
  goal: "Ship the read-only inspector",
  acceptanceCriteria: ["Timeline renders"],
  outOfScope: ["The reviewer"],
  stopAndAsk: ["Any schema change"],
  featureId: "FEAT-1",
  featureWorkPacket: { origin: "test" },
  workspace: {
    repoRoot: "/srv/repos/project",
    branch: "build/abc",
    allowedRoot: "/srv/repos",
  },
  sessionId: null,
  instructions: [],
  reason: "start",
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

describe("invocation", () => {
  it("runs non-interactively with a parseable event stream", () => {
    const args = buildArgs(ctx(), "sid");
    expect(args).toContain("--print");
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
    // stream-json in print mode emits only a final result without --verbose,
    // which would leave the timeline empty.
    expect(args).toContain("--verbose");
  });

  it("confines the worker to the resolved workspace", () => {
    const args = buildArgs(ctx(), "sid");
    expect(args[args.indexOf("--add-dir") + 1]).toBe("/srv/repos/project");
  });

  it("passes the prompt positionally so it can never be read as a flag", () => {
    const args = buildArgs(ctx({ title: "--dangerously-skip-permissions" }), "sid");
    const last = args[args.length - 1];
    expect(last.startsWith("--")).toBe(false);
    expect(last).toContain("Build Run");
  });
});

describe("session handling", () => {
  it("assigns the session id on a fresh run rather than discovering it", () => {
    const args = buildArgs(ctx({ sessionId: null }), "assigned-id");
    expect(args[args.indexOf("--session-id") + 1]).toBe("assigned-id");
    expect(args).not.toContain("--resume");
  });

  it("resumes the same session on a later dispatch", () => {
    const args = buildArgs(ctx({ sessionId: "existing-id" }), "existing-id");
    expect(args[args.indexOf("--resume") + 1]).toBe("existing-id");
    expect(args).not.toContain("--session-id");
  });

  it("reports resumable sessions as a real capability", () => {
    expect(claudeCodeWorker.capabilities.resumableSessions).toBe(true);
  });
});

describe("the tool boundary", () => {
  it("allows the tools a build task genuinely needs", () => {
    const allowed = flagValues(buildArgs(ctx(), "sid"), "--allowedTools");
    for (const tool of ["Read", "Write", "Edit", "Bash", "Glob", "Grep"]) {
      expect(allowed, tool).toContain(tool);
    }
  });

  it("removes the tools that could take a run outside its remit", () => {
    const denied = flagValues(buildArgs(ctx(), "sid"), "--disallowedTools");
    for (const tool of ["WebFetch", "WebSearch", "Task"]) {
      expect(denied, tool).toContain(tool);
    }
  });

  it("blocks publishing and remote-mutating commands", () => {
    const denied = flagValues(buildArgs(ctx(), "sid"), "--disallowedTools").join(" ");
    for (const command of ["git push", "gh pr", "npm publish", "docker push"]) {
      expect(denied, command).toContain(command);
    }
  });

  it("blocks deployment and cloud control planes", () => {
    const denied = flagValues(buildArgs(ctx(), "sid"), "--disallowedTools").join(" ");
    for (const command of ["vercel", "render", "kubectl", "terraform", "aws", "gcloud"]) {
      expect(denied, command).toContain(`Bash(${command}:*)`);
    }
  });

  it("blocks direct database and migration execution", () => {
    const denied = flagValues(buildArgs(ctx(), "sid"), "--disallowedTools").join(" ");
    expect(denied).toContain("Bash(psql:*)");
    expect(denied).toContain("Bash(supabase:*)");
    expect(denied).toContain("drizzle-kit migrate");
  });

  it("blocks the network reach-arounds that would bypass the tool denials", () => {
    const denied = flagValues(buildArgs(ctx(), "sid"), "--disallowedTools").join(" ");
    for (const command of ["curl", "wget", "ssh", "scp"]) {
      expect(denied, command).toContain(`Bash(${command}:*)`);
    }
  });

  it("never enables permission bypass", () => {
    const args = buildArgs(ctx(), "sid").join(" ");
    expect(args).not.toContain("--allow-dangerously-skip-permissions");
    expect(args).not.toContain("bypassPermissions");
    expect(args[args.indexOf("--permission-mode") + 1]).not.toBe("bypassPermissions");
  });
});

describe("the supervision policy carried into the system prompt", () => {
  const policy = () => {
    const args = buildArgs(ctx(), "sid");
    return args[args.indexOf("--append-system-prompt") + 1];
  };

  it("prohibits merging, deploying and touching production", () => {
    const text = policy();
    expect(text).toMatch(/Do NOT merge/i);
    expect(text).toMatch(/Do NOT deploy/i);
    expect(text).toMatch(/Do NOT touch production/i);
  });

  it("prohibits secret handling and self-approval", () => {
    const text = policy();
    expect(text).toMatch(/rotate secrets|credentials of any kind/i);
    expect(text).toMatch(/approve, review, or sign off on your own work/i);
  });

  it("names the authorized workspace and branch", () => {
    const text = policy();
    expect(text).toContain("/srv/repos/project");
    expect(text).toContain("build/abc");
  });

  it("carries the run's own stop-and-ask conditions", () => {
    expect(policy()).toContain("Any schema change");
  });

  it("always carries the standing stop-and-ask policy", () => {
    const text = policy();
    expect(text).toMatch(/destructive command/i);
    expect(text).toMatch(/migration/i);
    expect(text).toMatch(/security, authentication, authorization/i);
    expect(text).toMatch(/dependency/i);
    expect(text).toMatch(/Scope expansion/i);
  });

  it("tells the worker it does not get to finish the run itself", () => {
    expect(policy()).toMatch(/Do not attempt to mark the run complete/i);
  });
});

describe("the task prompt", () => {
  const prompt = (over: Partial<WorkerRunContext> = {}) => {
    const args = buildArgs(ctx(over), "sid");
    return args[args.length - 1];
  };

  it("gives a fresh run its full brief", () => {
    const text = prompt();
    expect(text).toContain("Ship the read-only inspector");
    expect(text).toContain("Timeline renders");
    expect(text).toContain("The reviewer");
    expect(text).toContain("FEAT-1");
    expect(text).toContain('"origin": "test"');
  });

  it("does not repeat the brief on a resumed session", () => {
    const text = prompt({ sessionId: "existing" });
    // The worker already has this in its conversation; repeating it wastes
    // context and invites it to start over.
    expect(text).not.toContain("Ship the read-only inspector");
    expect(text).toContain("Timeline renders");
  });

  it("delivers queued operator instructions in order", () => {
    const text = prompt({
      sessionId: "existing",
      instructions: ["first thing", "second thing"],
      reason: "instruction",
    });
    expect(text).toContain("1. first thing");
    expect(text).toContain("2. second thing");
    expect(text.indexOf("first thing")).toBeLessThan(text.indexOf("second thing"));
  });

  it("says why it is being dispatched", () => {
    expect(prompt({ sessionId: "e", reason: "revision" })).toMatch(/review asked for revisions/i);
    expect(prompt({ sessionId: "e", reason: "resume" })).toMatch(/resumed/i);
  });

  it("states plainly when no acceptance criteria were given", () => {
    expect(prompt({ acceptanceCriteria: [] })).toMatch(/none specified/i);
  });
});

describe("capabilities are reported honestly", () => {
  it("does not claim mid-dispatch instruction delivery it cannot do", () => {
    // `claude -p` runs autonomously to completion; there is no supported way
    // to hand it a new instruction mid-flight.
    expect(claudeCodeWorker.capabilities.midDispatchInstructions).toBe(false);
  });

  it("does not claim a pause it cannot perform", () => {
    expect(claudeCodeWorker.capabilities.midDispatchPause).toBe(false);
  });

  it("claims cancellation, which it can do", () => {
    expect(claudeCodeWorker.capabilities.cancellable).toBe(true);
  });

  it("reports nothing is dispatching for an unknown run", () => {
    expect(claudeCodeWorker.isDispatching("no-such-run")).toBe(false);
    expect(claudeCodeWorker.cancel("no-such-run")).toBe(false);
  });
});

describe("availability", () => {
  it("is disabled by default, with a reason an operator can act on", () => {
    // The test environment sets no runner variables, which is the same state
    // every cloud instance is in.
    const availability = claudeCodeWorker.availability();
    expect(availability.available).toBe(false);
    expect(availability.reason).toMatch(/AICONNECT_RUNNER_ENABLED|WORKSPACE_ROOT/);
  });

  it("refuses to dispatch when unavailable instead of throwing", async () => {
    const outcome = await claudeCodeWorker.dispatch(ctx(), {
      event: () => undefined,
      activity: () => undefined,
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.failureKind).toBe("worker_not_available");
    expect(outcome.metrics).toEqual({});
  });
});
