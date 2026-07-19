import { eq } from "drizzle-orm";

import { getDb } from "../../db/client.js";
import {
  platformCredentials,
  projectProvisioningEvents,
  projects,
  users,
} from "../../db/schema.js";
import { githubClient } from "../integrations/githubClient.js";
import { logSystem } from "../logging.js";
import {
  getCloudflareClient,
  getPlatformClient,
  type Platform,
  type ValidatedIdentity,
} from "../platforms/index.js";
import * as vault from "../vault.js";
import { GENESIS_STEPS } from "./steps.js";
import type {
  GenesisContext,
  GenesisStepName,
  GenesisStepResult,
  TemplateChoice,
} from "./types.js";

const TEMPLATE_CHOICES: readonly TemplateChoice[] = [
  "html-js",
  "sveltekit",
  "nextjs",
];

function asTemplateChoice(value: string): TemplateChoice | undefined {
  return (TEMPLATE_CHOICES as readonly string[]).includes(value)
    ? (value as TemplateChoice)
    : undefined;
}

type Db = ReturnType<typeof getDb>;

const REQUIRED_PLATFORMS: Platform[] = [
  "vercel",
  "render",
  "github",
  "supabase",
];

// Pre-flight credential validation is recorded under this synthetic step name.
// It is not one of the seven GenesisStepNames — the events table's step_name is
// free text — but it gives operators a row to look at when a run dies before
// step 1 because a token was revoked between add-time and genesis-time.
const VALIDATE_STEP = "validate_credentials";

// --- event row lifecycle ---------------------------------------------------
// Each step gets one row, mutated in place: pending → in_progress → terminal.
// Writes are standalone (never batched in a transaction) so a SSE consumer
// (sub-commit 5c) sees partial progress even when a later step fails.

async function insertPendingEvent(
  db: Db,
  projectId: string,
  stepName: string,
): Promise<string> {
  const [row] = await db
    .insert(projectProvisioningEvents)
    .values({ projectId, stepName, status: "pending" })
    .returning({ id: projectProvisioningEvents.id });
  if (!row) {
    throw new Error(
      `failed to insert pending event for step ${stepName} (project ${projectId})`,
    );
  }
  return row.id;
}

async function markInProgress(db: Db, eventId: string): Promise<void> {
  await db
    .update(projectProvisioningEvents)
    .set({ status: "in_progress", startedAt: new Date() })
    .where(eq(projectProvisioningEvents.id, eventId));
}

async function markSucceeded(
  db: Db,
  eventId: string,
  details: Record<string, unknown> | undefined,
  resourceId: string | undefined,
): Promise<void> {
  await db
    .update(projectProvisioningEvents)
    .set({
      status: "succeeded",
      completedAt: new Date(),
      // The events table has no resourceId column — fold it into the jsonb.
      details: { ...(details ?? {}), ...(resourceId ? { resourceId } : {}) },
    })
    .where(eq(projectProvisioningEvents.id, eventId));
}

async function markFailed(
  db: Db,
  eventId: string,
  errorMessage: string,
  details?: Record<string, unknown>,
): Promise<void> {
  await db
    .update(projectProvisioningEvents)
    .set({
      status: "failed",
      completedAt: new Date(),
      errorMessage,
      details: details ?? null,
    })
    .where(eq(projectProvisioningEvents.id, eventId));
}

async function setProjectState(
  db: Db,
  projectId: string,
  state: "provisioned" | "failed" | "rolled_back",
): Promise<void> {
  await db
    .update(projects)
    .set({ provisioningState: state, updatedAt: new Date() })
    .where(eq(projects.id, projectId));
}

// Convenience: open a fresh pending→failed row in one shot for failures that
// happen outside the main step loop (pre-flight, unexpected crash).
async function recordFailureEvent(
  db: Db,
  projectId: string,
  stepName: string,
  errorMessage: string,
  details?: Record<string, unknown>,
): Promise<void> {
  const eventId = await insertPendingEvent(db, projectId, stepName);
  await markInProgress(db, eventId);
  await markFailed(db, eventId, errorMessage, details);
}

// Rollback events reuse the pending → in_progress lifecycle, then land on one
// of two terminal states distinct from forward steps' succeeded/failed:
//   - succeeded            → the resource was deleted cleanly
//   - failed_to_rollback   → the delete itself failed; the resource still
//                            exists and needs manual cleanup (link in details)
async function markRollbackSucceeded(
  db: Db,
  eventId: string,
  details: Record<string, unknown>,
): Promise<void> {
  await db
    .update(projectProvisioningEvents)
    .set({ status: "succeeded", completedAt: new Date(), details })
    .where(eq(projectProvisioningEvents.id, eventId));
}

