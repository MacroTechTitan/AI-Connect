import "./Auth0Wizard.css";
import { useState } from "react";

import { authedFetch, isSessionExpired, type GetAccessToken } from "../lib/api";
import { Badge, type BadgeVariant } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Input } from "../ui/Input";
import { Modal } from "../ui/Modal";
import { Wizard, type WizardStep } from "../ui/Wizard";
import { HelpLink } from "./HelpLink";
import { SessionExpiredNotice } from "./SessionExpiredNotice";

interface Auth0App {
  client_id: string;
  name: string;
  app_type?: "spa" | "native" | "regular_web" | "non_interactive";
}

type StepId = "welcome" | "credentials" | "validate" | "pickApp" | "done";

const STEPS: WizardStep[] = [
  { id: "welcome", title: "Welcome" },
  { id: "credentials", title: "Credentials" },
  { id: "validate", title: "Validate" },
  { id: "pickApp", title: "Pick App" },
  { id: "done", title: "Done" },
];

// welcome + credentials drive Back/Continue via the default Wizard footer; the
// rest render their own contextual actions (hideFooter).
const FOOTER_STEPS = new Set<StepId>(["welcome", "credentials"]);

// Maps an Auth0 application's app_type to a Badge variant + label.
function appTypeBadge(type: string | undefined): {
  variant: BadgeVariant;
  label: string;
} {
  switch (type) {
    case "regular_web":
      return { variant: "info", label: "regular_web" };
    case "spa":
      return { variant: "success", label: "spa" };
    case "native":
      return { variant: "warning", label: "native" };
    case "non_interactive":
      return { variant: "neutral", label: "non_interactive" };
    default:
      return { variant: "neutral", label: type ?? "unknown" };
  }
}

// Maps the POST /api/integrations failure body to actionable copy. The route
// returns config-shape errors as bare codes and validator failures as
// { error: "integration_invalid", reason: <actionable message> }.
function describeValidateError(
  status: number,
  body: { error?: string; reason?: string; message?: string },
): string {
  if (body.error === "invalid_auth0_domain") {
    return "Domain format looks wrong. Expected: yourtenant.us.auth0.com";
  }
  if (body.error === "missing_m2m_client_id") {
    return "M2M Client ID is required.";
  }
  if (body.reason) return body.reason;
  if (status === 401 || status === 403) {
    return "Auth0 rejected the credentials. Check the domain, client_id, and client_secret.";
  }
  return (
    body.message ??
    body.error ??
    "Validation failed. Check your credentials and try again."
  );
}

