import { useState } from "react";

import { authedFetch, isSessionExpired, type GetAccessToken } from "../lib/api";
import { SessionExpiredNotice } from "./SessionExpiredNotice";

interface WizardAgent {
  name: string;
  is_default?: boolean;
  identity?: string;
  workspace?: string;
  model?: string;
}

// Maps the API's machine error codes (from the discover endpoint / validator /
// openclawClient) to actionable copy. Falls back to the server's message, then
// a generic line. Keeps {bridge_path} interpolation where it helps the user.
function describeDiscoverError(
  code: string | undefined,
  serverMessage: string | undefined,
  bridgePath: string,
): string {
  switch (code) {
    case "openclaw_local_only":
      return "AI Connect is running in cloud mode. OpenClaw requires AI Connect running locally.";
    case "bridge_not_found":
    case "bridge_path_required":
      return `Bridge not found at ${bridgePath}. Check the path and try again.`;
    case "bridge_spawn_failed":
      return "Could not spawn Node. Is it installed and on PATH?";
    case "bridge_timeout":
      return "Bridge did not respond. Is OpenClaw installed and the Gateway running?";
    case "bridge_exited":
      return `Bridge crashed. Try running \`node ${bridgePath}\` manually to see the error.`;
    default:
      return (
        serverMessage ??
        "Couldn't reach the bridge. Check the path and that OpenClaw is running."
      );
  }
}

