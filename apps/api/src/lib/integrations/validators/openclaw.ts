import { existsSync } from "node:fs";

import { isLocalMode, LOCAL_ONLY_ERROR } from "../../mode.js";
import { openclawClient, OpenClawError } from "../openclawClient.js";
import type {
  IntegrationValidator,
  OpenClawConfig,
  OpenClawIdentity,
} from "../types.js";

/**
 * Factory function. Returns an IntegrationValidator for OpenClaw integrations.
 * Mirrors the other validator factories' signature (userId is unused here —
 * OpenClaw has no per-user provider_key ownership check — so it's prefixed `_`).
 *
 * The MCP spawn + JSON-RPC handshake lives in openclawClient; this validator
 * just orchestrates the checks: confirm the bridge exposes list_agents +
 * send_message, then confirm the configured default_agent is reachable.
 *
 * Cloud mode short-circuits immediately with LOCAL_ONLY_ERROR — no spawn
 * attempted. OpenClawError codes thrown by the client are mapped to the
 * shared errorMessage field the wizard surfaces.
 */
export function makeOpenClawValidator(_userId: string): IntegrationValidator {
  return async ({ config }) => {
    const c = config as OpenClawConfig;

    // 1) Cloud mode refusal — never spawn on Render.
    if (!isLocalMode()) {
      return { valid: false, errorMessage: LOCAL_ONLY_ERROR.message };
    }

    // 2) Shape checks.
    if (typeof c.bridge_path !== "string" || c.bridge_path.length === 0) {
      return {
        valid: false,
        errorMessage: "bridge_path is required in OpenClaw config.",
      };
    }

    if (typeof c.default_agent !== "string" || c.default_agent.length === 0) {
      return {
        valid: false,
        errorMessage: "default_agent is required in OpenClaw config.",
      };
    }

    // 3) Bridge file existence check. (The client checks this too, but doing it
    // here keeps the error message identical and avoids a needless spawn.)
    if (!existsSync(c.bridge_path)) {
      return {
        valid: false,
        errorMessage: `Bridge not found at ${c.bridge_path}. Set OPENCLAW_BIN or clone from github.com/MacroTechTitan/maximus-bridge.`,
      };
    }

    try {
      // 4) Confirm the bridge exposes the tools we need.
      const tools = await openclawClient.listTools(c.bridge_path);
      const toolNames = tools.map((t) => t.name);
      const required = ["list_agents", "send_message"];
      const missing = required.filter((r) => !toolNames.includes(r));
      if (missing.length > 0) {
        return {
          valid: false,
          errorMessage: `Bridge is missing required tools: ${missing.join(
            ", ",
          )}. Update to maximus-bridge v0.2.0+.`,
        };
      }

      // 5) Confirm the bridge can reach OpenClaw and the default_agent exists.
      const agents = await openclawClient.listAgents(c.bridge_path);
      const defaultAgentExists = agents.some((a) => a.name === c.default_agent);
      if (!defaultAgentExists) {
        return {
          valid: false,
          errorMessage: `Default agent '${c.default_agent}' not found in agent list: ${agents
            .map((a) => a.name)
            .join(", ")}.`,
        };
      }

      const identity: OpenClawIdentity = {
        default_agent: c.default_agent,
        agent_count: agents.length,
        bridge_version: "0.2.0",
      };

      return { valid: true, identity };
    } catch (err) {
      if (err instanceof OpenClawError) {
        return { valid: false, errorMessage: err.message };
      }
      return {
        valid: false,
        errorMessage: `Unexpected error validating OpenClaw bridge: ${
          err instanceof Error ? err.message : "unknown error"
        }`,
      };
    }
  };
}
