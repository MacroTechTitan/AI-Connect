import "./OpenClawWizard.css";
import { useState } from "react";

import { authedFetch, isSessionExpired, type GetAccessToken } from "../lib/api";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Input } from "../ui/Input";
import { Modal } from "../ui/Modal";
import { Wizard, type WizardStep } from "../ui/Wizard";
import { HelpLink } from "./HelpLink";
import { SessionExpiredNotice } from "./SessionExpiredNotice";

interface WizardAgent {
  name: string;
  is_default?: boolean;
  identity?: string;
  workspace?: string;
  model?: string;
}

type StepId =
  | "welcome"
  | "bridgePath"
  | "discover"
  | "pickAgent"
  | "test"
  | "success";

const STEPS: WizardStep[] = [
  { id: "welcome", title: "Welcome" },
  { id: "bridgePath", title: "Bridge Path" },
  { id: "discover", title: "Discover" },
  { id: "pickAgent", title: "Pick Agent" },
  { id: "test", title: "Test" },
  { id: "success", title: "Success" },
];

// Steps that drive Back/Continue via the default Wizard footer. Every other
// step renders its own contextual action (and so uses hideFooter).
const FOOTER_STEPS = new Set<StepId>(["welcome", "bridgePath"]);

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
//
// Sprint 8 Commit 5: refactored onto the design-system primitives (Modal,
// Wizard, Button, Input, Badge, Card). Copy, validation, API calls, and the
// create-integration-then-test-message sequence are unchanged from Sprint 7.
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
  const [step, setStep] = useState<StepId>("welcome");
  const [sessionExpired, setSessionExpired] = useState(false);

  // Step "bridgePath"
  const [bridgePath, setBridgePath] = useState("");

  // Step "discover"
  const [discovering, setDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [agents, setAgents] = useState<WizardAgent[]>([]);

  // Step "pickAgent"
  const [selectedAgent, setSelectedAgent] = useState("");

  // Step "test" — test message + integration creation
  const [integrationId, setIntegrationId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [testReply, setTestReply] = useState<string | null>(null);

  const chosen = agents.find((a) => a.name === selectedAgent);

  async function runDiscover() {
    setDiscoverError(null);
    setDiscovering(true);
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
      setStep("pickAgent");
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

  // Footer config for the two default-footer steps. Advancing from "bridgePath"
  // into "discover" kicks off the discovery call (see onStepChange below), so
  // its Continue is gated on a non-empty path.
  const isWelcome = step === "welcome";
  const nextLabel = isWelcome ? "I Understand — Continue" : "Continue";
  const canGoNext = isWelcome ? true : bridgePath.trim().length > 0;

  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title="Connect OpenClaw"
      titleAccessory={<HelpLink articleId="openclaw" label="Help — OpenClaw" />}
    >
      {sessionExpired ? (
        <SessionExpiredNotice />
      ) : (
        <Wizard
          steps={STEPS}
          currentStepId={step}
          // The default footer drives welcome→bridgePath→discover. Entering
          // "discover" auto-runs the discovery call (matches the Sprint 7 flow
          // where Continue from the bridge path kicked off discovery).
          onStepChange={(id) => {
            const next = id as StepId;
            setStep(next);
            if (next === "discover") void runDiscover();
          }}
          onCancel={onClose}
          nextLabel={nextLabel}
          canGoNext={canGoNext}
          hideFooter={!FOOTER_STEPS.has(step)}
        >
          {step === "welcome" ? (
            <div className="ocw-step">
              <p>
                OpenClaw is a local AI agent system. Connecting it gives AI
                Connect full access to the agent&apos;s local powers — file
                system, shell, tools, and stored credentials —{" "}
                <strong>through the agent</strong>.
              </p>
              <p>
                This is irreversible without disconnecting. Only proceed on a
                machine you control and trust.
              </p>
              <p>Connection requires:</p>
              <ul className="ocw-list">
                <li>AI Connect running locally on the same host as OpenClaw</li>
                <li>
                  The maximus-bridge installed (
                  <a
                    className="ocw-link"
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
              <p className="ocw-muted">
                Read the local mode docs: <code>/docs/LOCAL_MODE.md</code>
              </p>
              <p className="ocw-muted">
                OpenClaw integration is local-only. Cloud AI Connect cannot use
                it.
              </p>
            </div>
          ) : null}

          {step === "bridgePath" ? (
            <div className="ocw-step">
              <p>
                Enter the absolute path to{" "}
                <code>maximus-bridge/index.mjs</code>. AI Connect spawns this
                file as a child process to communicate with OpenClaw.
              </p>
              <Input
                label="Bridge path"
                type="text"
                placeholder="/Users/yourname/dev/maximus-bridge/index.mjs"
                value={bridgePath}
                onChange={(e) => setBridgePath(e.target.value)}
              />
              <p className="ocw-muted">
                Tip: run <code>which maximus-bridge</code> or check your
                maximus-bridge clone directory.
              </p>
            </div>
          ) : null}

          {step === "discover" ? (
            <div className="ocw-step">
              {discovering ? (
                <p>
                  Spawning bridge and listing agents… (this can take 5–10
                  seconds)
                </p>
              ) : null}
              {discoverError ? (
                <>
                  <p className="ocw-error">{discoverError}</p>
                  <div className="ocw-actions">
                    <Button
                      variant="ghost"
                      onClick={() => setStep("bridgePath")}
                    >
                      Back to edit bridge path
                    </Button>
                    <Button onClick={() => void runDiscover()}>Retry</Button>
                  </div>
                </>
              ) : null}
            </div>
          ) : null}

          {step === "pickAgent" ? (
            <div className="ocw-step">
              <p>
                Choose which OpenClaw agent AI Connect should talk to by
                default. You can switch later.
              </p>
              {agents.length === 0 ? (
                <p className="ocw-muted">
                  The bridge returned no agents. Go back and check OpenClaw is
                  configured with at least one agent.
                </p>
              ) : (
                <div className="ocw-agent-cards">
                  {agents.map((a) => {
                    const selected = selectedAgent === a.name;
                    return (
                      <Card
                        key={a.name}
                        variant={selected ? "elevated" : "outlined"}
                        padding="sm"
                        interactive
                        onClick={() => setSelectedAgent(a.name)}
                      >
                        <div className="ocw-agent">
                          <div className="ocw-agent-name">
                            {a.name}
                            {a.is_default ? (
                              <Badge variant="info">Default</Badge>
                            ) : null}
                            {selected ? (
                              <Badge variant="success">Selected</Badge>
                            ) : null}
                          </div>
                          {a.identity ? (
                            <div className="ocw-agent-meta">
                              Identity: {a.identity}
                            </div>
                          ) : null}
                          {a.workspace ? (
                            <div className="ocw-agent-meta">
                              Workspace: {a.workspace}
                            </div>
                          ) : null}
                          {a.model ? (
                            <div className="ocw-agent-meta">
                              Model: {a.model}
                            </div>
                          ) : null}
                        </div>
                      </Card>
                    );
                  })}
                </div>
              )}
              <div className="ocw-actions">
                <Button variant="ghost" onClick={() => setStep("bridgePath")}>
                  Back
                </Button>
                <Button
                  onClick={() => setStep("test")}
                  disabled={selectedAgent.length === 0}
                >
                  Continue
                </Button>
              </div>
            </div>
          ) : null}

          {step === "test" ? (
            <div className="ocw-step">
              <p>
                Let&apos;s send a quick test to <strong>{selectedAgent}</strong>{" "}
                to confirm the full round-trip works.
              </p>
              <div className="ocw-field">
                <span className="ocw-field-label">Message</span>
                <div className="ocw-message-box">reply OK</div>
              </div>
              <Button onClick={() => void handleSendTest()} disabled={sending}>
                {sending ? "Sending…" : testReply ? "Resend" : "Send"}
              </Button>
              {sendError ? <p className="ocw-error">{sendError}</p> : null}
              {testReply ? (
                <div className="ocw-reply">
                  <span className="ocw-muted">Agent reply</span>
                  <pre>{testReply}</pre>
                </div>
              ) : null}
              <div className="ocw-actions">
                <Button variant="ghost" onClick={() => setStep("pickAgent")}>
                  Back
                </Button>
                <Button onClick={() => setStep("success")} disabled={!testReply}>
                  Continue
                </Button>
              </div>
            </div>
          ) : null}

          {step === "success" ? (
            <div className="ocw-step">
              <p>AI Connect can now talk to your local OpenClaw agent.</p>
              <ul className="ocw-list">
                <li>
                  Bridge path: <code>{bridgePath.trim()}</code>
                </li>
                <li>Default agent: {chosen?.name ?? selectedAgent}</li>
                {chosen?.identity ? <li>Identity: {chosen.identity}</li> : null}
                {chosen?.model ? <li>Model: {chosen.model}</li> : null}
              </ul>
              <div className="ocw-actions">
                <Button variant="ghost" onClick={onClose}>
                  Done
                </Button>
                <Button
                  onClick={() => {
                    if (integrationId) onManageAgents(integrationId);
                    else onClose();
                  }}
                >
                  Manage Agents
                </Button>
              </div>
            </div>
          ) : null}
        </Wizard>
      )}
    </Modal>
  );
}
