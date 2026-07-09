import { and, eq } from "drizzle-orm";

import { getDb } from "../../db/client.js";
import { integrations, projects } from "../../db/schema.js";
import { env } from "../env.js";
import {
  StripeError,
  stripeConnectClient,
} from "../integrations/stripeClient.js";
import type { StripeConfig } from "../integrations/types.js";
import { logSystem } from "../logging.js";
import {
  getServiceEnvVars,
  putServiceEnvVars,
  type RenderEnvVar,
} from "../platforms/index.js";

// Genesis runs detached from any HTTP request, so there is no Origin header to
// build the onboarding refresh/return URLs from. Point them at the production
// web app; the user finishes onboarding from the project detail page.
const DEFAULT_WEB_APP_URL = "https://aiconnect.macrotechtitan.com";

/**
 * Outcome of best-effort Stripe Connect wiring during Project Genesis. Surfaced
 * to the UI via the wire_stripe step's event details — never thrown.
 */
export type StripeWiringResult =
  | {
      success: true;
      account_id: string;
      onboarding_url: string;
      onboarding_expires_at: number;
      env_vars_synced: string[];
    }
  | {
      success: false;
      reason:
        | "no_integration"
        | "integration_not_validated"
        | "stripe_account_creation_failed"
        | "onboarding_link_creation_failed"
        | "render_env_sync_failed"
        | "db_update_failed";
      message: string;
      // Present once the Connected Account exists but a later step failed, so the
      // user can finish wiring by hand from the Stripe integration management UI.
      partial?: {
        account_id?: string;
        onboarding_url?: string;
      };
    };

/**
 * Auto-wires Stripe Connect for a freshly provisioned project.
 *
 * Looks for the project creator's active Stripe integration (validated +
 * include_in_projects). If found, creates a NEW Express Connected Account for
 * this project (each project gets its own account for payment isolation),
 * persists the account id, generates an onboarding link, and merges
 * STRIPE_ACCOUNT_ID / STRIPE_PUBLISHABLE_KEY into the Render service's env vars.
 *
 * BEST-EFFORT: never throws. Every failure path returns a typed result. The
 * caller (the wire_stripe genesis step) always reports "succeeded" so
 * provisioning is never rolled back over Stripe wiring.
 *
 * Note: STRIPE_SECRET_KEY is intentionally NOT synced — AI Connect's platform
 * key must never be handed to a user project. Server-side Stripe ops from the
 * project use the publishable key + Stripe-Account header (Direct Charges).
 * Per-project Restricted Keys are Sprint 10+.
 *
 * Caveat: like the Auth0 wiring, a post-create change to Render env vars does
 * not trigger a redeploy, so STRIPE_* take effect on the project's NEXT deploy.
 */
