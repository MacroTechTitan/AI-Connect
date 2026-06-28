/**
 * Local vs cloud mode detection for AI Connect.
 *
 * Local mode = AI Connect running on a user's host with access to local
 * resources (e.g., OpenClaw via maximus-bridge). Triggered by setting
 * AICONNECT_LOCAL_MODE=true OR OPENCLAW_BIN in the environment (both routed
 * through lib/env.ts per the project's env-validation convention).
 *
 * Cloud mode = AI Connect running on Render (or any other cloud host).
 * The default. Cloud mode refuses local-only operations (OpenClaw, future
 * local integrations) with a clear "openclaw_local_only" error and a docs
 * link.
 *
 * See docs/LOCAL_MODE.md for the full architecture.
 */

import { env } from "./env.js";

export function isLocalMode(): boolean {
  return env.AICONNECT_LOCAL_MODE === "true" || Boolean(env.OPENCLAW_BIN);
}

export function isCloudMode(): boolean {
  return !isLocalMode();
}

/**
 * Standard error response shape for cloud-mode refusals. Routes (Sprint 7
 * Commit 5) return this with the 503 status; the validator surfaces the
 * message via the shared errorMessage field.
 */
export const LOCAL_ONLY_ERROR = {
  code: "openclaw_local_only",
  message:
    "OpenClaw integrations require AI Connect running locally. " +
    "Cloud AI Connect cannot spawn local processes. " +
    "See docs/LOCAL_MODE.md for setup instructions.",
  status: 503 as const,
};
