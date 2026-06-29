import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * Per-call timeouts. The bridge spawns Node + loads the bridge module
 * (~1-2s) then issues `openclaw agent --json` which talks to the Gateway.
 * Each call gets its own short-lived spawn. v1 deliberately avoids
 * long-lived connections — see SPRINT_7_SPEC.md.
 */
const INIT_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 60_000;

export type OpenClawErrorCode =
  | "bridge_not_found"
  | "bridge_spawn_failed"
  | "bridge_exited"
  | "bridge_timeout"
  | "bridge_invalid_response"
  | "bridge_invalid_json"
  | "agent_not_found"
  | "agent_error"
  | "tool_not_supported";

export class OpenClawError extends Error {
  constructor(
    public readonly code: OpenClawErrorCode,
    message: string,
    public readonly stderr?: string,
  ) {
    super(message);
    this.name = "OpenClawError";
  }
}

export type Agent = {
  name: string;
  is_default?: boolean;
  identity?: string;
  workspace?: string;
  model?: string;
};

export type MessageReply = {
  reply: string;
  session_id?: string;
  agent_name: string;
};

/**
 * Stateless wrapper around the maximus-bridge stdio MCP server. Each public
 * method spawns the bridge, runs the MCP initialize handshake, issues one
 * request, and kills the child. No long-lived connection is held in v1.
 */
export class OpenClawClient {
  /**
   * Lists agents available on the host via the bridge's list_agents tool.
   */
  async listAgents(bridgePath: string): Promise<Agent[]> {
    this.assertBridgeExists(bridgePath);
    const result = await this.callBridgeTool(bridgePath, "list_agents", {});
    const agents = Array.isArray(result.agents) ? (result.agents as Agent[]) : [];
    return agents;
  }

  /**
   * Sends a message to an agent via the bridge's send_message tool.
   * Returns the agent's reply.
   */
  async sendMessage(
    bridgePath: string,
    agentName: string,
    message: string,
  ): Promise<MessageReply> {
    this.assertBridgeExists(bridgePath);
    const result = await this.callBridgeTool(bridgePath, "send_message", {
      agent: agentName,
      message,
    });

    if (!result.reply || typeof result.reply !== "string") {
      throw new OpenClawError(
        "bridge_invalid_response",
        'Bridge returned send_message result without a "reply" string.',
      );
    }

    return {
      reply: result.reply,
      session_id:
        typeof result.session_id === "string" ? result.session_id : undefined,
      agent_name: agentName,
    };
  }

  /**
   * Lists the bridge's available tools (used by validators to confirm
   * list_agents and send_message are present).
   */
  async listTools(
    bridgePath: string,
  ): Promise<Array<{ name: string; description?: string }>> {
    this.assertBridgeExists(bridgePath);

    const child = this.spawnBridge(bridgePath);
    try {
      await this.mcpInitialize(child);
      const response = await this.mcpRequest(child, "tools/list", {});
      const tools = Array.isArray(response.tools)
        ? (response.tools as Array<{ name: string; description?: string }>)
        : [];
      return tools;
    } finally {
      child.kill("SIGTERM");
    }
  }

  // ============================================================
  // Internal
  // ============================================================

  private assertBridgeExists(bridgePath: string): void {
    if (!bridgePath || typeof bridgePath !== "string") {
      throw new OpenClawError("bridge_not_found", "bridge_path is required.");
    }
    if (!existsSync(bridgePath)) {
      throw new OpenClawError(
        "bridge_not_found",
        `Bridge not found at ${bridgePath}. Set OPENCLAW_BIN or clone from github.com/MacroTechTitan/maximus-bridge.`,
      );
    }
  }

