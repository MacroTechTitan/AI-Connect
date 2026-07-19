import { eq } from "drizzle-orm";
import type { Express, Request, Response } from "express";

import { getDb } from "../db/client.js";
import { githubInstallations } from "../db/schema.js";
import { GithubError, githubClient } from "../lib/integrations/githubClient.js";
import {
  encodeState,
  verifyState,
} from "../lib/integrations/githubOAuthState.js";
import { logSystem } from "../lib/logging.js";
import type { AuthedUserContext } from "../lib/orgScope.js";
import {
  requireAuth,
  requireHydratedUser,
} from "../middleware/requireAuth.js";

const GITHUB_APP_SLUG = "ai-connect-app";

// The callback is hit by GitHub redirecting the browser (a top-level GET
// navigation carries no Origin header), so this almost always falls back to the
// production web app URL. Mirrors the resolver in routes/subscription.ts.
const DEFAULT_WEB_APP_URL = "https://aiconnect.macrotechtitan.com";

function resolveWebOrigin(req: Request): string {
  const origin = req.headers.origin;
  return typeof origin === "string" && origin.length > 0
    ? origin
    : DEFAULT_WEB_APP_URL;
}

// req.user is guaranteed by requireHydratedUser; this just narrows the type.
function getCtx(req: Request): AuthedUserContext {
  return req.user!;
}

// GET /api/github/install — starts the install flow (auth required).
async function handleStartInstall(
  req: Request,
  res: Response,
): Promise<void> {
  const ctx = getCtx(req);

  let state: string;
  try {
    state = encodeState(ctx.userId);
  } catch (err) {
    await logSystem("error", "github_oauth", "state_signing_failed", {
      user_id: ctx.userId,
      error: (err as Error).message,
    });
    res.status(500).json({
      error: "state_signing_failed",
      message: "Could not sign state parameter. Check server configuration.",
    });
    return;
  }

  const installUrl = `https://github.com/apps/${GITHUB_APP_SLUG}/installations/new?state=${encodeURIComponent(state)}`;

  await logSystem("info", "github_oauth", "install_flow_started", {
    user_id: ctx.userId,
  });

  // Returns the URL as JSON (not a 302) because this route is behind
  // requireAuth: the frontend fetches it with the Auth0 bearer, then navigates
  // the browser to install_url itself. A top-level browser redirect here could
  // not carry the bearer, and the state must be server-signed, so the frontend
  // cannot build this URL on its own.
  res.json({ install_url: installUrl });
}

// GET /api/github/oauth/callback — user returns here after installing on GitHub.
async function handleOAuthCallback(
  req: Request,
  res: Response,
): Promise<void> {
  const code = typeof req.query.code === "string" ? req.query.code : null;
  const state = typeof req.query.state === "string" ? req.query.state : null;
  const installationIdStr =
    typeof req.query.installation_id === "string"
      ? req.query.installation_id
      : null;
  const setupAction =
    typeof req.query.setup_action === "string"
      ? req.query.setup_action
      : null;

  const webOrigin = resolveWebOrigin(req);
  const errorRedirect = (reason: string) =>
    `${webOrigin}/settings/integrations?github_error=${encodeURIComponent(reason)}`;
  const successRedirect = (installationId: number) =>
    `${webOrigin}/settings/integrations?github_installed=1&installation_id=${installationId}`;

  if (!state) {
    await logSystem("warn", "github_oauth", "callback_missing_state", {});
    res.redirect(302, errorRedirect("missing_state"));
    return;
  }

  const userId = verifyState(state);
  if (!userId) {
    await logSystem("warn", "github_oauth", "callback_state_invalid", {
      state_prefix: state.slice(0, 8),
    });
    res.redirect(302, errorRedirect("invalid_state"));
    return;
  }

  if (!installationIdStr) {
    await logSystem(
      "warn",
      "github_oauth",
      "callback_missing_installation_id",
      {
        user_id: userId,
        setup_action: setupAction,
      },
    );
    res.redirect(302, errorRedirect("missing_installation_id"));
    return;
  }

  const installationId = Number(installationIdStr);
  if (!Number.isFinite(installationId) || installationId <= 0) {
    await logSystem(
      "warn",
      "github_oauth",
      "callback_invalid_installation_id",
      {
        user_id: userId,
        installation_id_str: installationIdStr,
      },
    );
    res.redirect(302, errorRedirect("invalid_installation_id"));
    return;
  }

  // Best-effort OAuth code exchange for the installing user's GitHub identity.
  // A failure here doesn't invalidate the installation, so we continue.
  let githubUserLogin: string | null = null;
  if (code) {
    try {
      const { access_token } = await githubClient.exchangeOAuthCode(code);
      const user = await githubClient.getAuthenticatedUser(access_token);
      githubUserLogin = user.login;
    } catch (err) {
      const errMsg =
        err instanceof GithubError ? err.message : (err as Error).message;
      await logSystem(
        "warn",
        "github_oauth",
        "oauth_exchange_failed_but_continuing",
        {
          user_id: userId,
          installation_id: installationId,
          error: errMsg,
        },
      );
    }
  }

  let installation;
  try {
    installation = await githubClient.getInstallation(installationId);
  } catch (err) {
    const errMsg =
      err instanceof GithubError ? err.message : (err as Error).message;
    await logSystem("error", "github_oauth", "installation_fetch_failed", {
      user_id: userId,
      installation_id: installationId,
      error: errMsg,
    });
    res.redirect(302, errorRedirect("installation_fetch_failed"));
    return;
  }

  const db = getDb();
  const existing = await db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.installationId, installationId))
    .limit(1)
    .then((rows) => rows[0]);

  if (existing) {
    await db
      .update(githubInstallations)
      .set({
        userId,
        accountLogin: installation.account.login,
        accountType: installation.account.type,
        accountId: installation.account.id,
        repositorySelection: installation.repository_selection,
        permissions: installation.permissions,
        suspendedAt: installation.suspended_at
          ? new Date(installation.suspended_at)
          : null,
        updatedAt: new Date(),
      })
      .where(eq(githubInstallations.installationId, installationId));

    await logSystem("info", "github_oauth", "installation_row_updated", {
      user_id: userId,
      installation_id: installationId,
      account_login: installation.account.login,
      github_user_login: githubUserLogin,
    });
  } else {
    await db.insert(githubInstallations).values({
      installationId,
      userId,
      accountLogin: installation.account.login,
      accountType: installation.account.type,
      accountId: installation.account.id,
      repositorySelection: installation.repository_selection,
      permissions: installation.permissions,
      suspendedAt: installation.suspended_at
        ? new Date(installation.suspended_at)
        : null,
    });

    await logSystem("info", "github_oauth", "installation_row_created", {
      user_id: userId,
      installation_id: installationId,
      account_login: installation.account.login,
      account_type: installation.account.type,
      github_user_login: githubUserLogin,
    });
  }

  res.redirect(302, successRedirect(installationId));
}

/**
 * Registers the GitHub install-flow + OAuth callback routes.
 *
 * /api/github/install is behind requireAuth (we need the AI Connect user to
 * sign into the state param). /api/github/oauth/callback is deliberately NOT
 * behind requireAuth — GitHub redirects an unauthenticated browser here after
 * install; auth comes from the HMAC-signed state parameter instead.
 */
export function registerGithubOAuthRoutes(app: Express): void {
  app.get(
    "/api/github/install",
    requireAuth,
    requireHydratedUser,
    handleStartInstall,
  );
  app.get("/api/github/oauth/callback", handleOAuthCallback);
}