async function markFailedToRollback(
  db: Db,
  eventId: string,
  errorMessage: string,
  details: Record<string, unknown>,
): Promise<void> {
  await db
    .update(projectProvisioningEvents)
    .set({
      status: "failed_to_rollback",
      completedAt: new Date(),
      errorMessage,
      details,
    })
    .where(eq(projectProvisioningEvents.id, eventId));
}

// Best-effort deep link to the platform's resource page so a human can finish a
// cleanup the API couldn't. Stored in the rollback event's details for the SSE
// consumer (5c) / future "stuck genesis" UI to surface as a clickable link.
function manualCleanupUrl(
  platform: Platform | "cloudflare",
  result: GenesisStepResult,
): string | undefined {
  const resourceId = result.resourceId;
  const details = result.details ?? {};
  switch (platform) {
    case "github": {
      // resourceId is the repo full_name (owner/repo).
      const fullName =
        typeof details.full_name === "string" ? details.full_name : resourceId;
      return fullName ? `https://github.com/${fullName}/settings` : undefined;
    }
    case "render":
      return resourceId
        ? `https://dashboard.render.com/services/${resourceId}`
        : undefined;
    case "supabase":
      return resourceId
        ? `https://supabase.com/dashboard/project/${resourceId}`
        : undefined;
    case "vercel": {
      // We can only build the per-project settings URL when the create step
      // resolved a real project dashboard URL (it needs the account username).
      // Otherwise fall back to the generic dashboard.
      const dash =
        typeof details.dashboard_url === "string" ? details.dashboard_url : "";
      if (dash && dash !== "https://vercel.com/dashboard") {
        return `${dash}/settings`;
      }
      return "https://vercel.com/dashboard";
    }
    case "cloudflare":
      // No per-record deep link without the account/zone slug — point at the
      // DNS dashboard; the event details carry the record id + subdomain.
      return "https://dash.cloudflare.com/";
  }
}

