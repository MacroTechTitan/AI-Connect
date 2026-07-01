import { and, eq } from "drizzle-orm";

import { getDb } from "../../db/client.js";
import { integrations } from "../../db/schema.js";
import {
  auth0Client,
  Auth0Error,
  type Auth0Application,
} from "../integrations/auth0Client.js";
import type { Auth0Config } from "../integrations/types.js";
import { logSystem } from "../logging.js";
import {
  getServiceEnvVars,
  putServiceEnvVars,
  type RenderEnvVar,
} from "../platforms/index.js";
import * as vault from "../vault.js";

/**
 * Outcome of best-effort Auth0 wiring during Project Genesis. Surfaced to the
 * UI via the wire_auth0 step's event details — never thrown.
 */
export type Auth0WiringResult =
  | {
      success: true;
      application_id: string;
      application_name: string;
      callback_urls: string[];
    }
  | {
      success: false;
      reason:
        | "no_integration"
        | "integration_not_validated"
        | "vault_read_failed"
        | "auth0_app_creation_failed"
        | "render_env_sync_failed";
      message: string;
      // Present once the Auth0 app exists but a later step (env sync) failed, so
      // the UI can point the user at the app they need to finish wiring by hand.
      application_id?: string;
    };

/**
 * Auto-wires Auth0 for a freshly provisioned project.
 *
 * Looks for the project creator's active Auth0 integration (validated +
 * include_in_projects). If found, creates a new Auth0 application named after
 * the project, points its callback URLs at the project's Render URL, and merges
 * AUTH0_DOMAIN / AUTH0_CLIENT_ID / AUTH0_CLIENT_SECRET / AUTH0_AUDIENCE into the
 * Render service's env vars.
 *
 * BEST-EFFORT: never throws. Every failure path returns a typed result. The
 * caller (the wire_auth0 genesis step) always reports "succeeded" so provisioning
 * is never rolled back over Auth0 wiring.
 *
 * Caveat: a post-create change to a Render service's env vars does not trigger a
 * redeploy (same Render behaviour that forces create_render_service to bake its
 * vars in at creation). So the AUTH0_* vars take effect on the project's NEXT
 * deploy, not the first one.
 */
