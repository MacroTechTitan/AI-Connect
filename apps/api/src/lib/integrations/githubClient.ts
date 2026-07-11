/**
 * GitHub App client for AI Connect.
 *
 * There is ONE ai-connect-app on GitHub. Users install it on their orgs
 * or accounts. AI Connect authenticates as the App via JWT signed with
 * GITHUB_APP_PRIVATE_KEY, then mints per-installation tokens (60min TTL)
 * to act on behalf of specific installations.
 *
 * Two auth layers:
 * - App-level: JWT signed with private key, RS256, 10min expiry. Used
 *   for installation management + minting installation tokens.
 * - Installation-level: short-lived token from POST /app/installations/
 *   :id/access_tokens. Used for all repo/issue/PR operations.
 *
 * Installation tokens are cached in-process per installation_id with
 * 55-min TTL (tokens expire in 60min; 5min refresh buffer). Same lazy
 * pattern as Sprint 9's stripeClient.
 *
 * OAuth is separate: used only during install flow to identify which
 * AI Connect user installed the App. NOT used for repo operations.
 */

import { App } from "@octokit/app";
import { Octokit } from "@octokit/rest";
import { verify } from "@octokit/webhooks-methods";

import { env } from "../env.js";

// ============================================================
// Error types
// ============================================================

export type GithubErrorCode =
  | "invalid_credentials"
  | "installation_not_found"
  | "installation_suspended"
  | "repo_not_found"
  | "permissions_missing"
  | "rate_limited"
  | "invalid_request"
  | "api_error"
  | "network_error"
  | "webhook_signature_invalid";

export class GithubError extends Error {
  constructor(
    public readonly code: GithubErrorCode,
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "GithubError";
  }
}

// ============================================================
// App singleton
// ============================================================

/**
 * Lazy App instance. Not created until first use so dev doesn't require
 * env vars. Matches AUTH0_* / STRIPE_* handling.
 */
let appInstance: App | null = null;

function getApp(): App {
  if (appInstance) return appInstance;

  const appId = env.GITHUB_APP_ID;
  const privateKey = env.GITHUB_APP_PRIVATE_KEY;

  if (!appId || !privateKey) {
    throw new GithubError(
      "invalid_credentials",
      "GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY must be set. Configure them in environment variables.",
    );
  }

  // Env vars often carry literal "\n" instead of real newlines — normalize
  // before the SDK signs with the PEM.
  const normalizedKey = privateKey.replace(/\\n/g, "\n");

  appInstance = new App({
    appId: Number(appId),
    privateKey: normalizedKey,
    ...(env.GITHUB_APP_CLIENT_ID && env.GITHUB_APP_CLIENT_SECRET
      ? {
          oauth: {
            clientId: env.GITHUB_APP_CLIENT_ID,
            clientSecret: env.GITHUB_APP_CLIENT_SECRET,
          },
        }
      : {}),
    ...(env.GITHUB_APP_WEBHOOK_SECRET
      ? { webhooks: { secret: env.GITHUB_APP_WEBHOOK_SECRET } }
      : {}),
  });

  return appInstance;
}

// ============================================================
// Installation token cache
// ============================================================

type CachedToken = {
  token: string;
  expiresAt: number; // epoch ms
};

const TOKEN_TTL_BUFFER_MS = 5 * 60 * 1000; // refresh 5min before expiry

const installationTokenCache = new Map<number, CachedToken>();

async function getInstallationToken(installationId: number): Promise<string> {
  const cached = installationTokenCache.get(installationId);
  const now = Date.now();

  if (cached && cached.expiresAt - TOKEN_TTL_BUFFER_MS > now) {
    return cached.token;
  }

  const app = getApp();

  try {
    const { data } = await app.octokit.request(
      "POST /app/installations/{installation_id}/access_tokens",
      { installation_id: installationId },
    );

    const expiresAt = new Date(data.expires_at).getTime();
    installationTokenCache.set(installationId, {
      token: data.token,
      expiresAt,
    });

    return data.token;
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 404) {
      throw new GithubError(
        "installation_not_found",
        `GitHub installation ${installationId} not found. It may have been uninstalled.`,
        err,
      );
    }
    if (status === 403) {
      throw new GithubError(
        "installation_suspended",
        `GitHub installation ${installationId} is suspended.`,
        err,
      );
    }
    throw mapGithubError(err);
  }
}

async function getInstallationOctokit(
  installationId: number,
): Promise<Octokit> {
  const token = await getInstallationToken(installationId);
  return new Octokit({ auth: token });
}

// ============================================================
// Error mapping helper
// ============================================================

