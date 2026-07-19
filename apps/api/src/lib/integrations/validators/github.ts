import { eq } from "drizzle-orm";

import { getDb } from "../../../db/client.js";
import { githubInstallations } from "../../../db/schema.js";
import { GithubError, githubClient } from "../githubClient.js";
import type {
  GithubConfig,
  GithubIdentity,
  IntegrationValidator,
} from "../types.js";

/**
 * Factory function. Returns an IntegrationValidator for GitHub App
 * integrations. userId is unused (no per-user ownership check), so it's
 * prefixed `_`.
 *
 * GitHub App auth uses the server-side private key + per-installation tokens,
 * so there is no per-user credential — the validator ignores `credential`. It
 * confirms the github_installations row exists (created by the OAuth callback),
 * verifies the installation is still live via getInstallation, and counts the
 * repos it can reach (non-fatal on failure).
 */
export function makeGithubValidator(_userId: string): IntegrationValidator {
  return async ({ config }) => {
    const c = config as GithubConfig;

    if (typeof c.installation_id !== "number" || !c.installation_id) {
      return {
        valid: false,
        errorMessage: 'GitHub config requires "installation_id" (numeric).',
      };
    }

    // Confirm the installation exists in our DB (set up via OAuth callback).
    const db = getDb();
    const installationRow = await db
      .select()
      .from(githubInstallations)
      .where(eq(githubInstallations.installationId, c.installation_id))
      .limit(1)
      .then((rows) => rows[0]);

    if (!installationRow) {
      return {
        valid: false,
        errorMessage: `GitHub installation ${c.installation_id} not found in AI Connect. Complete the install flow at /api/github/install first.`,
      };
    }

    // Verify the installation is still live via the GitHub App API.
    let installation;
    try {
      installation = await githubClient.getInstallation(c.installation_id);
    } catch (err) {
      if (err instanceof GithubError) {
        if (err.code === "installation_not_found") {
          return {
            valid: false,
            errorMessage: `GitHub installation ${c.installation_id} was uninstalled. Reinstall the AI Connect App on GitHub.`,
          };
        }
        if (err.code === "installation_suspended") {
          return {
            valid: false,
            errorMessage: `GitHub installation ${c.installation_id} is suspended. Reactivate it on GitHub.`,
          };
        }
        return { valid: false, errorMessage: err.message };
      }
      throw err;
    }

    // Count repos the installation can reach. Non-fatal: the installation is
    // valid even if enumeration fails (empty org, permissions blip).
    let repoCount = 0;
    try {
      const repos = await githubClient.getInstallationRepos(c.installation_id);
      repoCount = repos.length;
    } catch (err) {
      if (!(err instanceof GithubError)) throw err;
    }

    const identity: GithubIdentity = {
      installation_id: installation.id,
      account_login: installation.account.login,
      account_type: installation.account.type,
      account_id: installation.account.id,
      repository_selection: installation.repository_selection,
      repo_count: repoCount,
      permissions_summary: {
        contents: installation.permissions.contents,
        issues: installation.permissions.issues,
        pull_requests: installation.permissions.pull_requests,
        administration: installation.permissions.administration,
        metadata: installation.permissions.metadata,
        checks: installation.permissions.checks,
      },
      suspended: installation.suspended_at !== null,
    };

    return { valid: true, identity };
  };
}
