import { describe, expect, it } from "vitest";

import { extractJsonCandidates, findingsToInstruction, parseReviewResult } from "./parse.js";
import type { ReviewResult } from "./types.js";

// The governing rule these tests protect: an unparseable reply is NOT a
// verdict. Defaulting to PASS ("nothing was reported") or REVISION_REQUIRED
// ("something went wrong") would both be lies about what the reviewer said.

const valid = {
  verdict: "PASS",
  summary: "Meets the acceptance criteria.",
  findings: [{ title: "Consider a test", severity: "info" }],
  completion_gates: [{ gate: "acceptance_criteria", status: "PASS", required: true }],
};

describe("parsing a verdict", () => {
  it("reads a bare JSON object", () => {
    const out = parseReviewResult(JSON.stringify(valid));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.verdict).toBe("PASS");
    expect(out.result.summary).toBe("Meets the acceptance criteria.");
    expect(out.result.findings[0].severity).toBe("info");
    expect(out.result.completionGates[0].gate).toBe("acceptance_criteria");
  });

  it("reads a fenced JSON block", () => {
    const out = parseReviewResult("Here you go:\n```json\n" + JSON.stringify(valid) + "\n```");
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.result.verdict).toBe("PASS");
  });

  it("reads JSON embedded in prose", () => {
    const out = parseReviewResult(`I reviewed it. ${JSON.stringify(valid)} That is all.`);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.result.verdict).toBe("PASS");
  });

  it("prefers the last object when a model restates the format then answers", () => {
    const template = JSON.stringify({ verdict: "PASS", summary: "template" });
    const answer = JSON.stringify({ verdict: "STOP", summary: "the real answer" });
    const out = parseReviewResult(`Format: ${template}\n\nMy verdict: ${answer}`);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.result.summary).toBe("the real answer");
  });

  it("is not confused by braces inside a summary string", () => {
    const out = parseReviewResult(
      JSON.stringify({ verdict: "PASS", summary: "the object {a: 1} was fine" }),
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.result.summary).toBe("the object {a: 1} was fine");
  });

  it("defaults optional fields without inventing content", () => {
    const out = parseReviewResult('{"verdict":"STOP"}');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.summary).toBe("");
    expect(out.result.findings).toEqual([]);
    expect(out.result.completionGates).toEqual([]);
  });

  it("defaults a finding's severity to warn rather than dropping the finding", () => {
    const out = parseReviewResult(
      '{"verdict":"REVISION_REQUIRED","findings":[{"title":"Fix it"}]}',
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.result.findings[0].severity).toBe("warn");
  });
});

describe("refusing to guess", () => {
  it("fails on an empty reply", () => {
    const out = parseReviewResult("");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/returned nothing/);
  });

  it("fails on prose with no JSON at all", () => {
    const out = parseReviewResult("Looks good to me!");
    expect(out.ok).toBe(false);
  });

  it("fails on an unknown verdict rather than coercing it", () => {
    const out = parseReviewResult('{"verdict":"LGTM","summary":"fine"}');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/verdict/);
  });

  it("fails on a missing verdict", () => {
    expect(parseReviewResult('{"summary":"no verdict here"}').ok).toBe(false);
  });

  it("never returns a verdict it was not given", () => {
    for (const text of ["", "no json", '{"verdict":"MAYBE"}', "{}", "null", "[]"]) {
      const out = parseReviewResult(text);
      if (out.ok) throw new Error(`unexpectedly parsed: ${text}`);
      expect(out.ok).toBe(false);
    }
  });

  it("skips a malformed candidate and uses a valid one", () => {
    const out = parseReviewResult(`{not json} ${JSON.stringify(valid)}`);
    expect(out.ok).toBe(true);
  });
});

describe("extractJsonCandidates", () => {
  it("finds nothing in text with no braces", () => {
    expect(extractJsonCandidates("plain text")).toEqual([]);
  });

  it("deduplicates identical candidates", () => {
    const json = '{"verdict":"PASS"}';
    const candidates = extractJsonCandidates(json);
    expect(new Set(candidates).size).toBe(candidates.length);
  });

  it("survives unbalanced braces without hanging", () => {
    expect(() => extractJsonCandidates("}}}{{{ nonsense }")).not.toThrow();
  });
});

describe("findingsToInstruction", () => {
  const base: ReviewResult = {
    verdict: "REVISION_REQUIRED",
    summary: "Two things need attention.",
    findings: [
      { title: "Add the missing test", detail: "There is no test for the new branch.", severity: "error", target: "src/a.ts" },
      { title: "Tighten the type", severity: "warn" },
    ],
    completionGates: [
      { gate: "tests", status: "FAIL", required: true, detail: "no test run recorded" },
      { gate: "lint", status: "PASS", required: false },
    ],
  };

  it("tells the worker what to do, not merely that it failed", () => {
    const text = findingsToInstruction(base);
    expect(text).toContain("REVISION_REQUIRED");
    expect(text).toContain("Two things need attention.");
    expect(text).toContain("1. [error] Add the missing test (src/a.ts)");
    expect(text).toContain("There is no test for the new branch.");
    expect(text).toContain("2. [warn] Tighten the type");
  });

  it("lists only the failing gates", () => {
    const text = findingsToInstruction(base);
    expect(text).toContain("- tests: no test run recorded");
    expect(text).not.toContain("- lint");
  });

  it("still produces a usable instruction with no findings", () => {
    const text = findingsToInstruction({ ...base, findings: [], completionGates: [] });
    expect(text).toContain("no specific findings");
    expect(text).toContain("Two things need attention.");
  });
});