// Six-step guided flow for connecting OpenClaw. Parallels WordPressWizard: a
// controlled modal the parent gates with `{open ? <OpenClawWizard/> : null}`.
// Local-only — the backend refuses every call with 503 openclaw_local_only when
// AI Connect runs in cloud mode, and the parent disables entry there too.
export function OpenClawWizard({
  getAccessTokenSilently,
  onClose,
  onConnected,
  onManageAgents,
}: {
  getAccessTokenSilently: GetAccessToken;
  onClose: () => void;
  // Called once the integration row exists so the parent can refresh its list.
  onConnected: () => void;
  // Called from the final step's "Manage Agents" so the parent can open the
  // agent manager (Sprint 7 Commit 7).
  onManageAgents: (integrationId: string) => void;
}) {
  const [step, setStep] = useState(1);
  const [sessionExpired, setSessionExpired] = useState(false);

  // Step 2 — bridge path
  const [bridgePath, setBridgePath] = useState("");
  const [pathError, setPathError] = useState<string | null>(null);

  // Step 3 — discovery
  const [discovering, setDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [agents, setAgents] = useState<WizardAgent[]>([]);

  // Step 4 — agent selection
  const [selectedAgent, setSelectedAgent] = useState("");

  // Step 5 — test message + integration creation
  const [integrationId, setIntegrationId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [testReply, setTestReply] = useState<string | null>(null);

  const chosen = agents.find((a) => a.name === selectedAgent);

  function handleContinueFromPath() {
    setPathError(null);
    if (bridgePath.trim().length === 0) {
      setPathError("Enter the absolute path to maximus-bridge/index.mjs.");
      return;
    }
    void runDiscover();
  }

  async function runDiscover() {
    setDiscoverError(null);
    setDiscovering(true);
    setStep(3);
    try {
      const res = await authedFetch(
        "/api/integrations/openclaw/discover",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bridge_path: bridgePath.trim() }),
        },
        getAccessTokenSilently,
      );

      if (!res.ok) {
        let code: string | undefined;
        let message: string | undefined;
        try {
          const body = (await res.json()) as {
            error?: string;
            message?: string;
          };
          code = body.error;
          message = body.message;
        } catch {
          // non-JSON; describeDiscoverError falls back to generic copy
        }
        setDiscoverError(
          describeDiscoverError(code, message, bridgePath.trim()),
        );
        return;
      }

      const body = (await res.json()) as { agents?: WizardAgent[] };
      const list = body.agents ?? [];
      setAgents(list);
      // Preselect the bridge's default agent, else the first one.
      const preferred = list.find((a) => a.is_default) ?? list[0];
      setSelectedAgent(preferred?.name ?? "");
      setStep(4);
    } catch (err) {
      if (isSessionExpired(err)) {
        setSessionExpired(true);
        return;
      }
      setDiscoverError("Couldn't reach the server. Try again.");
    } finally {
      setDiscovering(false);
    }
  }

  async function handleSendTest() {
    setSendError(null);
    setSending(true);
    try {
      // 1) Create the integration if we haven't already. Server-side validation
      // re-spawns the bridge and confirms default_agent — so a 201 here means
      // the full path is sound. Guarded so a retry after a send failure doesn't
      // recreate (and 409) the row.
      let intId = integrationId;
      if (!intId) {
        const createRes = await authedFetch(
          "/api/integrations",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              integration_type: "openclaw",
              config: {
                bridge_path: bridgePath.trim(),
                default_agent: selectedAgent,
              },
            }),
          },
          getAccessTokenSilently,
        );

        if (createRes.status === 409) {
          setSendError(
            "You already have an OpenClaw integration. Remove it first to connect a different one.",
          );
          return;
        }
        if (!createRes.ok) {
          let msg = "Couldn't create the integration. Try again.";
          try {
            const body = (await createRes.json()) as {
              reason?: string;
              error?: string;
            };
            if (body?.reason) msg = body.reason;
            else if (body?.error) msg = body.error;
          } catch {
            // keep default
          }
          setSendError(msg);
          return;
        }

        const cbody = (await createRes.json()) as { id: string };
        intId = cbody.id;
        setIntegrationId(intId);
        // The row exists now — let the parent list reflect it even if the test
        // message below fails.
        onConnected();
      }

      // 2) Send the test message.
      const msgRes = await authedFetch(
        `/api/integrations/${intId}/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: "reply OK" }),
        },
        getAccessTokenSilently,
      );

      if (!msgRes.ok) {
        let msg = "The agent didn't reply. Try again.";
        try {
          const body = (await msgRes.json()) as {
            message?: string;
            error?: string;
          };
          if (body?.message) msg = body.message;
          else if (body?.error) msg = body.error;
        } catch {
          // keep default
        }
        setSendError(msg);
        return;
      }

      const mbody = (await msgRes.json()) as { reply?: string };
      setTestReply(mbody.reply ?? "(empty reply)");
    } catch (err) {
      if (isSessionExpired(err)) {
        setSessionExpired(true);
        return;
      }
      setSendError("Couldn't reach the server. Try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div
      className="wp-wizard-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Connect OpenClaw"
    >
      <div className="wp-wizard">
        <div className="wp-wizard-head">
          <span className="wp-wizard-progress">Step {step} of 6</span>
          <button type="button" className="linklike" onClick={onClose}>
            Cancel
          </button>
        </div>

        {sessionExpired ? <SessionExpiredNotice /> : null}

        {!sessionExpired && step === 1 ? (
          <div className="wp-wizard-step">
            <h3>Connect OpenClaw</h3>
            <p>
              OpenClaw is a local AI agent system. Connecting it gives AI Connect
              full access to the agent&apos;s local powers — file system, shell,
              tools, and stored credentials — <strong>through the agent</strong>.
            </p>
            <p>
              This is irreversible without disconnecting. Only proceed on a
              machine you control and trust.
            </p>
            <p>Connection requires:</p>
            <ul className="wp-wizard-list">
              <li>AI Connect running locally on the same host as OpenClaw</li>
              <li>
                The maximus-bridge installed (
                <a
                  href="https://github.com/MacroTechTitan/maximus-bridge"
                  target="_blank"
                  rel="noreferrer"
                >
                  github.com/MacroTechTitan/maximus-bridge
                </a>
                )
              </li>
              <li>OpenClaw installed and the Gateway running</li>
            </ul>
            <p className="muted">
              Read the local mode docs: <code>/docs/LOCAL_MODE.md</code>
            </p>
            <div className="wp-wizard-nav">
              <button type="button" className="linklike" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={() => setStep(2)}
              >
                I Understand — Continue
              </button>
            </div>
            <p className="muted">
              OpenClaw integration is local-only. Cloud AI Connect cannot use it.
            </p>
          </div>
        ) : null}

        {!sessionExpired && step === 2 ? (
          <div className="wp-wizard-step">
            <h3>Locate the maximus-bridge</h3>
            <p>
              Enter the absolute path to <code>maximus-bridge/index.mjs</code>.
              AI Connect spawns this file as a child process to communicate with
              OpenClaw.
            </p>
            <label className="wp-wizard-field">
              Bridge path
              <input
                type="text"
                placeholder="/Users/yourname/dev/maximus-bridge/index.mjs"
                value={bridgePath}
                onChange={(e) => setBridgePath(e.target.value)}
              />
            </label>
            <p className="muted">
              Tip: run <code>which maximus-bridge</code> or check your
              maximus-bridge clone directory.
            </p>
            {pathError ? <p className="error">{pathError}</p> : null}
            <div className="wp-wizard-nav">
              <button
                type="button"
                className="linklike"
                onClick={() => setStep(1)}
              >
                Back
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={handleContinueFromPath}
              >
                Continue
              </button>
            </div>
          </div>
        ) : null}

        {!sessionExpired && step === 3 ? (
          <div className="wp-wizard-step">
            <h3>Testing connection…</h3>
            {discovering ? (
              <p>Spawning bridge and listing agents… (this can take 5–10 seconds)</p>
            ) : null}
            {discoverError ? (
              <>
                <p className="error">{discoverError}</p>
                <div className="wp-wizard-nav">
                  <button
                    type="button"
                    className="linklike"
                    onClick={() => setStep(2)}
                  >
                    Back to edit bridge path
                  </button>
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={() => void runDiscover()}
                  >
                    Retry
                  </button>
                </div>
              </>
            ) : null}
          </div>
        ) : null}

        {!sessionExpired && step === 4 ? (
          <div className="wp-wizard-step">
            <h3>Select default agent</h3>
            <p>
              Choose which OpenClaw agent AI Connect should talk to by default.
              You can switch later.
            </p>
            {agents.length === 0 ? (
              <p className="muted">
                The bridge returned no agents. Go back and check OpenClaw is
                configured with at least one agent.
              </p>
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
                        <span className="openclaw-agent-meta">
                          Workspace: {a.workspace}
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
            <div className="wp-wizard-nav">
              <button
                type="button"
                className="linklike"
                onClick={() => setStep(2)}
              >
                Back
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={() => setStep(5)}
                disabled={selectedAgent.length === 0}
              >
                Continue
              </button>
            </div>
          </div>
        ) : null}

        {!sessionExpired && step === 5 ? (
          <div className="wp-wizard-step">
            <h3>Send a test message</h3>
            <p>
              Let&apos;s send a quick test to <strong>{selectedAgent}</strong> to
              confirm the full round-trip works.
            </p>
            <label className="wp-wizard-field">
              Message
              <textarea value="reply OK" readOnly rows={2} />
            </label>
            <button
              type="button"
              className="btn-primary"
              onClick={() => void handleSendTest()}
              disabled={sending}
            >
              {sending ? "Sending…" : testReply ? "Resend" : "Send"}
            </button>
            {sendError ? <p className="error">{sendError}</p> : null}
            {testReply ? (
              <div className="openclaw-reply">
                <span className="muted">Agent reply</span>
                <pre>{testReply}</pre>
              </div>
            ) : null}
            <div className="wp-wizard-nav">
              <button
                type="button"
                className="linklike"
                onClick={() => setStep(4)}
              >
                Back
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={() => setStep(6)}
                disabled={!testReply}
              >
                Continue
              </button>
            </div>
          </div>
        ) : null}

        {!sessionExpired && step === 6 ? (
          <div className="wp-wizard-step">
            <h3>OpenClaw connected</h3>
            <p>AI Connect can now talk to your local OpenClaw agent.</p>
            <ul className="wp-wizard-list">
              <li>
                Bridge path: <code>{bridgePath.trim()}</code>
              </li>
              <li>Default agent: {chosen?.name ?? selectedAgent}</li>
              {chosen?.identity ? <li>Identity: {chosen.identity}</li> : null}
              {chosen?.model ? <li>Model: {chosen.model}</li> : null}
            </ul>
            <div className="wp-wizard-nav">
              <button type="button" className="linklike" onClick={onClose}>
                Done
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={() => {
                  if (integrationId) onManageAgents(integrationId);
                  else onClose();
                }}
              >
                Manage Agents
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