  private spawnBridge(bridgePath: string): ChildProcess {
    return spawn("node", [bridgePath], {
      env: {
        ...process.env,
        MAXIMUS_READONLY: "true", // Hard read-only floor enforced at the bridge
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  /**
   * Spawns the bridge, runs initialize + tools/call for the named tool,
   * returns the parsed JSON from the response's content[0].text.
   * Always kills the child at the end.
   */
  private async callBridgeTool(
    bridgePath: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const child = this.spawnBridge(bridgePath);

    try {
      await this.mcpInitialize(child);
      const response = await this.mcpRequest(
        child,
        "tools/call",
        { name: toolName, arguments: args },
        CALL_TIMEOUT_MS,
      );

      const textContent = (
        response.content as Array<{ text?: string }> | undefined
      )?.[0]?.text;
      if (!textContent) {
        throw new OpenClawError(
          "bridge_invalid_response",
          `Bridge returned tools/call (${toolName}) result without content[0].text.`,
        );
      }

      try {
        return JSON.parse(textContent) as Record<string, unknown>;
      } catch {
        throw new OpenClawError(
          "bridge_invalid_json",
          `Bridge returned invalid JSON in tools/call (${toolName}) response: ${textContent.slice(
            0,
            200,
          )}`,
        );
      }
    } finally {
      child.kill("SIGTERM");
    }
  }

  private mcpInitialize(child: ChildProcess): Promise<void> {
    return this.mcpRequest(
      child,
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "ai-connect", version: "0.0.0" },
      },
      INIT_TIMEOUT_MS,
    ).then(() => undefined);
  }

  /**
   * Generic MCP JSON-RPC request. Writes the request to stdin, waits for a
   * response with matching id on stdout, returns result. Tears down its own
   * listeners on settle so multiple requests can reuse the same child.
   */
  private mcpRequest(
    child: ChildProcess,
    method: string,
    params: Record<string, unknown>,
    timeoutMs = CALL_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const id = Math.floor(Math.random() * 1_000_000);
      let stdoutBuf = "";
      let stderrBuf = "";
      let resolved = false;

      const finish = (
        err: OpenClawError | null,
        result?: Record<string, unknown>,
      ) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        child.stdout?.off("data", onStdout);
        child.stderr?.off("data", onStderr);
        child.off("error", onError);
        child.off("exit", onExit);
        if (err) reject(err);
        else resolve(result ?? {});
      };

      const timer = setTimeout(() => {
        finish(
          new OpenClawError(
            "bridge_timeout",
            `Bridge did not respond to ${method} within ${timeoutMs / 1000}s.`,
            stderrBuf.slice(0, 500),
          ),
        );
      }, timeoutMs);

      const onStdout = (chunk: Buffer) => {
        stdoutBuf += chunk.toString();
        const lines = stdoutBuf.split("\n");
        stdoutBuf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.id !== id) continue;
            if (msg.error) {
              finish(
                new OpenClawError(
                  "agent_error",
                  `Bridge returned error for ${method}: ${
                    msg.error.message ?? "unknown"
                  }`,
                ),
              );
              return;
            }
            finish(null, msg.result ?? {});
            return;
          } catch {
            // non-JSON, ignore
          }
        }
      };

      const onStderr = (chunk: Buffer) => {
        stderrBuf += chunk.toString();
      };

      const onError = (err: Error) => {
        finish(
          new OpenClawError(
            "bridge_spawn_failed",
            `Failed to spawn bridge: ${err.message}`,
            stderrBuf.slice(0, 500),
          ),
        );
      };

      const onExit = (code: number | null) => {
        if (code !== 0 && code !== null) {
          finish(
            new OpenClawError(
              "bridge_exited",
              `Bridge exited unexpectedly (code ${code}) during ${method}.`,
              stderrBuf.slice(0, 500),
            ),
          );
        }
      };

      child.stdout?.on("data", onStdout);
      child.stderr?.on("data", onStderr);
      child.on("error", onError);
      child.on("exit", onExit);

      const request =
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
      child.stdin?.write(request);
    });
  }
}

// Singleton instance — stateless, safe to share.
export const openclawClient = new OpenClawClient();
