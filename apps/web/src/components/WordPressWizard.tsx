import "./WordPressWizard.css";
import { useState } from "react";

import { authedFetch, isSessionExpired, type GetAccessToken } from "../lib/api";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Modal } from "../ui/Modal";
import { Wizard, type WizardStep } from "../ui/Wizard";
import { HelpLink } from "./HelpLink";
import { SessionExpiredNotice } from "./SessionExpiredNotice";

interface ConnectedIntegration {
  id: string;
  siteUrl: string;
  pluginVersion: string;
}

type StepId = "welcome" | "download" | "install" | "token" | "connect" | "success";

const STEPS: WizardStep[] = [
  { id: "welcome", title: "Welcome" },
  { id: "download", title: "Download Plugin" },
  { id: "install", title: "Install" },
  { id: "token", title: "Get Token" },
  { id: "connect", title: "Connect" },
  { id: "success", title: "Success" },
];

// Per-step footer label for the default Wizard footer (steps 1-4). Preserves
// the original wizard's button copy.
const NEXT_LABEL: Record<StepId, string> = {
  welcome: "Get Started",
  download: "Next: Install on WordPress",
  install: "I've installed the plugin",
  token: "I have my token",
  connect: "",
  success: "",
};

// Steps 5 and 6 render their own primary actions inside the content, so the
// Wizard footer is hidden for them.
const CUSTOM_ACTION_STEPS = new Set<StepId>(["connect", "success"]);

