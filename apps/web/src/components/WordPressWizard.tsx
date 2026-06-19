import { useState } from "react";

import { authedFetch, isSessionExpired, type GetAccessToken } from "../lib/api";
import { SessionExpiredNotice } from "./SessionExpiredNotice";

interface ConnectedIntegration {
  id: string;
  siteUrl: string;
  pluginVersion: string;
}

// Six-step guided flow for a first WordPress connection. The goal is minimum
// manual work: one-click download, on-screen install steps, paste two strings,
// done. Module management afterward never returns to WP admin.
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
  const [step, setStep] = useState(1);
  const [sessionExpired, setSessionExpired] = useState(false);

  // Step 2 — download
  const [downloading, setDownloading] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  // Step 5 — connect
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
      setStep(6);
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

  return (
    <div
      className="wp-wizard-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Connect a WordPress Site"
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
            <h3>Connect a WordPress Site</h3>
            <p>
              This wizard guides you through installing the AI Connect plugin on
              your WordPress site. The whole process takes about 2 minutes.
            </p>
            <button
              type="button"
              className="btn-primary"
              onClick={() => setStep(2)}
            >
              Get Started
            </button>
          </div>
        ) : null}

        {!sessionExpired && step === 2 ? (
          <div className="wp-wizard-step">
            <h3>Download the AI Connect Plugin</h3>
            <p>
              Download the plugin .zip — you&apos;ll upload it to your WordPress
              site in the next step.
            </p>
            <button
              type="button"
              className="btn-primary"
              onClick={() => void handleDownload()}
              disabled={downloading}
            >
              {downloading
                ? "Preparing…"
                : "Download AI Connect Plugin (.zip)"}
            </button>
            {downloaded ? (
              <p className="muted">Downloaded. Continue when ready.</p>
            ) : null}
            {downloadError ? <p className="error">{downloadError}</p> : null}
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
                onClick={() => setStep(3)}
                disabled={!downloaded}
              >
                Next: Install on WordPress
              </button>
            </div>
          </div>
        ) : null}

        {!sessionExpired && step === 3 ? (
          <div className="wp-wizard-step">
            <h3>Install on Your WordPress Site</h3>
            <ol className="wp-wizard-list">
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
                onClick={() => setStep(4)}
              >
                I&apos;ve installed the plugin
              </button>
            </div>
          </div>
        ) : null}

        {!sessionExpired && step === 4 ? (
          <div className="wp-wizard-step">
            <h3>Get Your Connection Token</h3>
            <ol className="wp-wizard-list">
              <li>
                In your WordPress admin, go to <strong>Settings → AI Connect</strong>.
              </li>
              <li>
                Click the <strong>Generate New Token</strong> button.
              </li>
              <li>Copy the token displayed.</li>
            </ol>
            {/^https?:\/\//i.test(siteUrl) ? (
              <p>
                <a href={siteUrl} target="_blank" rel="noreferrer">
                  Open your WordPress site ↗
                </a>
              </p>
            ) : null}
            <div className="wp-wizard-nav">
              <button
                type="button"
                className="linklike"
                onClick={() => setStep(3)}
              >
                Back
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={() => setStep(5)}
              >
                I have my token
              </button>
            </div>
          </div>
        ) : null}

        {!sessionExpired && step === 5 ? (
          <div className="wp-wizard-step">
            <h3>Enter Your Site Details</h3>
            <label className="wp-wizard-field">
              WordPress Site URL
              <input
                type="text"
                placeholder="https://yoursite.com"
                value={siteUrl}
                onChange={(e) => setSiteUrl(e.target.value)}
              />
            </label>
            <label className="wp-wizard-field">
              Token
              <input
                type="password"
                placeholder="Paste the token from WP admin"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </label>
            {connectError ? <p className="error">{connectError}</p> : null}
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
                onClick={() => void handleTestConnection()}
                disabled={testing}
              >
                {testing ? "Testing…" : "Test Connection"}
              </button>
            </div>
          </div>
        ) : null}

        {!sessionExpired && step === 6 && connected ? (
          <div className="wp-wizard-step">
            <h3>Connected!</h3>
            <p>
              <strong>{connected.siteUrl}</strong>
              <br />
              Plugin version: {connected.pluginVersion}
            </p>
            <div className="wp-wizard-nav">
              <button
                type="button"
                className="btn-primary"
                onClick={() =>
                  onManageModules(connected.id, connected.siteUrl)
                }
              >
                Add Your First Module
              </button>
              <button type="button" className="linklike" onClick={onClose}>
                Done — Set Up Modules Later
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