// Sprint 10: deletes a repo that create_github_repo made via the user's GitHub
// App installation (resourceId is the "owner/repo" full_name; installation_id
// lives in the step details). Returns the same {deleted, errorMessage} shape as
// the platform clients' deleteResource so the rollback loop treats it uniformly.
async function deleteGithubRepoViaInstallation(
  result: GenesisStepResult,
): Promise<{ deleted: boolean; errorMessage?: string }> {
  const fullName = result.resourceId;
  const installationId =
    typeof result.details?.installation_id === "number"
      ? result.details.installation_id
      : undefined;
  if (!fullName || installationId === undefined) {
    return {
      deleted: false,
      errorMessage:
        "Missing repo full_name or installation_id for user-installation rollback.",
    };
  }
  const [owner, repo] = fullName.split("/");
  if (!owner || !repo) {
    return {
      deleted: false,
      errorMessage: `Unparseable repo full_name: ${fullName}`,
    };
  }
  try {
    await githubClient.deleteRepo(installationId, owner, repo);
    return { deleted: true };
  } catch (err) {
    return {
      deleted: false,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

// Reverse-order, best-effort teardown of everything the run created before the
// failed step. Walks GENESIS_STEPS backwards from just before the failed step,
// deleting each rollbackable success via its platform client. Most-recent-first
// matters: downstream resources (Render service) reference upstream ones (the
// GitHub repo), so deleting upstream first would orphan them.
//
// Each delete writes its own event row (step_name="rollback:<original>"); the
// original step's succeeded row is left untouched. Deletion failures are soft —
// recorded as failed_to_rollback and counted, never thrown.
async function rollback(
  db: Db,
  ctx: GenesisContext,
  failedStepName: GenesisStepName,
): Promise<{ rolledBackCount: number; failedToRollbackCount: number }> {
  let rolledBackCount = 0;
  let failedToRollbackCount = 0;

  const failedIdx = GENESIS_STEPS.findIndex((s) => s.name === failedStepName);

  for (let i = failedIdx - 1; i >= 0; i--) {
    const step = GENESIS_STEPS[i]!;
    const result = ctx.results[step.name];

    // Only undo steps that actually created a concrete, deletable resource.
    if (
      !result ||
      result.status !== "succeeded" ||
      !result.rollbackable ||
      !result.platform ||
      !result.resourceId
    ) {
      continue;
    }

    const platform = result.platform;
    const resourceId = result.resourceId;

    const eventId = await insertPendingEvent(
      db,
      ctx.projectId,
      `rollback:${step.name}`,
    );
    await markInProgress(db, eventId);

    let deleteResult: { deleted: boolean; errorMessage?: string };
    try {
      if (platform === "cloudflare") {
        // Env-level Cloudflare client (not a PlatformClient, no per-user creds).
        deleteResult = await getCloudflareClient().deleteSubdomainCname(
          resourceId,
        );
      } else if (
        platform === "github" &&
        result.details?.created_via === "user_installation"
      ) {
        // Sprint 10: this repo was created via the user's GitHub App
        // installation, so it lives in their org where the platform PAT has no
        // access. Delete it via the installation token instead.
        deleteResult = await deleteGithubRepoViaInstallation(result);
      } else {
        deleteResult = await getPlatformClient(platform).deleteResource(
          ctx.credentials[platform],
          resourceId,
        );
      }
    } catch (err) {
      deleteResult = {
        deleted: false,
        errorMessage: `Unexpected error rolling back ${platform} resource: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }

    if (deleteResult.deleted) {
      await markRollbackSucceeded(db, eventId, {
        resourceId,
        deletedResource: platform,
      });
      rolledBackCount++;
    } else {
      const cleanupUrl = manualCleanupUrl(platform, result);
      await markFailedToRollback(
        db,
        eventId,
        deleteResult.errorMessage ??
          `${platform} refused to delete resource ${resourceId}.`,
        {
          resourceId,
          platform,
          ...(cleanupUrl ? { manual_cleanup_url: cleanupUrl } : {}),
        },
      );
      failedToRollbackCount++;
    }
  }

  return { rolledBackCount, failedToRollbackCount };
}

// --- context assembly ------------------------------------------------------

interface ProjectRow {
  id: string;
  name: string;
  slug: string;
  organizationId: string;
  createdByUserId: string;
  templateChoice: string;
}

// Builds the GenesisContext or, for an expected terminal condition (missing or
// revoked credentials), records the failure + marks the project failed and
// returns null. Truly unexpected failures (DB/vault errors) throw and bubble to
// runGenesis's outer catch.
async function buildContext(
  db: Db,
  project: ProjectRow,
): Promise<GenesisContext | null> {
  // Credentials belong to the project creator. The route validated that the
  // user who started genesis has all four, but the orchestrator only has the
  // projectId, so it loads the creator's set as the authoritative source.
  const credRows = await db
    .select({
      platform: platformCredentials.platform,
      vaultSecretId: platformCredentials.vaultSecretId,
    })
    .from(platformCredentials)
    .where(eq(platformCredentials.userId, project.createdByUserId));

  // The creator's email, needed by the best-effort wire_stripe step (Stripe
  // Express account creation requires it). createdByUserId FK is ON DELETE
  // restrict, so the user row exists; default to "" defensively.
  const [creator] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, project.createdByUserId))
    .limit(1);
  const userEmail = creator?.email ?? "";

  const secretIdByPlatform = new Map<string, string>();
  for (const row of credRows) {
    // Keep the first credential seen per platform (rows are unordered; Sprint 4
    // assumes one credential per platform per user).
    if (!secretIdByPlatform.has(row.platform)) {
      secretIdByPlatform.set(row.platform, row.vaultSecretId);
    }
  }

  const missing = REQUIRED_PLATFORMS.filter((p) => !secretIdByPlatform.has(p));
  if (missing.length > 0) {
    await recordFailureEvent(
      db,
      project.id,
      VALIDATE_STEP,
      `Missing platform credentials: ${missing.join(", ")}.`,
      { missing },
    );
    await setProjectState(db, project.id, "failed");
    return null;
  }

  // Decrypt all four. A vault failure here is unexpected infra trouble — let it
  // throw to the outer catch rather than masking it as a clean credential fail.
  const credentials = {
    vercel: await vault.getSecret(secretIdByPlatform.get("vercel")!),
    render: await vault.getSecret(secretIdByPlatform.get("render")!),
    github: await vault.getSecret(secretIdByPlatform.get("github")!),
    supabase: await vault.getSecret(secretIdByPlatform.get("supabase")!),
  };

  // Second-line validation: tokens may have been revoked since they were added.
  // Capture each identity (Render ownerId / Supabase organizationId) for the
  // create steps. Any invalid token stops the run before a single resource is
  // created.
  const validated = {} as Record<Platform, ValidatedIdentity>;
  const invalid: string[] = [];
  for (const platform of REQUIRED_PLATFORMS) {
    const result = await getPlatformClient(platform).validate(
      credentials[platform],
    );
    if (!result.valid) {
      invalid.push(platform);
    } else {
      validated[platform] = result.identity ?? {};
    }
  }

  if (invalid.length > 0) {
    await recordFailureEvent(
      db,
      project.id,
      VALIDATE_STEP,
      `Credential validation failed for: ${invalid.join(", ")}. Re-add the credential(s) in settings — the token may have been revoked.`,
      { invalid },
    );
    await setProjectState(db, project.id, "failed");
    return null;
  }

  return {
    projectId: project.id,
    userId: project.createdByUserId,
    organizationId: project.organizationId,
    name: project.name,
    slug: project.slug,
    userEmail,
    // Legacy field retained from Sprint 4; superseded by templateChoice below.
    templateRepoUrl: "",
    // Sprint 5: the GitHub step generates from this template (or falls back to
    // an empty auto_init repo when unset/invalid).
    templateChoice: asTemplateChoice(project.templateChoice),
    credentials,
    validated,
    results: {},
  };
}

// --- the run ----------------------------------------------------------------

// Walks the seven steps in order. On the first failure: rolls back everything
// created so far (reverse-delete, best-effort) and lands the project in a
// terminal state — 'rolled_back' if cleanup was clean, 'failed' if any resource
// resisted deletion and needs manual cleanup. On all seven succeeding: marks
// the project provisioned.
async function runSteps(db: Db, ctx: GenesisContext): Promise<void> {
  for (const step of GENESIS_STEPS) {
    const eventId = await insertPendingEvent(db, ctx.projectId, step.name);
    await markInProgress(db, eventId);

    let result;
    try {
      result = await step.run(ctx);
    } catch (err) {
      result = {
        status: "failed" as const,
        errorMessage: `Unexpected error in step ${step.name}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }

    ctx.results[step.name] = result;

    if (result.status === "succeeded") {
      await markSucceeded(db, eventId, result.details, result.resourceId);
      continue;
    }

    await markFailed(
      db,
      eventId,
      result.errorMessage ?? "Step failed without an error message.",
      result.details,
    );
    await logSystem(
      "warn",
      "genesis",
      `Genesis step ${step.name} failed for project ${ctx.projectId}; rolling back`,
      { projectId: ctx.projectId, step: step.name },
    );

    const { rolledBackCount, failedToRollbackCount } = await rollback(
      db,
      ctx,
      step.name,
    );
    const clean = failedToRollbackCount === 0;

    // Clean rollback → 'rolled_back' (terminal, no action needed). Partial →
    // 'failed' so the user sees they still have manual cleanup to do.
    await setProjectState(db, ctx.projectId, clean ? "rolled_back" : "failed");

    const message = clean
      ? `Rolled back ${rolledBackCount} resource(s) cleanly after step ${step.name} failed.`
      : `Rolled back ${rolledBackCount} resource(s) after step ${step.name} failed; ${failedToRollbackCount} require manual cleanup.`;

    const summaryEventId = await insertPendingEvent(
      db,
      ctx.projectId,
      "rollback_summary",
    );
    await markInProgress(db, summaryEventId);
    if (clean) {
      await markRollbackSucceeded(db, summaryEventId, {
        rolledBackCount,
        failedToRollbackCount,
        message,
      });
    } else {
      await markFailedToRollback(db, summaryEventId, message, {
        rolledBackCount,
        failedToRollbackCount,
        message,
      });
    }

    await logSystem(
      clean ? "warn" : "error",
      "genesis",
      message,
      {
        projectId: ctx.projectId,
        step: step.name,
        rolledBackCount,
        failedToRollbackCount,
      },
    );
    return; // STOP — terminal state reached.
  }

  await setProjectState(db, ctx.projectId, "provisioned");
  await logSystem(
    "info",
    "genesis",
    `Genesis succeeded: project ${ctx.projectId} is provisioned`,
    { projectId: ctx.projectId },
  );
}

// Entry point. Called by the route handler inside a detached promise — it never
// awaits this, so all reporting happens via event rows and logs, not the return
// value. On an unexpected failure it best-effort marks the project failed, then
// re-throws so the parent's .catch logs it.
export async function runGenesis(projectId: string): Promise<void> {
  const db = getDb();
  try {
    const [project] = await db
      .select({
        id: projects.id,
        name: projects.name,
        slug: projects.slug,
        organizationId: projects.organizationId,
        createdByUserId: projects.createdByUserId,
        templateChoice: projects.templateChoice,
      })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    if (!project) {
      // The route set state=provisioning on a row it just read, so a missing
      // row here means it was deleted mid-flight — unexpected. Nothing to mark.
      throw new Error(`runGenesis: project ${projectId} not found`);
    }

    const ctx = await buildContext(db, project);
    if (!ctx) {
      // buildContext already recorded the failure + marked the project failed.
      return;
    }

    await runSteps(db, ctx);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    // Best-effort: surface the crash as a failure event + failed project so the
    // run doesn't silently vanish. Both are wrapped because the DB itself may be
    // the thing that failed.
    await recordFailureEvent(
      db,
      projectId,
      "orchestrator",
      `Genesis crashed unexpectedly: ${errorMessage}`,
    ).catch(() => {});
    await setProjectState(db, projectId, "failed").catch(() => {});
    await logSystem(
      "error",
      "genesis",
      `Genesis crashed for project ${projectId}`,
      { projectId, error: errorMessage },
    );
    throw err;
  }
}