function mapGithubError(err: unknown): GithubError {
  if (err instanceof GithubError) return err;

  const anyErr = err as {
    status?: number;
    message?: string;
    code?: string;
    response?: { headers?: Record<string, string> };
  };
  const status = anyErr?.status;
  const message = anyErr?.message ?? "Unknown GitHub error";

  if (status === 401)
    return new GithubError("invalid_credentials", message, err);
  if (status === 403) {
    // Could be permissions or rate limit
    if (anyErr?.response?.headers?.["x-ratelimit-remaining"] === "0") {
      return new GithubError("rate_limited", message, err);
    }
    return new GithubError("permissions_missing", message, err);
  }
  if (status === 404) return new GithubError("repo_not_found", message, err);
  if (status === 429) return new GithubError("rate_limited", message, err);
  if (status && status >= 400 && status < 500) {
    return new GithubError("invalid_request", message, err);
  }
  if (status && status >= 500) {
    return new GithubError("api_error", message, err);
  }
  if (anyErr?.code === "ENOTFOUND" || anyErr?.code === "ECONNREFUSED") {
    return new GithubError("network_error", message, err);
  }

  return new GithubError("api_error", message, err);
}

// ============================================================
// GithubClient — public API
// ============================================================

export type GithubInstallationInfo = {
  id: number;
  account: {
    id: number;
    login: string;
    type: "User" | "Organization";
  };
  repository_selection: "all" | "selected";
  permissions: Record<string, string>;
  suspended_at: string | null;
};

export type GithubRepo = {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  html_url: string;
  default_branch: string;
  description: string | null;
};

export type CreateRepoParams = {
  name: string;
  description?: string;
  private?: boolean;
  auto_init?: boolean;
  gitignore_template?: string;
  license_template?: string;
};

export type CreateIssueParams = {
  owner: string;
  repo: string;
  title: string;
  body?: string;
  labels?: string[];
};

export type CreatePullRequestParams = {
  owner: string;
  repo: string;
  title: string;
  head: string; // branch with changes
  base: string; // branch to merge into
  body?: string;
  draft?: boolean;
};

export class GithubClient {
  /**
   * Gets installation details. App-level auth.
   */
  async getInstallation(
    installationId: number,
  ): Promise<GithubInstallationInfo> {
    const app = getApp();
    try {
      const { data } = await app.octokit.request(
        "GET /app/installations/{installation_id}",
        { installation_id: installationId },
      );
      // data.account is SimpleUser | Enterprise | null in the Octokit types;
      // for a real installation it's the org/user account. Narrow via cast.
      const account = data.account as unknown as {
        id: number;
        login: string;
        type: "User" | "Organization";
      };
      return {
        id: data.id,
        account: {
          id: account.id,
          login: account.login,
          type: account.type,
        },
        repository_selection: data.repository_selection as "all" | "selected",
        permissions: data.permissions as unknown as Record<string, string>,
        suspended_at: data.suspended_at ?? null,
      };
    } catch (err) {
      throw mapGithubError(err);
    }
  }

  /**
   * Lists repositories the installation has access to. Installation-level auth.
   * Pagination: v1 fetches first 100 (GitHub max per page). Sprint 10.5+ can
   * add full pagination if users have >100 repos accessible.
   */
  async getInstallationRepos(installationId: number): Promise<GithubRepo[]> {
    const octokit = await getInstallationOctokit(installationId);
    try {
      const { data } = await octokit.apps.listReposAccessibleToInstallation({
        per_page: 100,
      });
      return data.repositories.map((r) => ({
        id: r.id,
        name: r.name,
        full_name: r.full_name,
        private: r.private,
        html_url: r.html_url,
        default_branch: r.default_branch,
        description: r.description,
      }));
    } catch (err) {
      throw mapGithubError(err);
    }
  }

  /**
   * Creates a repo in the installation's account. Installation-level auth.
   * Uses createInOrg for Organization accounts, createForAuthenticatedUser
   * for User accounts.
   */
  async createRepo(
    installationId: number,
    accountType: "User" | "Organization",
    accountLogin: string,
    params: CreateRepoParams,
  ): Promise<GithubRepo> {
    const octokit = await getInstallationOctokit(installationId);
    try {
      const commonParams = {
        name: params.name,
        description: params.description,
        private: params.private ?? true,
        auto_init: params.auto_init ?? true,
        gitignore_template: params.gitignore_template,
        license_template: params.license_template,
      };

      const data =
        accountType === "Organization"
          ? (
              await octokit.repos.createInOrg({
                org: accountLogin,
                ...commonParams,
              })
            ).data
          : // User account — the installation token acts as the user
            (await octokit.repos.createForAuthenticatedUser(commonParams)).data;

      return {
        id: data.id,
        name: data.name,
        full_name: data.full_name,
        private: data.private,
        html_url: data.html_url,
        default_branch: data.default_branch,
        description: data.description,
      };
    } catch (err) {
      throw mapGithubError(err);
    }
  }

