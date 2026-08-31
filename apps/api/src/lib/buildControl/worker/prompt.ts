// Composing what a supervised worker is told.
//
// Two pieces, deliberately separate:
//
//   buildSupervisionPolicy()  the rules, appended to the worker's system
//                             prompt. Identical for every run.
//   buildTaskPrompt()         this run's work: goal, criteria, scope, packet,
//                             and any operator instructions since last time.
//
// The policy is prose because it is addressed to a model. It is NOT the
// security boundary — a model can be talked out of prose. The real boundaries
// are the workspace root (workspace.ts) and the tool allow/deny list
// (claudeCodeAdapter.ts), which the model cannot argue with. The policy exists
// so a well-behaved worker knows to stop and ask rather than blunder into
// something the tool list happens not to have blocked.

import type { DispatchReason, WorkerRunContext } from "./types.js";

/** Formats a list as markdown bullets, or a placeholder when empty. */
function bullets(items: readonly string[], empty: string): string {
  if (items.length === 0) return `_${empty}_`;
  return items.map((i) => `- ${i}`).join("\n");
}

/**
 * The supervision contract. Appended to the worker's system prompt on every
 * dispatch, including resumes — a resumed session must not drift out of it.
 */
export function buildSupervisionPolicy(ctx: WorkerRunContext): string {
  return `
# You are running under AI Connect Build Control

This is a supervised build run. A human operator started it, watches its
timeline, and holds the only approval that can complete it. Your job is the
task below and nothing else.

## Absolute prohibitions

These are not preferences. If the task appears to require any of them, STOP and
say so instead of doing it:

- Do NOT merge anything, open or merge a pull request, or push to a remote.
- Do NOT deploy, trigger a deploy, or touch any hosting platform.
- Do NOT touch production: no production database, no production credentials,
  no production environment variables, no production API.
- Do NOT read, write, print, or rotate secrets, tokens, API keys, or
  credentials of any kind. If you encounter one, do not echo it.
- Do NOT approve, review, or sign off on your own work. Review and approval
  belong to an independent reviewer and to the human operator.
- Do NOT modify Build Control itself to change what you are allowed to do, and
  do NOT attempt to alter the run's state, gates, or approvals.
- Do NOT work outside the authorized workspace: ${ctx.workspace.repoRoot}
  You are on branch ${ctx.workspace.branch}. Stay on it.

## Stop and ask

Stop and report instead of proceeding when you hit any of these. The operator
will send an instruction back and you will continue in this same session:

${bullets(ctx.stopAndAsk, "no run-specific stop-and-ask conditions were set")}

These always apply, in addition to the above:

- A destructive command: deleting files you did not create, \`git reset --hard\`,
  force operations, dropping or truncating anything.
- Executing a database migration, or any other schema change against a
  database.
- A change to security, authentication, authorization, or permissions.
- Adding, removing, or upgrading a dependency.
- Work that would take you outside the scope below. Scope expansion is a
  stop-and-ask, not a judgement call you make alone.

## How to finish

When the acceptance criteria are met, stop and summarize what you changed and
how you verified it. Do not attempt to mark the run complete — finishing your
work moves the run to review, which is not the same thing as being approved.
If you could not finish, say so plainly and explain what blocked you.
`.trim();
}

const REASON_PREAMBLE: Record<DispatchReason, string> = {
  start: "This is the first dispatch of this build run.",
  resume:
    "This run was paused by the operator and has now been resumed. Continue where you left off.",
  instruction:
    "The operator has sent you an instruction. Address it, then continue the task.",
  revision:
    "An independent review asked for revisions on this run. Address the operator's instruction below, then continue.",
};

/**
 * The task itself. On a resumed session the worker already has the earlier
 * conversation, so the goal block is included only on a fresh start; a resume
 * carries the instructions and a short reminder of the acceptance criteria,
 * which is what actually changes between dispatches.
 */
export function buildTaskPrompt(ctx: WorkerRunContext): string {
  const parts: string[] = [REASON_PREAMBLE[ctx.reason]];

  const fresh = ctx.sessionId === null;

  if (fresh) {
    parts.push(
      `# Build Run: ${ctx.title}`,
      `## Goal\n\n${ctx.goal}`,
      `## Acceptance criteria\n\n${bullets(ctx.acceptanceCriteria, "none specified — use your judgement and say what you assumed")}`,
      `## Out of scope\n\n${bullets(ctx.outOfScope, "nothing explicitly excluded")}`,
    );

    if (ctx.featureId || ctx.featureWorkPacket) {
      const packet = ctx.featureWorkPacket
        ? `\n\n\`\`\`json\n${JSON.stringify(ctx.featureWorkPacket, null, 2)}\n\`\`\``
        : "";
      parts.push(
        `## Feature Work Packet${ctx.featureId ? ` (${ctx.featureId})` : ""}${packet}`,
      );
    }

    parts.push(
      `## Workspace\n\nRepository: ${ctx.workspace.repoRoot}\nBranch: ${ctx.workspace.branch}`,
    );
  } else {
    parts.push(
      `Reminder — the acceptance criteria for this run:\n\n${bullets(ctx.acceptanceCriteria, "none specified")}`,
    );
  }

  if (ctx.instructions.length > 0) {
    const numbered = ctx.instructions
      .map((instruction, i) => `${i + 1}. ${instruction}`)
      .join("\n");
    parts.push(`## Operator instructions\n\n${numbered}`);
  }

  return parts.join("\n\n");
}

/** One-line description of a dispatch, for the timeline. */
export function describeDispatch(ctx: WorkerRunContext): string {
  const base =
    ctx.sessionId === null
      ? "Starting Claude Code session"
      : "Resuming Claude Code session";
  if (ctx.instructions.length === 0) return base;
  const n = ctx.instructions.length;
  return `${base} with ${n} operator instruction${n === 1 ? "" : "s"}`;
}