// Five-step wizard for connecting an Auth0 tenant. A controlled modal the parent
// gates with `{open ? <Auth0Wizard/> : null}`. Auth0 works in cloud mode — no
// local-mode gating. Built on the design-system primitives (Sprint 8).
export function Auth0Wizard({
  getAccessTokenSilently,
  onClose,
  onConnected,
  onManageApplications,
}: {
  getAccessTokenSilently: GetAccessToken;
  onClose: () => void;
  onConnected?: (integrationId: string) => void;
  onManageApplications?: (integrationId: string) => void;
}) {
  const [step, setStep] = useState<StepId>("welcome");
  const [sessionExpired, setSessionExpired] = useState(false);

  // Step "credentials"
  const [domain, setDomain] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");

  // Step "validate"
  const [validating, setValidating] = useState(false);
  const [validateError, setValidateError] = useState<string | null>(null);
  const [integrationId, setIntegrationId] = useState<string | null>(null);

  // Step "pickApp" / "done"
  const [apps, setApps] = useState<Auth0App[]>([]);
  const [loadingApps, setLoadingApps] = useState(false);
  const [appsError, setAppsError] = useState<string | null>(null);
  const [selectedApp, setSelectedApp] = useState<string>(""); // client_id, or "" = none
  const [savingDefault, setSavingDefault] = useState(false);

  // Step "done"
  const [testing, setTesting] = useState(false);
  const [testNote, setTestNote] = useState<string | null>(null);

  const selectedAppName = apps.find((a) => a.client_id === selectedApp)?.name;

  async function loadApps(intId: string) {
    setLoadingApps(true);
    setAppsError(null);
    try {
      const res = await authedFetch(
        `/api/integrations/${intId}/auth0/applications`,
        {},
        getAccessTokenSilently,
      );
      if (!res.ok) {
        let msg = "Couldn't list Auth0 applications.";
        try {
          const body = (await res.json()) as {
            message?: string;
            error?: string;
          };
          msg = body.message ?? body.error ?? msg;
        } catch {
          // keep default
        }
        setAppsError(msg);
        setApps([]);
        return;
      }
      const body = (await res.json()) as { applications?: Auth0App[] };
      setApps(body.applications ?? []);
    } catch (err) {
      if (isSessionExpired(err)) {
        setSessionExpired(true);
        return;
      }
      setAppsError("Couldn't reach the server. Try again.");
      setApps([]);
    } finally {
      setLoadingApps(false);
    }
  }

  // Runs on entering "validate": creates the integration (once), then loads the
  // tenant's applications and advances to "pickApp".
  async function runValidate() {
    setValidateError(null);
    setValidating(true);
    try {
      let intId = integrationId;
      if (!intId) {
        const res = await authedFetch(
          "/api/integrations",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              integration_type: "auth0",
              credential: clientSecret,
              config: {
                domain: domain.trim(),
                m2m_client_id: clientId.trim(),
              },
            }),
          },
          getAccessTokenSilently,
        );

        if (res.status === 409) {
          setValidateError(
            "You already have an Auth0 integration. Remove it first to connect a different tenant.",
          );
          return;
        }
        if (!res.ok) {
          let body: { error?: string; reason?: string; message?: string } = {};
          try {
            body = (await res.json()) as typeof body;
          } catch {
            // keep empty; describeValidateError falls back to a generic line
          }
          setValidateError(describeValidateError(res.status, body));
          return;
        }

        const body = (await res.json()) as { id: string };
        intId = body.id;
        setIntegrationId(intId);
        onConnected?.(intId);
      }

      // Integration exists — load applications for the picker, then advance.
      await loadApps(intId);
      setStep("pickApp");
    } catch (err) {
      if (isSessionExpired(err)) {
        setSessionExpired(true);
        return;
      }
      setValidateError("Couldn't reach the server. Try again.");
    } finally {
      setValidating(false);
    }
  }

  async function useAsDefault() {
    if (!integrationId || !selectedApp) return;
    setSavingDefault(true);
    setAppsError(null);
    try {
      const res = await authedFetch(
        `/api/integrations/${integrationId}/auth0/default-application`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ application_id: selectedApp }),
        },
        getAccessTokenSilently,
      );
      if (!res.ok) {
        setAppsError("Couldn't set the default application. Try again.");
        return;
      }
      goToDone();
    } catch (err) {
      if (isSessionExpired(err)) {
        setSessionExpired(true);
        return;
      }
      setAppsError("Couldn't reach the server. Try again.");
    } finally {
      setSavingDefault(false);
    }
  }

  function skipDefault() {
    // No default chosen — the integration's default_application_id stays unset,
    // and Project Genesis will create an app per project.
    setSelectedApp("");
    goToDone();
  }

  function goToDone() {
    setStep("done");
    void runTest();
  }

  // Runs on entering "done": a final list call to confirm the round trip works.
  async function runTest() {
    if (!integrationId) return;
    setTesting(true);
    setTestNote(null);
    try {
      const res = await authedFetch(
        `/api/integrations/${integrationId}/auth0/applications`,
        {},
        getAccessTokenSilently,
      );
      if (!res.ok) {
        setTestNote(
          "Connected, but the final application list couldn't be refreshed. You can manage applications later.",
        );
        return;
      }
      const body = (await res.json()) as { applications?: Auth0App[] };
      setApps(body.applications ?? apps);
    } catch (err) {
      if (isSessionExpired(err)) {
        setSessionExpired(true);
        return;
      }
      setTestNote(
        "Connected, but couldn't reach the server for a final check.",
      );
    } finally {
      setTesting(false);
    }
  }

  const canGoNext =
    step === "credentials"
      ? domain.trim().length > 0 &&
        clientId.trim().length > 0 &&
        clientSecret.length > 0
      : true;

  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title="Connect Auth0"
      titleAccessory={<HelpLink articleId="auth0" label="Help — Auth0" />}
    >
      {sessionExpired ? (
        <SessionExpiredNotice />
      ) : (
        <Wizard
          steps={STEPS}
          currentStepId={step}
          // The default footer drives welcome→credentials→validate. Entering
          // "validate" kicks off credential validation + app listing.
          onStepChange={(id) => {
            const next = id as StepId;
            setStep(next);
            if (next === "validate") void runValidate();
          }}
          onCancel={onClose}
          canGoNext={canGoNext}
          hideFooter={!FOOTER_STEPS.has(step)}
        >
          {step === "welcome" ? (
            <div className="aw-step">
              <p>
                Auth0 lets AI Connect wire authentication into projects you
                provision. Every new project gets its own Auth0 application
                automatically.
              </p>
              <p>You&apos;ll need:</p>
              <ul className="aw-list">
                <li>An Auth0 tenant</li>
                <li>
                  A Machine-to-Machine application authorized for the Auth0
                  Management API with these scopes:
                  <br />
                  <code>read:clients</code>, <code>create:clients</code>,{" "}
                  <code>update:clients</code>, <code>read:client_keys</code>
                </li>
              </ul>
              <p className="aw-muted">
                Setup guide: <code>docs/AUTH0_CONNECTOR.md</code>
              </p>
            </div>
          ) : null}

          {step === "credentials" ? (
            <div className="aw-step">
              <p>
                Enter your Auth0 tenant domain and the Machine-to-Machine app&apos;s
                credentials.
              </p>
              <Input
                label="Auth0 domain"
                type="text"
                placeholder="yourtenant.us.auth0.com"
                helperText="No https://, no trailing slash"
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
              />
              <Input
                label="M2M Client ID"
                type="text"
                placeholder="long alphanumeric ID"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
              />
              <Input
                label="M2M Client Secret"
                type="password"
                helperText="Stored encrypted in AI Connect Vault. Never displayed again after this step."
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
              />
            </div>
          ) : null}

          {step === "validate" ? (
            <div className="aw-step">
              {validating ? <p>Verifying credentials with Auth0…</p> : null}
              {validateError ? (
                <>
                  <p className="aw-error">{validateError}</p>
                  <div className="aw-actions">
                    <Button
                      variant="ghost"
                      onClick={() => setStep("credentials")}
                    >
                      Back
                    </Button>
                    <Button onClick={() => void runValidate()}>Retry</Button>
                  </div>
                </>
              ) : null}
            </div>
          ) : null}

          {step === "pickApp" ? (
            <div className="aw-step">
              <p>
                Choose a default Auth0 application for projects that don&apos;t
                need a fresh one — or skip and let AI Connect create one per
                project.
              </p>

              {loadingApps ? (
                <p className="aw-muted">Loading applications…</p>
              ) : appsError ? (
                <>
                  <p className="aw-error">{appsError}</p>
                  <div className="aw-actions">
                    <Button
                      onClick={() =>
                        integrationId ? void loadApps(integrationId) : undefined
                      }
                    >
                      Retry
                    </Button>
                  </div>
                </>
              ) : apps.length === 0 ? (
                <p className="aw-muted">
                  This Auth0 tenant has no applications yet. AI Connect will
                  create one for each project you provision. Click
                  &quot;Skip&quot; to continue.
                </p>
              ) : (
                <div className="aw-app-cards">
                  {apps.map((a) => {
                    const selected = selectedApp === a.client_id;
                    const badge = appTypeBadge(a.app_type);
                    return (
                      <Card
                        key={a.client_id}
                        variant={selected ? "elevated" : "default"}
                        padding="sm"
                        interactive
                        onClick={() => setSelectedApp(a.client_id)}
                      >
                        <div className="aw-app">
                          <div className="aw-app-name">
                            {a.name}
                            <Badge variant={badge.variant}>{badge.label}</Badge>
                            {selected ? (
                              <Badge variant="success">Selected</Badge>
                            ) : null}
                          </div>
                          <div className="aw-app-meta aw-mono">
                            …{a.client_id.slice(-8)}
                          </div>
                        </div>
                      </Card>
                    );
                  })}
                </div>
              )}

              <div className="aw-actions">
                <Button variant="ghost" onClick={() => setStep("credentials")}>
                  Back
                </Button>
                <Button variant="ghost" onClick={skipDefault}>
                  Skip — new apps will be created per project
                </Button>
                {selectedApp ? (
                  <Button onClick={() => void useAsDefault()} disabled={savingDefault}>
                    {savingDefault ? "Saving…" : "Use as Default"}
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}

          {step === "done" ? (
            <div className="aw-step">
              {testing ? (
                <p>Testing connection…</p>
              ) : (
                <>
                  <p>
                    <strong>Connected!</strong> Auth0 is ready to wire into new
                    projects.
                  </p>
                  <Card variant="default" padding="sm">
                    <div className="aw-summary">
                      <div>
                        <span className="aw-muted">Tenant</span>
                        <div>{domain.trim()}</div>
                      </div>
                      <div>
                        <span className="aw-muted">Applications</span>
                        <div>{apps.length}</div>
                      </div>
                      <div>
                        <span className="aw-muted">Default application</span>
                        <div>
                          {selectedApp
                            ? (selectedAppName ?? selectedApp)
                            : "None — new apps created per project"}
                        </div>
                      </div>
                    </div>
                  </Card>
                  {testNote ? <p className="aw-muted">{testNote}</p> : null}
                  <div className="aw-actions">
                    <Button
                      onClick={() => {
                        if (integrationId) onManageApplications?.(integrationId);
                        else onClose();
                      }}
                    >
                      View Applications
                    </Button>
                    <Button variant="ghost" onClick={onClose}>
                      Done
                    </Button>
                  </div>
                </>
              )}
            </div>
          ) : null}
        </Wizard>
      )}
    </Modal>
  );
}