  /**
   * Creates an issue. Installation-level auth.
   */
  async createIssue(
    installationId: number,
    params: CreateIssueParams,
  ): Promise<{ number: number; html_url: string }> {
    const octokit = await getInstallationOctokit(installationId);
    try {
      const { data } = await octokit.issues.create({
        owner: params.owner,
        repo: params.repo,
        title: params.title,
        body: params.body,
        labels: params.labels,
      });
      return { number: data.number, html_url: data.html_url };
    } catch (err) {
      throw mapGithubError(err);
    }
  }

  /**
   * Creates a pull request. Installation-level auth.
   */
  async createPullRequest(
    installationId: number,
    params: CreatePullRequestParams,
  ): Promise<{ number: number; html_url: string }> {
    const octokit = await getInstallationOctokit(installationId);
    try {
      const { data } = await octokit.pulls.create({
        owner: params.owner,
        repo: params.repo,
        title: params.title,
        head: params.head,
        base: params.base,
        body: params.body,
        draft: params.draft,
      });
      return { number: data.number, html_url: data.html_url };
    } catch (err) {
      throw mapGithubError(err);
    }
  }

  /**
   * Test connection — fetches installation + repos, returns success if reachable.
   */
  async testConnection(installationId: number): Promise<{
    ok: boolean;
    account_login: string;
    account_type: string;
    repo_count?: number;
  }> {
    try {
      const installation = await this.getInstallation(installationId);
      const repos = await this.getInstallationRepos(installationId);
      return {
        ok: true,
        account_login: installation.account.login,
        account_type: installation.account.type,
        repo_count: repos.length,
      };
    } catch (err) {
      throw mapGithubError(err);
    }
  }

  // ============================================================
  // OAuth flow (identity linking during install)
  // ============================================================

  /**
   * Exchanges OAuth authorization code for user access token.
   * Called from the OAuth callback route.
   */
  async exchangeOAuthCode(code: string): Promise<{
    access_token: string;
    scope: string;
  }> {
    if (!env.GITHUB_APP_CLIENT_ID || !env.GITHUB_APP_CLIENT_SECRET) {
      throw new GithubError(
        "invalid_credentials",
        "GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET must be set.",
      );
    }

    try {
      const response = await fetch(
        "https://github.com/login/oauth/access_token",
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            client_id: env.GITHUB_APP_CLIENT_ID,
            client_secret: env.GITHUB_APP_CLIENT_SECRET,
            code,
          }),
        },
      );

      const data = (await response.json()) as {
        access_token?: string;
        scope?: string;
        error?: string;
        error_description?: string;
      };
      if (data.error) {
        throw new GithubError(
          "invalid_credentials",
          `OAuth code exchange failed: ${data.error_description ?? data.error}`,
        );
      }
      return {
        access_token: data.access_token ?? "",
        scope: data.scope ?? "",
      };
    } catch (err) {
      if (err instanceof GithubError) throw err;
      throw mapGithubError(err);
    }
  }

  /**
   * Gets the authenticated user's GitHub info via OAuth token.
   * Used post-OAuth-exchange to identify the installing user.
   */
  async getAuthenticatedUser(oauthToken: string): Promise<{
    id: number;
    login: string;
    email: string | null;
  }> {
    const octokit = new Octokit({ auth: oauthToken });
    try {
      const { data } = await octokit.users.getAuthenticated();
      return {
        id: data.id,
        login: data.login,
        email: data.email,
      };
    } catch (err) {
      throw mapGithubError(err);
    }
  }

  // ============================================================
  // Webhook signature verification
  // ============================================================

  /**
   * Verifies a GitHub webhook signature against the raw request body.
   * Called from the webhook route BEFORE parsing JSON.
   *
   * Returns true if the signature is valid, false if not. The route handler
   * should return 400 on false.
   */
  async verifyWebhookSignature(
    rawBody: string,
    signature: string | undefined,
  ): Promise<boolean> {
    if (!signature) return false;
    if (!env.GITHUB_APP_WEBHOOK_SECRET) {
      throw new GithubError(
        "invalid_credentials",
        "GITHUB_APP_WEBHOOK_SECRET is not set.",
      );
    }

    try {
      return await verify(env.GITHUB_APP_WEBHOOK_SECRET, rawBody, signature);
    } catch {
      return false;
    }
  }
}

// Singleton instance — stateless aside from the token cache
export const githubClient = new GithubClient();
