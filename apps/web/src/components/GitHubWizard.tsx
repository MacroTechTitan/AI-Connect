import "./GitHubWizard.css";
import { useEffect, useState } from "react";

import { authedFetch, isSessionExpired, type GetAccessToken } from "../lib/api";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Modal } from "../ui/Modal";
import { Wizard, type WizardStep } from "../ui/Wizard";
import { SessionExpiredNotice } from "./SessionExpiredNotice";

type StepId = "welcome" | "install" | "done";

const STEPS: WizardStep[] = [
  { id: "welcome", title: "Welcome" },
  { id: "install", title: "Install" },
  { id: "done", title: "Done" },
];

// welcome uses the default Back/Continue footer; install + done render their own
// contextual actions (hideFooter).
const FOOTER_STEPS = new Set<StepId>(["welcome"]);

type InstallationInfo = {
  installation_id: number;
  account_login: string;
  account_type: "User" | "Organization";
  repository_selection: "all" | "selected";
};

// Three-step wizard for installing the AI Connect GitHub App. Unlike the other
// wizards it collects no credentials — it redirects to GitHub and handles the
// return trip. When the parent reopens it after the GitHub redirect it passes
// initialInstallationId, which jumps straight to the "done" step.
export function GitHubWizard({
  getAccessTokenSilently,
  onClose,
  onConnected,
  onManageIntegration,
  initialInstallationId,
}: {
  getAccessTokenSilently: GetAccessToken;
  onClose: () => void;
  onConnected?: (integrationId: string) => void;
  onManageIntegration?: (integrationId: string) => void;
  initialInstallationId?: number;
}) {
  const [step, setStep] = useState<StepId>(
    initialInstallationId ? "done" : "welcome",
  );
  const [sessionExpired, setSessionExpired] = useState(false);

  // Step "install"
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  // Step "done"
  const [finalizing, setFinalizing] = useState(false);
  const [doneError, setDoneError] = useState<string | null>(null);
  const [integrationId, setIntegrationId] = useState<string | null>(null);
  const [summary, setSummary] = useState<{
    account_login: string;
    account_type: "User" | "Organization";
    repository_selection: "all" | "selected";
    repo_count: number | null;
  } | null>(null);

  // If reopened after the GitHub redirect, finalize immediately.
  useEffect(() => {
    if (initialInstallationId) {
      void finalizeInstallation(initialInstallationId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialInstallationId]);

  async function handleInstall() {
    setInstallError(null);
    setInstalling(true);
    try {
      const res = await authedFetch(
        "/api/github/install",
        {},
        getAccessTokenSilently,
      );
      if (!res.ok) {
        let msg = "Couldn't start the GitHub install flow.";
        try {
          const body = (await res.json()) as {
            message?: string;
            error?: string;
          };
          msg = body.message ?? body.error ?? msg;
        } catch {
          // keep default
        }
        setInstallError(msg);
        setInstalling(false);
        return;
      }
      const body = (await res.json()) as { install_url?: string };
      if (!body.install_url) {
        setInstallError("GitHub returned no install URL. Try again.");
        setInstalling(false);
        return;
      }
      // Navigate the browser to GitHub. GitHub redirects back to the web app
      // with ?github_installed=1&installation_id=<id>, which the app detects.
      window.location.href = body.install_url;
    } catch (err) {
      if (isSessionExpired(err)) {
        setSessionExpired(true);
        return;
      }
      setInstallError("Couldn't reach the server. Try again.");
      setInstalling(false);
    }
  }

  // Hydrate the installation, create the integration, and build the summary.
  async function finalizeInstallation(installationId: number) {
    setDoneError(null);
    setFinalizing(true);
    try {
      // 1) Hydrate installation metadata (from the OAuth-callback-created row).
      const hydrateRes = await authedFetch(
        `/api/integrations/github/installation/${installationId}`,
        {},
        getAccessTokenSilently,
      );
      if (!hydrateRes.ok) {
        let msg = "Couldn't load your GitHub installation.";
        try {
          const body = (await hydrateRes.json()) as {
            message?: string;
            error?: string;
          };
          msg = body.message ?? body.error ?? msg;
        } catch {
          // keep default
        }
        setDoneError(msg);
        return;
      }
      const install = (await hydrateRes.json()) as InstallationInfo;

      // 2) Create the integration referencing the installation.
      const createRes = await authedFetch(
        "/api/integrations",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            integration_type: "github",
            config: {
              installation_id: install.installation_id,
              account_login: install.account_login,
              account_type: install.account_type,
              repository_selection: install.repository_selection,
            },
          }),
        },
        getAccessTokenSilently,
      );

      if (createRes.status === 409) {
        // Already connected — reuse the existing github integration.
        const existingId = await findExistingGithubIntegrationId();
        setIntegrationId(existingId);
        setSummary({
          account_login: install.account_login,
          account_type: install.account_type,
          repository_selection: install.repository_selection,
          repo_count: null,
        });
        return;
      }

      if (!createRes.ok) {
        let msg = "Couldn't save the GitHub integration.";
        try {
          const body = (await createRes.json()) as {
            reason?: string;
            message?: string;
            error?: string;
          };
          msg = body.reason ?? body.message ?? body.error ?? msg;
        } catch {
          // keep default
        }
        setDoneError(msg);
        return;
      }

      const created = (await createRes.json()) as {
        id: string;
        identity?: { repo_count?: number };
      };
      setIntegrationId(created.id);
      onConnected?.(created.id);
      setSummary({
        account_login: install.account_login,
        account_type: install.account_type,
        repository_selection: install.repository_selection,
        repo_count:
          typeof created.identity?.repo_count === "number"
            ? created.identity.repo_count
            : null,
      });
    } catch (err) {
      if (isSessionExpired(err)) {
        setSessionExpired(true);
        return;
      }
      setDoneError("Couldn't reach the server. Try again.");
    } finally {
      setFinalizing(false);
    }
  }

  async function findExistingGithubIntegrationId(): Promise<string | null> {
    try {
      const res = await authedFetch(
        "/api/integrations",
        {},
        getAccessTokenSilently,
      );
      if (!res.ok) return null;
      const body = (await res.json()) as {
        integrations?: Array<{ id: string; integration_type: string }>;
      };
      return (
        body.integrations?.find((i) => i.integration_type === "github")?.id ??
        null
      );
    } catch {
      return null;
    }
  }

  return (
    <Modal open onClose={onClose} size="md" title="Connect GitHub">
      {sessionExpired ? (
        <SessionExpiredNotice />
      ) : (
        <Wizard
          steps={STEPS}
          currentStepId={step}
          onStepChange={(id) => setStep(id as StepId)}
          onCancel={onClose}
          hideFooter={!FOOTER_STEPS.has(step)}
        >
          {step === "welcome" ? (
            <div className="gh-step">
              <p>
                AI Connect can create GitHub repos in your own org for projects
                you provision, and manage issues and pull requests on your
                behalf. Install the AI Connect App on your GitHub account or
                organization to get started.
              </p>
              <Card variant="outlined" padding="sm">
                <ul className="gh-list">
                  <li>You&apos;ll be redirected to GitHub to install AI Connect App</li>
                  <li>You choose which repos AI Connect can access (all or selected)</li>
                  <li>You can uninstall anytime from GitHub</li>
                </ul>
              </Card>
              <p className="gh-subhead">What AI Connect can do:</p>
              <ul className="gh-list">
                <li>Create issues and pull requests</li>
                <li>
                  Create private repos in your org for Project Genesis
                  (Sprint 10.5+ full auto-provisioning)
                </li>
                <li>React to repo events (bot behavior deferred to Sprint 11+)</li>
              </ul>
            </div>
          ) : null}

          {step === "install" ? (
            <div className="gh-step">
              <p>
                Click <strong>Install AI Connect App</strong> to go to GitHub.
                You&apos;ll pick which account or org, then choose repo access.
                GitHub will redirect you back when done.
              </p>
              {installError ? <p className="gh-error">{installError}</p> : null}
              <div className="gh-actions">
                <Button variant="ghost" onClick={onClose}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  loading={installing}
                  onClick={() => void handleInstall()}
                >
                  Install AI Connect App on GitHub
                </Button>
              </div>
            </div>
          ) : null}

          {step === "done" ? (
            <div className="gh-step">
              {finalizing ? (
                <p className="gh-muted">Finishing setup…</p>
              ) : doneError ? (
                <>
                  <p className="gh-error">{doneError}</p>
                  <div className="gh-actions">
                    <Button variant="ghost" onClick={onClose}>
                      Close
                    </Button>
                    {initialInstallationId ? (
                      <Button
                        onClick={() =>
                          void finalizeInstallation(initialInstallationId)
                        }
                      >
                        Retry
                      </Button>
                    ) : null}
                  </div>
                </>
              ) : summary ? (
                <>
                  <p>
                    <strong>Connected!</strong> The AI Connect App is installed
                    on your GitHub account.
                  </p>
                  <Card variant="default" padding="sm">
                    <div className="gh-summary">
                      <div>
                        <span className="gh-muted">Account</span>
                        <div className="gh-account">
                          <span className="gh-mono">{summary.account_login}</span>
                          <Badge variant="info">{summary.account_type}</Badge>
                        </div>
                      </div>
                      <div>
                        <span className="gh-muted">Repo access</span>
                        <div>{summary.repository_selection}</div>
                      </div>
                      <div>
                        <span className="gh-muted">Repos accessible</span>
                        <div>{summary.repo_count ?? "—"}</div>
                      </div>
                    </div>
                  </Card>
                  <div className="gh-actions">
                    <Button
                      onClick={() => {
                        if (integrationId) onManageIntegration?.(integrationId);
                        else onClose();
                      }}
                    >
                      Manage GitHub Integration
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        if (integrationId) onConnected?.(integrationId);
                        onClose();
                      }}
                    >
                      Done
                    </Button>
                  </div>
                </>
              ) : null}
            </div>
          ) : null}
        </Wizard>
      )}
    </Modal>
  );
}
