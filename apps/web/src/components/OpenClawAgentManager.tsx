import { useCallback, useEffect, useRef, useState } from "react";

import { authedFetch, isSessionExpired, type GetAccessToken } from "../lib/api";
import { SessionExpiredNotice } from "./SessionExpiredNotice";

interface ManagerAgent {
  name: string;
  is_default?: boolean;
  identity?: string;
  workspace?: string;
  model?: string;
}

type ChatRole = "user" | "agent" | "system";

interface ChatEntry {
  id: number;
  role: ChatRole;
  content: string;
  agentName: string;
  sentAt: number;
}

const MAX_MESSAGE_CHARS = 10_000;
const CHAR_COUNT_VISIBLE_FROM = 8_000;
const MAX_HISTORY = 10;

// Naive relative-time formatter for the in-memory chat. Mirrors App.tsx's
// formatRelativeTime but works on epoch-ms (the messages are session-only).
function relativeTime(sentAt: number, now: number): string {
  const diff = Math.max(0, now - sentAt);
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return new Date(sentAt).toLocaleDateString();
}

// Middle-truncate long paths (workspace) so the head and tail stay visible.
function truncateMiddle(s: string, max = 40): string {
  if (s.length <= max) return s;
  const keep = Math.floor((max - 1) / 2);
  return `${s.slice(0, keep)}…${s.slice(s.length - keep)}`;
}

// Maps a failed POST /messages response to user-facing copy by HTTP status,
// matching the route's status mapping (504/404/503/502).
async function describeSendError(
  res: Response,
  agentName: string,
): Promise<string> {
  let code: string | undefined;
  let message: string | undefined;
  try {
    const body = (await res.json()) as { error?: string; message?: string };
    code = body.error;
    message = body.message;
  } catch {
    // non-JSON; fall back to status-based copy
  }

  switch (res.status) {
    case 504:
      return "Agent didn't respond in 60s. Try a shorter prompt or check that OpenClaw is running.";
    case 404:
      return `Agent ${agentName} not found. Pick another agent and try again.`;
    case 503:
      return "AI Connect appears to be in cloud mode. Refresh the page.";
    case 502:
      return `${code ?? "bridge_error"}: ${message ?? "The bridge returned an error."}`;
    default:
      return message ?? "Could not send message.";
  }
}

