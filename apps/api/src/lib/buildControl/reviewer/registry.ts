// Reviewer lookup by provider name.
//
// Mirrors the worker registry, and exists for the same reason: the Build
// Control lifecycle must never name a model. Swapping the reviewer is a
// registry entry plus AICONNECT_REVIEWER_PROVIDER, not a change to
// reviewerService or the routes.

import { claudeCodeReviewer, CLAUDE_REVIEWER_NAME } from "./claudeReviewer.js";
import type { BuildReviewer } from "./types.js";

const REVIEWERS = new Map<string, BuildReviewer>([
  [CLAUDE_REVIEWER_NAME, claudeCodeReviewer],
  // Short alias so operators do not have to type the full provider name.
  ["claude_code", claudeCodeReviewer],
]);

export const DEFAULT_REVIEWER = CLAUDE_REVIEWER_NAME;

export function getReviewer(name?: string): BuildReviewer | undefined {
  return REVIEWERS.get(name ?? DEFAULT_REVIEWER);
}

export function listReviewerNames(): string[] {
  return [...new Set([...REVIEWERS.values()].map((r) => r.name))];
}

/** Test seam, scoped and reversible. */
export function registerReviewer(name: string, reviewer: BuildReviewer): () => void {
  const previous = REVIEWERS.get(name);
  REVIEWERS.set(name, reviewer);
  return () => {
    if (previous) REVIEWERS.set(name, previous);
    else REVIEWERS.delete(name);
  };
}
