// Reading a verdict out of a model's reply.
//
// Pure and provider-agnostic: any reviewer that returns JSON parses through
// here, and it is exhaustively testable without spawning anything.
//
// The governing rule is that an unparseable reply is NOT a verdict. It is
// tempting to default to PASS (nothing was reported) or REVISION_REQUIRED
// (something went wrong) — both are lies about what the reviewer said. This
// returns a failure and the run stays where it is.

import { z } from "zod";

import { FINDING_SEVERITIES, REVIEW_VERDICTS, type ReviewResult } from "./types.js";

const MAX_SUMMARY = 5000;
const MAX_FINDINGS = 50;
const MAX_TEXT = 5000;

const findingSchema = z.object({
  title: z.string().trim().min(1).max(200),
  detail: z.string().trim().max(MAX_TEXT).optional(),
  severity: z.enum(FINDING_SEVERITIES).default("warn"),
  target: z.string().trim().max(500).optional(),
});

const gateSchema = z.object({
  gate: z.string().trim().min(1).max(100),
  status: z.enum(["PASS", "FAIL"]),
  required: z.boolean().default(true),
  detail: z.string().trim().max(MAX_TEXT).optional(),
});

const resultSchema = z.object({
  verdict: z.enum(REVIEW_VERDICTS),
  summary: z.string().trim().max(MAX_SUMMARY).default(""),
  findings: z.array(findingSchema).max(MAX_FINDINGS).default([]),
  completion_gates: z.array(gateSchema).max(MAX_FINDINGS).default([]),
});

export type ParseOutcome =
  | { ok: true; result: ReviewResult }
  | { ok: false; reason: string };

/**
 * Extracts every plausible JSON object from a reply, most-likely first:
 * the whole string, then fenced blocks, then balanced brace spans.
 *
 * Models are asked for bare JSON and usually comply, but a stray sentence
 * before the object should not cost a real review.
 */
export function extractJsonCandidates(text: string): string[] {
  const candidates: string[] = [];
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) candidates.push(trimmed);

  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(text)) !== null) {
    const body = match[1]?.trim();
    if (body?.startsWith("{")) candidates.push(body);
  }

  // Balanced-brace scan, so a JSON object embedded in prose is still found.
  // String-aware, or a brace inside a summary would end the span early.
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        candidates.push(text.slice(start, i + 1));
        start = -1;
      }
      if (depth < 0) depth = 0;
    }
  }

  // Later spans first among the brace-scanned ones: when a model explains and
  // then answers, the answer is at the end.
  return [...new Set(candidates)];
}

export function parseReviewResult(text: string): ParseOutcome {
  if (!text || text.trim().length === 0) {
    return { ok: false, reason: "the reviewer returned nothing" };
  }

  const candidates = extractJsonCandidates(text);
  if (candidates.length === 0) {
    return { ok: false, reason: "no JSON object found in the reply" };
  }

  let lastIssue = "no candidate matched the required shape";
  // Prefer the last valid candidate: a model that restates the format and then
  // answers puts the real verdict last.
  for (const candidate of [...candidates].reverse()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      lastIssue = "a JSON candidate was malformed";
      continue;
    }
    const validated = resultSchema.safeParse(parsed);
    if (!validated.success) {
      lastIssue = validated.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      continue;
    }
    const data = validated.data;
    return {
      ok: true,
      result: {
        verdict: data.verdict,
        summary: data.summary,
        findings: data.findings,
        completionGates: data.completion_gates,
      },
    };
  }

  return { ok: false, reason: lastIssue };
}

/**
 * The instruction sent back to the worker when a review asks for revisions.
 * Built from the findings so the worker is told what to change, not merely
 * that it failed.
 */
export function findingsToInstruction(result: ReviewResult): string {
  const lines: string[] = [
    "An independent review of your work returned REVISION_REQUIRED.",
  ];
  if (result.summary) lines.push("", `Reviewer summary: ${result.summary}`);

  if (result.findings.length > 0) {
    lines.push("", "Address each of these, then continue:");
    result.findings.forEach((finding, i) => {
      const target = finding.target ? ` (${finding.target})` : "";
      const detail = finding.detail ? `\n   ${finding.detail}` : "";
      lines.push(`${i + 1}. [${finding.severity}] ${finding.title}${target}${detail}`);
    });
  } else {
    lines.push(
      "",
      "The reviewer recorded no specific findings. Re-read the acceptance criteria and the summary above, and address what it describes.",
    );
  }

  const failed = result.completionGates.filter((g) => g.status === "FAIL");
  if (failed.length > 0) {
    lines.push(
      "",
      "Completion gates currently failing:",
      ...failed.map((g) => `- ${g.gate}${g.detail ? `: ${g.detail}` : ""}`),
    );
  }

  return lines.join("\n");
}