// Post-wizard panel for actually using an OpenClaw integration: list agents,
// pick the active one, send messages, see replies. Rendered inline below the
// integrations list (like WordPressModuleManager), not as a modal. Message
// history is in-memory only in v1 — see SPRINT_7_SPEC.md.
export function OpenClawAgentManager({
  getAccessTokenSilently,
  integrationId,
  bridgePath,
  defaultAgent,
  onClose,
}: {
  getAccessTokenSilently: GetAccessToken;
  integrationId: string;
  bridgePath?: string;
  defaultAgent?: string;
  onClose: () => void;
}) {
  const [agents, setAgents] = useState<ManagerAgent[]>([]);
  const [loadingAgents, setLoadingAgents] = useState(true);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState(defaultAgent ?? "");

  const [messages, setMessages] = useState<ChatEntry[]>([]);
  const [messageInput, setMessageInput] = useState("");
  const [isSending, setIsSending] = useState(false);

  const [sessionExpired, setSessionExpired] = useState(false);

  // Monotonic id source for chat entries — avoids key collisions without
  // relying on render-time randomness.
  const nextId = useRef(0);

  // Live ticker so relative times stay fresh while the panel is open. Only
  // runs when there's history to re-time.
  const [nowTs, setNowTs] = useState(() => Date.now());
  useEffect(() => {
    if (messages.length === 0) return;
    const t = setInterval(() => setNowTs(Date.now()), 15_000);
    return () => clearInterval(t);
  }, [messages.length]);

  const base = `/api/integrations/${integrationId}`;

  const loadAgents = useCallback(async () => {
    setAgentsError(null);
    setLoadingAgents(true);
    try {
      const res = await authedFetch(`${base}/agents`, {}, getAccessTokenSilently);
      if (!res.ok) {
        let msg = "Couldn't load agents.";
        if (res.status === 503) {
          msg =
            "AI Connect appears to be in cloud mode. OpenClaw requires running locally.";
        } else {
          try {
            const body = (await res.json()) as {
              message?: string;
              error?: string;
            };
            msg = body.message ?? body.error ?? msg;
          } catch {
            // keep default
          }
        }
        setAgentsError(msg);
        setAgents([]);
        return;
      }
      const body = (await res.json()) as { agents?: ManagerAgent[] };
      const list = body.agents ?? [];
      setAgents(list);
      // Keep the selection valid: prefer the current pick, then the configured
      // default, then the bridge's is_default agent, then the first.
      setSelectedAgent((cur) => {
        if (cur && list.some((a) => a.name === cur)) return cur;
        if (defaultAgent && list.some((a) => a.name === defaultAgent)) {
          return defaultAgent;
        }
        const preferred = list.find((a) => a.is_default) ?? list[0];
        return preferred?.name ?? "";
      });
    } catch (err) {
      if (isSessionExpired(err)) {
        setSessionExpired(true);
        return;
      }
      setAgentsError("Couldn't reach the server. Try again.");
      setAgents([]);
    } finally {
      setLoadingAgents(false);
    }
  }, [base, getAccessTokenSilently, defaultAgent]);

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  function appendEntry(entry: Omit<ChatEntry, "id">) {
    setMessages((prev) =>
      [...prev, { ...entry, id: nextId.current++ }].slice(-MAX_HISTORY),
    );
  }

  async function handleSend() {
    const text = messageInput.trim();
    if (!text || isSending || !selectedAgent) return;

    const agentName = selectedAgent;
    // Optimistic — show the user message immediately. Input is kept until the
    // send succeeds so a failure stays retry-friendly.
    appendEntry({
      role: "user",
      content: text,
      agentName,
      sentAt: Date.now(),
    });
    setIsSending(true);
    try {
      const res = await authedFetch(
        `${base}/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agent_name: agentName, message: text }),
        },
        getAccessTokenSilently,
      );

      if (!res.ok) {
        const msg = await describeSendError(res, agentName);
        appendEntry({
          role: "system",
          content: msg,
          agentName,
          sentAt: Date.now(),
        });
        return;
      }

      const body = (await res.json()) as { reply?: string; agent_name?: string };
      appendEntry({
        role: "agent",
        content: body.reply ?? "(empty reply)",
        agentName: body.agent_name ?? agentName,
        sentAt: Date.now(),
      });
      // Only clear the draft on success.
      setMessageInput("");
    } catch (err) {
      if (isSessionExpired(err)) {
        setSessionExpired(true);
        return;
      }
      appendEntry({
        role: "system",
        content: "Couldn't reach the server. Try again.",
        agentName,
        sentAt: Date.now(),
      });
    } finally {
      setIsSending(false);
    }
  }

  if (sessionExpired) {
    return (
      <div className="openclaw-mgr">
        <SessionExpiredNotice />
      </div>
    );
  }

  const canSend = messageInput.trim().length > 0 && !isSending && !!selectedAgent;

  return (
    <div className="openclaw-mgr">
      <div className="openclaw-mgr-head">
        <div className="openclaw-mgr-title">
          <h4>OpenClaw Agents</h4>
          {bridgePath ? (
            <span className="openclaw-mgr-bridge">{bridgePath}</span>
          ) : null}
        </div>
        <button type="button" className="linklike" onClick={onClose}>
          Close
        </button>
      </div>

      <div className="openclaw-mgr-body">
        <div className="openclaw-mgr-agents">
          <div className="openclaw-mgr-section-head">
            <h5>Agents</h5>
            <button
              type="button"
              className="linklike"
              onClick={() => void loadAgents()}
              disabled={loadingAgents}
            >
              {loadingAgents ? "Refreshing…" : "Refresh"}
            </button>
          </div>

          {loadingAgents ? (
            <p className="muted">Loading agents…</p>
          ) : agentsError ? (
            <p className="error">{agentsError}</p>
          ) : agents.length === 0 ? (
            <p className="muted">No agents found.</p>
          ) : (
            <ul className="openclaw-agent-list">
              {agents.map((a) => (
                <li key={a.name}>
                  <button
                    type="button"
                    className={`openclaw-agent-option${
                      selectedAgent === a.name ? " selected" : ""
                    }`}
                    onClick={() => setSelectedAgent(a.name)}
                  >
                    <span className="openclaw-agent-name">
                      {a.name}
                      {a.is_default ? (
                        <span className="default-badge">default</span>
                      ) : null}
                    </span>
                    {a.identity ? (
                      <span className="openclaw-agent-meta">
                        Identity: {a.identity}
                      </span>
                    ) : null}
                    {a.workspace ? (
                      <span
                        className="openclaw-agent-meta"
                        title={a.workspace}
                      >
                        Workspace: {truncateMiddle(a.workspace)}
                      </span>
                    ) : null}
                    {a.model ? (
                      <span className="openclaw-agent-meta">
                        Model: {a.model}
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="openclaw-mgr-chat">
          <div className="openclaw-mgr-section-head">
            <h5>
              Send a message
              {selectedAgent ? ` — ${selectedAgent}` : ""}
            </h5>
          </div>

          {messages.length === 0 ? (
            <p className="muted">No messages yet. Send one to get started.</p>
          ) : (
            <ul className="openclaw-chat-list">
              {messages.map((m) => (
                <li
                  key={m.id}
                  className={`openclaw-chat-entry openclaw-chat-${m.role}`}
                >
                  {m.role === "agent" ? (
                    <span className="openclaw-chat-label">{m.agentName}</span>
                  ) : null}
                  {m.role === "system" ? (
                    <span className="openclaw-chat-label">error</span>
                  ) : null}
                  <div className="openclaw-chat-bubble">{m.content}</div>
                  <span className="openclaw-chat-time">
                    {relativeTime(m.sentAt, nowTs)}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <div className="openclaw-mgr-compose">
            <textarea
              className="openclaw-mgr-input"
              placeholder={
                selectedAgent
                  ? `Message ${selectedAgent}…`
                  : "Select an agent first…"
              }
              value={messageInput}
              onChange={(e) =>
                setMessageInput(e.target.value.slice(0, MAX_MESSAGE_CHARS))
              }
              maxLength={MAX_MESSAGE_CHARS}
              rows={3}
            />
            {messageInput.length >= CHAR_COUNT_VISIBLE_FROM ? (
              <span className="openclaw-mgr-charcount muted">
                {messageInput.length.toLocaleString()} /{" "}
                {MAX_MESSAGE_CHARS.toLocaleString()}
              </span>
            ) : null}
            <button
              type="button"
              className="btn-primary"
              onClick={() => void handleSend()}
              disabled={!canSend}
            >
              {isSending ? "Sending…" : "Send"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
