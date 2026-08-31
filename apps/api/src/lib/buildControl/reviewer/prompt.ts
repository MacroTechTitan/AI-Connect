// What the independent reviewer is told.
//
// Two pieces, same split as the worker's: a fixed policy appended to the
// system prompt, and the run-specific payload.
//
// The policy is prose and is therefore NOT what stops a reviewer editing code
// — the read-only tool list does that. What the policy is for is the shape of
// the judgement: three verdicts, structured findings, and a bias toward saying
// "I could not tell" rather than inventing confidence.

import type { ReviewRequest } from "./types.js";

function bullets(items: readonly string[], empty: string): string {
  if (items.length === 0) return `_${empty}_`;
  return items.map((i) => `- ${i}`).join("\n");
}

export function buildReviewerPolicy(request: ReviewRequest): string {
  return `
# You are the independent reviewer for an AI Connect Build Run

Another agent did this work. You did not, and you have no access to its
session or its reasoning — only to what it actually changed. Your job is to
judge whether the work meets the run's acceptance criteria and respects its
scope, and to say so in a fixed format.

## You cannot change anything

You have Read, Glob and Grep and nothing else. You cannot edit files, run
commands, install anything, push, or deploy — not because you are asked not
to, but because those tools are not available to you. Do not attempt them and
do not ask for them. If the work needs a change, that is a finding, not
something you make.

You also do not approve. A PASS moves the run to a human, who approves it.

## Your verdict

Exactly one of:

- **PASS** — the acceptance criteria are met and nothing in scope is wrong.
  Findings may still be attached; PASS with advisory findings is normal.
- **REVISION_REQUIRED** — the work is on the right track but something must
  change before a human should see it. Your findings become the instruction
  sent back to the worker, so write them as things to do.
- **STOP** — this run should not continue at all: the approach is wrong, it
  went outside its scope in a way revision cannot repair, or it did something
  it was told to stop and ask about. STOP ends the run.

Judge against the acceptance criteria as written. Work that is good but does
not meet them is REVISION_REQUIRED, not PASS. Work that meets them in a way
you personally would have done differently is PASS with a finding.

## What to weigh

- Every acceptance criterion, individually.
- The out-of-scope list. Doing extra unrequested work is a finding.
- The stop-and-ask list. If the worker did one of those things instead of
  stopping, that is at least REVISION_REQUIRED and usually STOP.
- The diff itself, not the worker's description of it. The worker's closing
  message is included as a claim to check, not as evidence.
- Anything that would be unsafe, irreversible, or a secret committed to the
  repository.

Secrets in the payload have been replaced with [REDACTED]. That marker means
redaction happened, not that the worker wrote the word — do not report it as a
defect. Do report an actual credential if you find one that was not redacted.

## Honesty

If the diff was truncated, or a file could not be measured, or you cannot tell
whether a criterion was met, say so in your summary and lower your confidence
accordingly. Do not guess a verdict you cannot support. An honest
REVISION_REQUIRED that names what you could not verify is more useful than a
PASS you are unsure of.

## Output format

Reply with **one JSON object and nothing else** — no prose before it, no
explanation after it, no markdown fence:

{
  "verdict": "PASS" | "REVISION_REQUIRED" | "STOP",
  "summary": "one paragraph, plain text",
  "findings": [
    {
      "title": "short imperative statement",
      "detail": "what and why",
      "severity": "info" | "warn" | "error" | "critical",
      "target": "file path or acceptance criterion"
    }
  ],
  "completion_gates": [
    { "gate": "acceptance_criteria", "status": "PASS" | "FAIL", "required": true, "detail": "..." }
  ]
}

\`findings\` and \`completion_gates\` may be empty arrays. Every gate you record
becomes part of the run's release eligibility, so mark a gate FAIL only when
you actually checked it and it failed — not when you could not check it.

The run under review is "${request.task.title}".
`.trim();
}

export function buildReviewPrompt(request: ReviewRequest): string {
  const parts: string[] = [];

  parts.push(`# Build Run under review: ${request.task.title}`);
  parts.push(`## Goal\n\n${request.task.goal}`);
  parts.push(
    `## Acceptance criteria\n\n${bullets(request.task.acceptanceCriteria, "none were specified — judge against the goal and say so")}`,
  );
  parts.push(`## Out of scope\n\n${bullets(request.task.outOfScope, "nothing explicitly excluded")}`);
  parts.push(
    `## Stop-and-ask conditions the worker was given\n\n${bullets(request.task.stopAndAsk, "none run-specific")}`,
  );

  if (request.feature.featureId || request.feature.workPacket) {
    const packet = request.feature.workPacket
      ? `\n\n\`\`\`json\n${JSON.stringify(request.feature.workPacket, null, 2)}\n\`\`\``
      : "";
    parts.push(
      `## Feature Work Packet${request.feature.featureId ? ` (${request.feature.featureId})` : ""}${packet}`,
    );
  }

  parts.push(
    `## Workspace\n\nRepository: ${request.workspace.repoRoot}\nBranch: ${request.workspace.branch}\nBase commit: ${request.workspace.baseCommit ?? "unknown"}`,
  );

  const stats = `${request.diff.filesChanged.length} file(s) changed` +
    (request.diff.additions !== null ? `, +${request.diff.additions}` : "") +
    (request.diff.deletions !== null ? `/-${request.diff.deletions}` : "");
  parts.push(
    `## What changed\n\n${stats}\n\n${bullets(request.diff.filesChanged, "no files recorded as changed")}` +
      (request.diff.unmeasured.length > 0
        ? `\n\nCould not be measured (treat their contents as unknown):\n${bullets(request.diff.unmeasured, "")}`
        : ""),
  );

  if (request.diff.patch) {
    parts.push(
      `## Diff\n\n${request.diff.patchTruncated ? "**This diff was truncated. Say so if it affects your verdict.**\n\n" : ""}\`\`\`diff\n${request.diff.patch}\n\`\`\``,
    );
  } else {
    parts.push(
      "## Diff\n\n_No diff was available for this run. You are judging without seeing the changes; weigh that in your verdict._",
    );
  }

  parts.push(
    `## Validation recorded by the run\n\n${
      request.validation.summary.length > 0
        ? `\`\`\`json\n${JSON.stringify(request.validation.summary, null, 2)}\n\`\`\``
        : "_No validation results were recorded. Nothing was verified by a test run; treat correctness claims as unverified._"
    }`,
  );

  if (request.validation.completionGates.length > 0) {
    parts.push(
      `## Completion gates already recorded\n\n\`\`\`json\n${JSON.stringify(request.validation.completionGates, null, 2)}\n\`\`\``,
    );
  }

  parts.push(
    `## What the worker did (normalized timeline)\n\n${
      request.events.length > 0
        ? request.events
            .map((e) => `- ${e.at} [${e.severity}] ${e.type}: ${e.summary}`)
            .join("\n")
        : "_No events recorded._"
    }`,
  );

  parts.push(
    `## The worker's own closing claim\n\nWorker: ${request.worker.type} (${request.worker.status})\n\n${
      request.worker.finalMessage
        ? `> ${request.worker.finalMessage}`
        : "_The worker did not leave a closing message._"
    }\n\nThis is a claim to check against the diff, not evidence.`,
  );

  for (const file of request.context) {
    parts.push(
      `## Architecture / policy context: ${file.path}${file.truncated ? " (truncated)" : ""}\n\n\`\`\`\n${file.content}\n\`\`\``,
    );
  }

  parts.push(
    "## Now review\n\nReply with one JSON object in the format given in your instructions, and nothing else.",
  );

  return parts.join("\n\n");
}