export async function wireStripeForProject(params: {
  userId: string;
  projectId: string;
  projectName: string;
  projectSlug: string;
  renderServiceId: string | undefined;
  renderCredential: string;
  userEmail: string;
}): Promise<StripeWiringResult> {
  const {
    userId,
    projectId,
    projectName,
    projectSlug,
    renderServiceId,
    renderCredential,
    userEmail,
  } = params;

  const db = getDb();

  // 1) Find the creator's active Stripe integration (validated + opted into
  //    projects). The common "user has no Stripe integration" case lands here.
  const [row] = await db
    .select({
      id: integrations.id,
      status: integrations.status,
      config: integrations.config,
    })
    .from(integrations)
    .where(
      and(
        eq(integrations.userId, userId),
        eq(integrations.integrationType, "stripe"),
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
        'No active Stripe integration found. Add one in Settings → Integrations (with "Include in new projects" enabled) to auto-wire Stripe.',
    };
  }

  const parentConfig = row.config as StripeConfig;

  // 2) Create a new Express Connected Account for THIS project (each project
  //    gets its own account for payment isolation).
  let newAccount;
  try {
    newAccount = await stripeConnectClient.createExpressAccount({
      email: userEmail,
      country: parentConfig.country ?? "US",
      businessType: parentConfig.business_type ?? "individual",
      projectId,
      userId,
    });
  } catch (err) {
    const errMsg =
      err instanceof StripeError
        ? `${err.code}: ${err.message}`
        : err instanceof Error
          ? err.message
          : "unknown error";
    await logSystem(
      "warn",
      "genesis",
      `Stripe account creation failed for project ${projectId}: ${errMsg}`,
      { projectId, projectName },
    );
    return {
      success: false,
      reason: "stripe_account_creation_failed",
      message: `Could not create Stripe Connected Account: ${errMsg}`,
    };
  }

  // 3) Persist stripe_account_id + initial status to the projects row.
  try {
    await db
      .update(projects)
      .set({
        stripeAccountId: newAccount.id,
        stripeAccountStatus: "pending",
        updatedAt: new Date(),
      })
      .where(eq(projects.id, projectId));
  } catch (err) {
    await logSystem(
      "error",
      "genesis",
      `Stripe account created (${newAccount.id}) but persisting it to project ${projectId} failed`,
      { projectId, accountId: newAccount.id },
    );
    return {
      success: false,
      reason: "db_update_failed",
      message: `Stripe account created (${newAccount.id}) but failed to persist to project: ${
        err instanceof Error ? err.message : "unknown error"
      }. Manual reconciliation may be needed.`,
      partial: { account_id: newAccount.id },
    };
  }

  // 4) Generate the onboarding link.
  const origin = DEFAULT_WEB_APP_URL;
  let onboardingLink;
  try {
    onboardingLink = await stripeConnectClient.createAccountLink({
      accountId: newAccount.id,
      refreshUrl: `${origin}/projects/${projectSlug}?stripe_onboarding=refresh`,
      returnUrl: `${origin}/projects/${projectSlug}?stripe_onboarding=complete`,
    });
  } catch (err) {
    const errMsg =
      err instanceof StripeError
        ? `${err.code}: ${err.message}`
        : err instanceof Error
          ? err.message
          : "unknown error";
    await logSystem(
      "warn",
      "genesis",
      `Stripe onboarding link failed for project ${projectId} (account ${newAccount.id}): ${errMsg}`,
      { projectId, accountId: newAccount.id },
    );
    return {
      success: false,
      reason: "onboarding_link_creation_failed",
      message: `Stripe account created (${newAccount.id}) but onboarding link generation failed: ${errMsg}. User can retry from Stripe integration management.`,
      partial: { account_id: newAccount.id },
    };
  }

  // 5) Merge STRIPE_* into the Render service env vars. Render's PUT replaces
  //    the whole set, so read current → merge → put (don't drop DATABASE_URL
  //    etc.). Same pattern as the Auth0 wiring.
  const syncedKeys = ["STRIPE_ACCOUNT_ID", "STRIPE_PUBLISHABLE_KEY"];
  if (!renderServiceId) {
    await logSystem(
      "warn",
      "genesis",
      `Stripe Render env sync skipped — no service id for project ${projectId}`,
      { projectId, accountId: newAccount.id },
    );
    return {
      success: false,
      reason: "render_env_sync_failed",
      message: `Stripe account created (${newAccount.id}) but no Render service id was available to sync env vars.`,
      partial: { account_id: newAccount.id, onboarding_url: onboardingLink.url },
    };
  }

  const current = await getServiceEnvVars(renderCredential, renderServiceId);
  if (!current.success) {
    await logSystem(
      "warn",
      "genesis",
      `Render env read failed during Stripe sync for project ${projectId}: ${
        current.errorMessage ?? "unknown"
      }`,
      { projectId, accountId: newAccount.id },
    );
    return {
      success: false,
      reason: "render_env_sync_failed",
      message: `Stripe account created (${newAccount.id}) but reading the Render env vars failed: ${
        current.errorMessage ?? "unknown error"
      }.`,
      partial: { account_id: newAccount.id, onboarding_url: onboardingLink.url },
    };
  }

  const merged = new Map<string, string>(
    (current.envVars ?? []).map((v) => [v.key, v.value] as const),
  );
  merged.set("STRIPE_ACCOUNT_ID", newAccount.id);
  // Platform publishable key — public per Stripe conventions; the project's
  // frontend uses it (with the Stripe-Account header) to act on this account.
  merged.set("STRIPE_PUBLISHABLE_KEY", env.STRIPE_PUBLISHABLE_KEY ?? "");
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
      `Render env sync failed after Stripe account created for project ${projectId}: ${
        put.errorMessage ?? "unknown"
      }`,
      { projectId, accountId: newAccount.id, renderServiceId },
    );
    return {
      success: false,
      reason: "render_env_sync_failed",
      message: `Stripe account created (${newAccount.id}) but Render env var sync failed: ${
        put.errorMessage ?? "unknown error"
      }. Onboarding URL still available; add STRIPE_* vars to Render manually.`,
      partial: { account_id: newAccount.id, onboarding_url: onboardingLink.url },
    };
  }

  // 6) Success.
  await logSystem(
    "info",
    "genesis",
    `Stripe wired for project ${projectId}: account ${newAccount.id}`,
    {
      projectId,
      projectName,
      accountId: newAccount.id,
      renderServiceId,
    },
  );

  return {
    success: true,
    account_id: newAccount.id,
    onboarding_url: onboardingLink.url,
    onboarding_expires_at: onboardingLink.expires_at,
    env_vars_synced: syncedKeys,
  };
}