export async function wireAuth0ForProject(params: {
  userId: string;
  projectId: string;
  projectName: string;
  projectSlug: string;
  renderServiceId: string | undefined;
  renderCredential: string;
  deployedUrl: string | undefined;
}): Promise<Auth0WiringResult> {
  const {
    userId,
    projectId,
    projectName,
    projectSlug,
    renderServiceId,
    renderCredential,
    deployedUrl,
  } = params;

  // 1) Find the creator's active Auth0 integration (validated + opted into
  //    projects). The common "user has no Auth0 integration" case lands here.
  const [row] = await getDb()
    .select({
      id: integrations.id,
      status: integrations.status,
      config: integrations.config,
      vaultSecretId: integrations.vaultSecretId,
    })
    .from(integrations)
    .where(
      and(
        eq(integrations.userId, userId),
        eq(integrations.integrationType, "auth0"),
        eq(integrations.status, "validated"),
        eq(integrations.includeInProjects, true),
      ),
    )
    .limit(1);

  if (!row) {
    return {
      success: false,
      reason: "no_integration",
      message:
        'No active Auth0 integration found. Add one in Settings → Integrations (with "Include in new projects" enabled) to auto-wire Auth0.',
    };
  }

  // 2) Read the M2M client_secret from Vault.
  if (!row.vaultSecretId) {
    return {
      success: false,
      reason: "vault_read_failed",
      message: "Auth0 integration has no vault secret on file.",
    };
  }
  let m2mSecret: string;
  try {
    m2mSecret = await vault.getSecret(row.vaultSecretId);
  } catch (err) {
    return {
      success: false,
      reason: "vault_read_failed",
      message: `Could not read Auth0 M2M secret from vault: ${
        err instanceof Error ? err.message : "unknown error"
      }`,
    };
  }

  const config = row.config as Auth0Config;

  // Need the project's live URL to configure callbacks.
  const base = (deployedUrl ?? "").replace(/\/+$/, "");
  if (!base) {
    return {
      success: false,
      reason: "auth0_app_creation_failed",
      message: "No Render URL available to configure Auth0 callbacks.",
    };
  }
  const callbackUrls = [`${base}/callback`, `${base}/api/auth/callback`];

  // 3) Create the Auth0 application.
  let app: Auth0Application;
  try {
    app = await auth0Client.createApplication(
      config.domain,
      config.m2m_client_id,
      m2mSecret,
      {
        name: projectName,
        description: `AI Connect-provisioned project (ID: ${projectId})`,
        // AI Connect provisions Node services on Render — server-side apps that
        // hold AUTH0_CLIENT_SECRET as a confidential env var and use the
        // authorization code flow with that secret. That's a "regular_web"
        // (confidential) client, not "spa" (a public client with no meaningful
        // secret).
        app_type: "regular_web",
        callbacks: callbackUrls,
        allowed_logout_urls: [base],
        allowed_origins: [base],
        web_origins: [base],
      },
    );
  } catch (err) {
    const msg =
      err instanceof Auth0Error
        ? `${err.code}: ${err.message}`
        : err instanceof Error
          ? err.message
          : "unknown error";
    await logSystem(
      "warn",
      "genesis",
      `Auth0 app creation failed for project ${projectId}: ${msg}`,
      { projectId, projectName, auth0Domain: config.domain },
    );
    return {
      success: false,
      reason: "auth0_app_creation_failed",
      message: `Could not create Auth0 application: ${msg}`,
    };
  }

  if (!app.client_secret) {
    await logSystem(
      "warn",
      "genesis",
      `Auth0 app created without a client_secret for project ${projectId} (M2M may lack read:client_keys)`,
      { projectId, applicationId: app.client_id },
    );
    return {
      success: false,
      reason: "auth0_app_creation_failed",
      message:
        "Auth0 returned the new application without a client_secret. The M2M credential may lack the read:client_keys scope.",
      application_id: app.client_id,
    };
  }

  // 4) Merge AUTH0_* into the Render service env vars. Render's PUT replaces the
  //    whole set, so read current → merge → put (don't drop DATABASE_URL etc.).
  if (!renderServiceId) {
    await logSystem(
      "warn",
      "genesis",
      `Render env sync skipped — no service id for project ${projectId}`,
      { projectId, applicationId: app.client_id },
    );
    return {
      success: false,
      reason: "render_env_sync_failed",
      message: `Auth0 app created (client_id: ${app.client_id}) but no Render service id was available to sync env vars.`,
      application_id: app.client_id,
    };
  }

  const current = await getServiceEnvVars(renderCredential, renderServiceId);
  if (!current.success) {
    await logSystem(
      "warn",
      "genesis",
      `Render env read failed during Auth0 sync for project ${projectId}: ${
        current.errorMessage ?? "unknown"
      }`,
      { projectId, applicationId: app.client_id },
    );
    return {
      success: false,
      reason: "render_env_sync_failed",
      message: `Auth0 app created (client_id: ${app.client_id}) but reading the Render env vars failed: ${
        current.errorMessage ?? "unknown error"
      }.`,
      application_id: app.client_id,
    };
  }

  const merged = new Map<string, string>(
    (current.envVars ?? []).map((v) => [v.key, v.value] as const),
  );
  merged.set("AUTH0_DOMAIN", `https://${config.domain}/`);
  merged.set("AUTH0_CLIENT_ID", app.client_id);
  merged.set("AUTH0_CLIENT_SECRET", app.client_secret);
  // Placeholder audience derived from the project slug; a real per-project API
  // audience is Sprint 8.5+ (see SPRINT_8_SPEC deferrals).
  merged.set("AUTH0_AUDIENCE", `https://api.${projectSlug}.com`);
  const mergedVars: RenderEnvVar[] = [...merged].map(([key, value]) => ({
    key,
    value,
  }));

  const put = await putServiceEnvVars(
    renderCredential,
    renderServiceId,
    mergedVars,
  );
  if (!put.success) {
    await logSystem(
      "warn",
      "genesis",
      `Render env sync failed after Auth0 app created for project ${projectId}: ${
        put.errorMessage ?? "unknown"
      }`,
      { projectId, applicationId: app.client_id, renderServiceId },
    );
    return {
      success: false,
      reason: "render_env_sync_failed",
      message: `Auth0 app created (client_id: ${app.client_id}) but Render env var sync failed: ${
        put.errorMessage ?? "unknown error"
      }. Retrieve the client_secret from the Auth0 dashboard and add the AUTH0_* vars to the Render service manually.`,
      application_id: app.client_id,
    };
  }

  // 5) Success.
  await logSystem(
    "info",
    "genesis",
    `Auth0 wired for project ${projectId}: application ${app.client_id}`,
    {
      projectId,
      projectName,
      applicationId: app.client_id,
      applicationName: app.name,
      renderServiceId,
    },
  );

  return {
    success: true,
    application_id: app.client_id,
    application_name: app.name,
    callback_urls: callbackUrls,
  };
}
