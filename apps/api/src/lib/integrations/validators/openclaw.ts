import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import { isLocalMode, LOCAL_ONLY_ERROR } from "../../mode.js";
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
 * Spawns maximus-bridge (a stdio MCP server) as a child process, lists its
 * tools via the MCP JSON-RPC protocol, confirms that 'list_agents' and
 * 'send_message' are present, then calls list_agents to confirm the bridge can
 * reach OpenClaw and that the configured default_agent exists.
 *
 * Cloud mode short-circuits immediately with LOCAL_ONLY_ERROR — no spawn
 * attempted. Internal failure modes carry actionable codes (bridge_not_found,
 * bridge_spawn_failed, bridge_timeout, bridge_exited, missing_tools, …) that
 * are surfaced to the wizard through the shared errorMessage field.
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

    // 3) Bridge file existence check.
    if (!existsSync(c.bridge_path)) {
      return {
        valid: false,
        errorMessage: `Bridge not found at ${c.bridge_path}. Set OPENCLAW_BIN or clone from github.com/MacroTechTitan/maximus-bridge.`,
      };
    }

    // 4) Spawn the bridge and list its tools.
    const toolsResult = await listBridgeTools(c.bridge_path);
    if (!toolsResult.ok) {
      return { valid: false, errorMessage: toolsResult.message };
    }

    // 5) Confirm required tools are present.
    const toolNames = toolsResult.tools.map((t) => t.name);
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

    // 6) Call list_agents to confirm the bridge can reach OpenClaw.
    const agentsResult = await callBridgeListAgents(c.bridge_path);
    if (!agentsResult.ok) {
      return { valid: false, errorMessage: agentsResult.message };
    }

    // 7) Confirm the configured default_agent exists in the returned list.
    const defaultAgentExists = agentsResult.agents.some(
      (a) => a.name === c.default_agent,
    );
    if (!defaultAgentExists) {
      return {
        valid: false,
        errorMessage: `Default agent '${c.default_agent}' not found in agent list: ${agentsResult.agents
          .map((a) => a.name)
          .join(", ")}.`,
      };
    }

    const identity: OpenClawIdentity = {
      default_agent: c.default_agent,
      agent_count: agentsResult.agents.length,
      openclaw_version: agentsResult.openclaw_version,
      bridge_version: "0.2.0",
    };

    return { valid: true, identity };
  };
}

// ============================================================
// Internal: MCP JSON-RPC over stdio
// ============================================================

const SPAWN_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 60_000;

type BridgeToolsResult =
  | {
      ok: true;
      tools: Array<{ name: string; description?: string }>;
    }
  | {
      ok: false;
      code: string;
      message: string;
    };

type BridgeAgentsResult =
  | {
      ok: true;
      agents: Array<{
        name: string;
        is_default?: boolean;
        identity?: string;
        workspace?: string;
        model?: string;
      }>;
      openclaw_version?: string;
    }
  | {
      ok: false;
      code: string;
      message: string;
    };

/**
 * Spawns the bridge, sends MCP initialize + tools/list, returns the tool list.
 * Always kills the child after the response (no long-lived connection in v1).
 */
async function listBridgeTools(bridgePath: string): Promise<BridgeToolsResult> {
  return new Promise((resolve) => {
    const child = spawn("node", [bridgePath], {
      env: {
        ...process.env,
        MAXIMUS_READONLY: "true", // Enforce read-only at the bridge
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    let stderrBuf = "";
    let resolved = false;

    const finish = (result: BridgeToolsResult) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({
        ok: false,
        code: "bridge_timeout",
        message: `Bridge did not respond within ${
          SPAWN_TIMEOUT_MS / 1000
        }s. Check that openclaw is installed and the Gateway is running.`,
      });
    }, SPAWN_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      // MCP messages are newline-delimited JSON.
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 2 && msg.result?.tools) {
            // Got our tools/list response.
            finish({ ok: true, tools: msg.result.tools });
            return;
          }
          if (msg.id === 1 && msg.result) {
            // initialize succeeded, now send tools/list.
            const toolsListReq =
              JSON.stringify({
                jsonrpc: "2.0",
                id: 2,
                method: "tools/list",
                params: {},
              }) + "\n";
            child.stdin.write(toolsListReq);
          }
        } catch {
          // Non-JSON output, ignore.
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString();
    });

    child.on("error", (err) => {
      finish({
        ok: false,
        code: "bridge_spawn_failed",
        message: `Failed to spawn bridge: ${err.message}`,
      });
    });

    child.on("exit", (code) => {
      if (!resolved && code !== 0) {
        finish({
          ok: false,
          code: "bridge_exited",
          message: `Bridge exited unexpectedly (code ${code}). stderr: ${stderrBuf.slice(
            0,
            500,
          )}`,
        });
      }
    });

    // Kick things off with MCP initialize.
    const initReq =
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "ai-connect", version: "0.0.0" },
        },
      }) + "\n";
    child.stdin.write(initReq);
  });
}

/**
 * Spawns the bridge, sends MCP initialize + tools/call list_agents, returns
 * the agent list. Always kills the child after the response.
 */
async function callBridgeListAgents(
  bridgePath: string,
): Promise<BridgeAgentsResult> {
  return new Promise((resolve) => {
    const child = spawn("node", [bridgePath], {
      env: {
        ...process.env,
        MAXIMUS_READONLY: "true",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    let stderrBuf = "";
    let resolved = false;

    const finish = (result: BridgeAgentsResult) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({
        ok: false,
        code: "bridge_timeout",
        message: `Bridge did not respond within ${CALL_TIMEOUT_MS / 1000}s.`,
      });
    }, CALL_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 2 && msg.result) {
            // The bridge returns the agents in content[0].text as a JSON
            // string per MCP convention.
            const textContent = msg.result.content?.[0]?.text;
            if (!textContent) {
              finish({
                ok: false,
                code: "bridge_invalid_response",
                message:
                  "Bridge returned tools/call result without content[0].text.",
              });
              return;
            }
            try {
              const parsed = JSON.parse(textContent);
              const agents = Array.isArray(parsed.agents) ? parsed.agents : [];
              finish({
                ok: true,
                agents,
                openclaw_version: parsed.openclaw_version,
              });
            } catch {
              finish({
                ok: false,
                code: "bridge_invalid_json",
                message: `Bridge returned invalid JSON in tools/call response: ${textContent.slice(
                  0,
                  200,
                )}`,
              });
            }
            return;
          }
          if (msg.id === 1 && msg.result) {
            // initialize ok, call list_agents.
            const callReq =
              JSON.stringify({
                jsonrpc: "2.0",
                id: 2,
                method: "tools/call",
                params: { name: "list_agents", arguments: {} },
              }) + "\n";
            child.stdin.write(callReq);
          }
        } catch {
          // Non-JSON, ignore.
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString();
    });

    child.on("error", (err) => {
      finish({
        ok: false,
        code: "bridge_spawn_failed",
        message: `Failed to spawn bridge: ${err.message}`,
      });
    });

    child.on("exit", (code) => {
      if (!resolved && code !== 0) {
        finish({
          ok: false,
          code: "bridge_exited",
          message: `Bridge exited unexpectedly (code ${code}). stderr: ${stderrBuf.slice(
            0,
            500,
          )}`,
        });
      }
    });

    const initReq =
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "ai-connect", version: "0.0.0" },
        },
      }) + "\n";
    child.stdin.write(initReq);
  });
}
