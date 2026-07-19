import "./GitHubIntegrationManager.css";
import { useCallback, useEffect, useState } from "react";

import { authedFetch, isSessionExpired, type GetAccessToken } from "../lib/api";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Input } from "../ui/Input";
import { HelpLink } from "./HelpLink";
import { SessionExpiredNotice } from "./SessionExpiredNotice";

const APP_INSTALL_URL =
  "https://github.com/apps/ai-connect-app/installations/new";
const APP_MANAGE_URL = "https://github.com/settings/installations";

type GithubAccount = {
  account_login: string;
  account_type: "User" | "Organization";
  repository_selection: "all" | "selected";
};

type GithubRepo = {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  html_url: string;
  default_branch: string;
  description: string | null;
};

// Inline panel (rendered below the integrations list, like the Stripe/Auth0
// managers) for managing the GitHub App installation on an integration.
export function GitHubIntegrationManager({
  integrationId,
  getAccessTokenSilently,
  onClose,
}: {
  integrationId: string;
  getAccessTokenSilently: GetAccessToken;
  onClose: () => void;
}) {
  const [account, setAccount] = useState<GithubAccount | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [repos, setRepos] = useState<GithubRepo[] | null>(null);
  const [reposError, setReposError] = useState<string | null>(null);
  const [inFlight, setInFlight] = useState<
    "test_connection" | "create_issue" | null
  >(null);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    msg: string;
  } | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);

  // Create-issue form
  const [issueOwner, setIssueOwner] = useState("");
  const [issueRepo, setIssueRepo] = useState("");
  const [issueTitle, setIssueTitle] = useState("");
  const [issueBody, setIssueBody] = useState("");
  const [issueResult, setIssueResult] = useState<{
    number: number;
    html_url: string;
  } | null>(null);
  const [issueError, setIssueError] = useState<string | null>(null);

  const base = `/api/integrations/${integrationId}`;

  // Account info comes from the integration row's config (GET /api/integrations).
  const loadAccount = useCallback(async () => {
    setAccountError(null);
    try {
      const res = await authedFetch(
        "/api/integrations",
        {},
        getAccessTokenSilently,
      );
      if (!res.ok) {
        setAccountError("Couldn't load the GitHub account.");
        return;
      }
      const body = (await res.json()) as {
        integrations?: Array<{
          id: string;
          integration_type: string;
          config: Record<string, unknown>;
        }>;
      };
      const row = body.integrations?.find((i) => i.id === integrationId);
      if (!row) {
        setAccountError("Integration not found.");
        return;
      }
      const cfg = row.config;
      setAccount({
        account_login: String(cfg.account_login ?? ""),
        account_type:
          cfg.account_type === "Organization" ? "Organization" : "User",
        repository_selection:
          cfg.repository_selection === "selected" ? "selected" : "all",
      });
      if (typeof cfg.account_login === "string" && !issueOwner) {
        setIssueOwner(cfg.account_login);
      }
    } catch (err) {
      if (isSessionExpired(err)) {
        setSessionExpired(true);
        return;
      }
      setAccountError("Couldn't reach the server. Try again.");
    }
    // issueOwner intentionally omitted — only seeded once on first load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getAccessTokenSilently, integrationId]);

  const loadRepos = useCallback(async () => {
    setReposError(null);
    setRepos(null);
    try {
      const res = await authedFetch(
        `${base}/github/repositories`,
        {},
        getAccessTokenSilently,
      );
      if (!res.ok) {
        let msg = "Couldn't load repositories.";
        try {
          const body = (await res.json()) as {
            message?: string;
            error?: string;
          };
          msg = body.message ?? body.error ?? msg;
        } catch {
          // keep default
        }
        setReposError(msg);
        setRepos([]);
        return;
      }
      const body = (await res.json()) as { repositories?: GithubRepo[] };
      setRepos(body.repositories ?? []);
    } catch (err) {
      if (isSessionExpired(err)) {
        setSessionExpired(true);
        return;
      }
      setReposError("Couldn't reach the server. Try again.");
      setRepos([]);
    }
  }, [base, getAccessTokenSilently]);

  useEffect(() => {
    void loadAccount();
    void loadRepos();
  }, [loadAccount, loadRepos]);

  async function handleTestConnection() {
    setInFlight("test_connection");
    setTestResult(null);
    try {
      const res = await authedFetch(
        `${base}/github/test-connection`,
        { method: "POST" },
        getAccessTokenSilently,
      );
      if (res.ok) {
        const body = (await res.json()) as { repo_count?: number };
        setTestResult({
          ok: true,
          msg: `Connected — ${body.repo_count ?? 0} repo(s) accessible.`,
        });
      } else {
        let msg = "Connection failed.";
        try {
          const body = (await res.json()) as {
            message?: string;
            error?: string;
          };
          msg = body.message ?? body.error ?? msg;
        } catch {
          // keep default
        }
        setTestResult({ ok: false, msg });
      }
    } catch (err) {
      if (isSessionExpired(err)) {
        setSessionExpired(true);
        return;
      }
      setTestResult({ ok: false, msg: "Couldn't reach the server. Try again." });
    } finally {
      setInFlight(null);
    }
  }

  async function handleCreateIssue() {
    if (
      issueOwner.trim().length === 0 ||
      issueRepo.trim().length === 0 ||
      issueTitle.trim().length === 0
    ) {
      return;
    }
    setInFlight("create_issue");
    setIssueError(null);
    setIssueResult(null);
    try {
      const res = await authedFetch(
        `${base}/github/issues`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            owner: issueOwner.trim(),
            repo: issueRepo.trim(),
            title: issueTitle.trim(),
            body: issueBody.trim() || undefined,
          }),
        },
        getAccessTokenSilently,
      );
      if (!res.ok) {
        let msg = "Couldn't create the issue.";
        try {
          const body = (await res.json()) as {
            message?: string;
            error?: string;
          };
          msg = body.message ?? body.error ?? msg;
        } catch {
          // keep default
        }
        setIssueError(msg);
        return;
      }
      const body = (await res.json()) as { number: number; html_url: string };
      setIssueResult(body);
      setIssueTitle("");
      setIssueBody("");
    } catch (err) {
      if (isSessionExpired(err)) {
        setSessionExpired(true);
        return;
      }
      setIssueError("Couldn't reach the server. Try again.");
    } finally {
      setInFlight(null);
    }
  }

  if (sessionExpired) {
    return (
      <div className="ghm">
        <SessionExpiredNotice />
      </div>
    );
  }

  return (
    <div className="ghm">
      <div className="ghm-head">
        <h4>
          GitHub Integration
          <HelpLink articleId="github" label="Help — GitHub App" />
        </h4>
        <button type="button" className="linklike" onClick={onClose}>
          Close
        </button>
      </div>

      {accountError ? <p className="ghm-error">{accountError}</p> : null}

      {account ? (
        <Card variant="default" padding="md">
          <div className="ghm-detail-row">
            <span className="ghm-label">Account</span>
            <div className="ghm-account">
              <span className="ghm-mono">{account.account_login}</span>
              <Badge variant="info">{account.account_type}</Badge>
            </div>
          </div>
          <div className="ghm-grid">
            <div className="ghm-detail-row">
              <span className="ghm-label">Repo access</span>
              <div>
                <Badge
                  variant={
                    account.repository_selection === "all" ? "success" : "neutral"
                  }
                >
                  {account.repository_selection}
                </Badge>
              </div>
            </div>
            <div className="ghm-detail-row">
              <span className="ghm-label">Repos accessible</span>
              <span>{repos ? repos.length : "…"}</span>
            </div>
          </div>
        </Card>
      ) : null}

      {/* Repositories */}
      <div className="ghm-section-head">
        <h5>Repositories</h5>
        <button
          type="button"
          className="linklike"
          onClick={() => void loadRepos()}
          disabled={repos === null && !reposError}
        >
          Refresh
        </button>
      </div>
      {reposError ? <p className="ghm-error">{reposError}</p> : null}
      {repos === null && !reposError ? (
        <p className="ghm-muted">Loading repositories…</p>
      ) : repos && repos.length === 0 && !reposError ? (
        <p className="ghm-muted">No repositories accessible yet.</p>
      ) : repos && repos.length > 0 ? (
        <div className="ghm-repos">
          {repos.map((r) => (
            <Card key={r.id} variant="default" padding="sm">
              <div className="ghm-repo">
                <div className="ghm-repo-name">
                  <span className="ghm-mono">{r.full_name}</span>
                  <Badge variant={r.private ? "neutral" : "info"}>
                    {r.private ? "private" : "public"}
                  </Badge>
                </div>
                {r.description ? (
                  <div className="ghm-muted">{r.description}</div>
                ) : null}
                <div className="ghm-repo-meta">
                  <span>default: {r.default_branch}</span>
                  <a href={r.html_url} target="_blank" rel="noreferrer">
                    Open in GitHub ↗
                  </a>
                </div>
              </div>
            </Card>
          ))}
        </div>
      ) : null}

      {/* Actions */}
      <div className="ghm-actions">
        <Button
          variant="primary"
          loading={inFlight === "test_connection"}
          onClick={() => void handleTestConnection()}
        >
          Test Connection
        </Button>
        <a
          className="ghm-linkbtn"
          href={APP_INSTALL_URL}
          target="_blank"
          rel="noreferrer"
        >
          <Button variant="ghost">Reinstall App</Button>
        </a>
        <a
          className="ghm-linkbtn"
          href={APP_MANAGE_URL}
          target="_blank"
          rel="noreferrer"
        >
          <Button variant="ghost">Manage on GitHub</Button>
        </a>
      </div>
      {testResult ? (
        <p className={testResult.ok ? "ghm-muted" : "ghm-error"}>
          {testResult.msg}
        </p>
      ) : null}

      {/* Try it — create a test issue */}
      <div className="ghm-section-head">
        <h5>Create a test issue</h5>
      </div>
      <div className="ghm-issue-form">
        <div className="ghm-issue-row">
          <Input
            label="Owner"
            placeholder="octocat"
            value={issueOwner}
            onChange={(e) => setIssueOwner(e.target.value)}
          />
          <Input
            label="Repo"
            placeholder="hello-world"
            value={issueRepo}
            onChange={(e) => setIssueRepo(e.target.value)}
          />
        </div>
        <Input
          label="Title"
          placeholder="Test issue from AI Connect"
          value={issueTitle}
          onChange={(e) => setIssueTitle(e.target.value)}
        />
        <label className="ghm-field">
          <span className="ghm-field-label">Body (optional)</span>
          <textarea
            className="ghm-textarea"
            rows={3}
            value={issueBody}
            onChange={(e) => setIssueBody(e.target.value)}
          />
        </label>
        {issueError ? <p className="ghm-error">{issueError}</p> : null}
        {issueResult ? (
          <p className="ghm-muted">
            Issue #{issueResult.number} created —{" "}
            <a href={issueResult.html_url} target="_blank" rel="noreferrer">
              view on GitHub ↗
            </a>
          </p>
        ) : null}
        <div className="ghm-actions">
          <Button
            loading={inFlight === "create_issue"}
            disabled={
              issueOwner.trim().length === 0 ||
              issueRepo.trim().length === 0 ||
              issueTitle.trim().length === 0
            }
            onClick={() => void handleCreateIssue()}
          >
            Create Issue
          </Button>
        </div>
      </div>
    </div>
  );
}