// Six-step guided flow for a first WordPress connection. The goal is minimum
// manual work: one-click download, on-screen install steps, paste two strings,
// done. Module management afterward never returns to WP admin.
//
// Sprint 8 Commit 4: refactored onto the design-system primitives (Modal,
// Wizard, Button, Input, Badge). Copy, validation, and API calls are
// unchanged from the Sprint 6 version.
export function WordPressWizard({
  getAccessTokenSilently,
  onClose,
  onConnected,
  onManageModules,
}: {
  getAccessTokenSilently: GetAccessToken;
  onClose: () => void;
  // Called once the integration is created so the parent can refresh its list.
  onConnected: () => void;
  onManageModules: (integrationId: string, siteUrl: string) => void;
}) {
  const [step, setStep] = useState<StepId>("welcome");
  const [sessionExpired, setSessionExpired] = useState(false);

  // Step "download"
  const [downloading, setDownloading] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  // Step "connect"
  const [siteUrl, setSiteUrl] = useState("");
  const [token, setToken] = useState("");
  const [testing, setTesting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  const [connected, setConnected] = useState<ConnectedIntegration | null>(null);

  async function handleDownload() {
    setDownloadError(null);
    setDownloading(true);
    try {
      // The native EventSource/anchor download can't send the bearer header, so
      // fetch the zip as a blob via authedFetch and trigger a synthetic click.
      const res = await authedFetch(
        "/api/integrations/wordpress/plugin.zip",
        { headers: { Accept: "application/zip" } },
        getAccessTokenSilently,
      );
      if (!res.ok) {
        setDownloadError(
          "Couldn't generate the plugin download. Try again in a moment.",
        );
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "ai-connect.zip";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setDownloaded(true);
    } catch (err) {
      if (isSessionExpired(err)) {
        setSessionExpired(true);
        return;
      }
      setDownloadError("Couldn't reach the server. Try again.");
    } finally {
      setDownloading(false);
    }
  }

  async function handleTestConnection() {
    setConnectError(null);
    if (!/^https?:\/\//i.test(siteUrl)) {
      setConnectError("Enter a site URL starting with http:// or https://.");
      return;
    }
    if (token.trim().length === 0) {
      setConnectError("Paste the token from your WordPress plugin settings.");
      return;
    }
    setTesting(true);
    try {
      const res = await authedFetch(
        "/api/integrations",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            integration_type: "wordpress",
            credential: token.trim(),
            config: { site_url: siteUrl.trim() },
          }),
        },
        getAccessTokenSilently,
      );

      if (res.status === 409) {
        setConnectError(
          "You already have a WordPress integration. Remove it first to connect a different site.",
        );
        return;
      }

      if (!res.ok) {
        let msg = "Connection failed. Check the details and try again.";
        try {
          const body = (await res.json()) as {
            reason?: string;
            error?: string;
          };
          // The validator already maps 404/401/network to actionable copy.
          if (body?.reason) msg = body.reason;
          else if (body?.error) msg = body.error;
        } catch {
          // keep default
        }
        setConnectError(msg);
        return;
      }

      const body = (await res.json()) as {
        id: string;
        identity?: { site_url?: string; plugin_version?: string };
      };
      const result: ConnectedIntegration = {
        id: body.id,
        siteUrl: body.identity?.site_url ?? siteUrl.trim(),
        pluginVersion: body.identity?.plugin_version ?? "unknown",
      };
      setConnected(result);
      onConnected();
      setStep("success");
    } catch (err) {
      if (isSessionExpired(err)) {
        setSessionExpired(true);
        return;
      }
      setConnectError("Couldn't reach the server. Try again.");
    } finally {
      setTesting(false);
    }
  }

  // The "download" step gates Continue until the plugin has been downloaded;
  // every other footer step can always advance.
  const canGoNext = step === "download" ? downloaded : true;

  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title="Connect WordPress"
      titleAccessory={<HelpLink articleId="wordpress" label="Help — WordPress" />}
    >
      {sessionExpired ? (
        <SessionExpiredNotice />
      ) : (
        <Wizard
          steps={STEPS}
          currentStepId={step}
          onStepChange={(id) => setStep(id as StepId)}
          onCancel={onClose}
          nextLabel={NEXT_LABEL[step]}
          canGoNext={canGoNext}
          hideFooter={CUSTOM_ACTION_STEPS.has(step)}
        >
          {step === "welcome" ? (
            <div className="wpw-step">
              <p>
                This wizard guides you through installing the AI Connect plugin
                on your WordPress site. The whole process takes about 2 minutes.
              </p>
            </div>
          ) : null}

          {step === "download" ? (
            <div className="wpw-step">
              <p>
                Download the plugin .zip — you&apos;ll upload it to your
                WordPress site in the next step.
              </p>
              <Button onClick={() => void handleDownload()} disabled={downloading}>
                {downloading ? "Preparing…" : "Download AI Connect Plugin (.zip)"}
              </Button>
              {downloaded ? (
                <p className="wpw-muted">Downloaded. Continue when ready.</p>
              ) : null}
              {downloadError ? <p className="wpw-error">{downloadError}</p> : null}
            </div>
          ) : null}

          {step === "install" ? (
            <div className="wpw-step">
              <ol className="wpw-list">
                <li>
                  Open your WordPress admin → click <strong>Plugins</strong> →{" "}
                  <strong>Add New</strong> → <strong>Upload Plugin</strong>.
                </li>
                <li>
                  Choose the file you just downloaded → click{" "}
                  <strong>Install Now</strong>.
                </li>
                <li>
                  After install completes, click <strong>Activate Plugin</strong>.
                </li>
              </ol>
            </div>
          ) : null}

          {step === "token" ? (
            <div className="wpw-step">
              <ol className="wpw-list">
                <li>
                  In your WordPress admin, go to{" "}
                  <strong>Settings → AI Connect</strong>.
                </li>
                <li>
                  Click the <strong>Generate New Token</strong> button.
                </li>
                <li>Copy the token displayed.</li>
              </ol>
              {/^https?:\/\//i.test(siteUrl) ? (
                <p>
                  <a
                    className="wpw-link"
                    href={siteUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open your WordPress site ↗
                  </a>
                </p>
              ) : null}
            </div>
          ) : null}

          {step === "connect" ? (
            <div className="wpw-step">
              <Input
                label="WordPress Site URL"
                type="text"
                placeholder="https://yoursite.com"
                value={siteUrl}
                onChange={(e) => setSiteUrl(e.target.value)}
              />
              <Input
                label="Token"
                type="password"
                placeholder="Paste the token from WP admin"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
              {connectError ? <p className="wpw-error">{connectError}</p> : null}
              <div className="wpw-actions">
                <Button
                  onClick={() => void handleTestConnection()}
                  disabled={testing}
                >
                  {testing ? "Testing…" : "Test Connection"}
                </Button>
                <Button variant="ghost" onClick={() => setStep("token")}>
                  Back
                </Button>
                <Button variant="ghost" onClick={onClose}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}

          {step === "success" && connected ? (
            <div className="wpw-step">
              <div className="wpw-success-meta">
                <Badge variant="success">Connected</Badge>
                <strong>{connected.siteUrl}</strong>
                <span>Plugin version: {connected.pluginVersion}</span>
              </div>
              <div className="wpw-actions">
                <Button
                  onClick={() =>
                    onManageModules(connected.id, connected.siteUrl)
                  }
                >
                  Add Your First Module
                </Button>
                <Button variant="ghost" onClick={onClose}>
                  Done — Set Up Modules Later
                </Button>
              </div>
            </div>
          ) : null}
        </Wizard>
      )}
    </Modal>
  );
}
