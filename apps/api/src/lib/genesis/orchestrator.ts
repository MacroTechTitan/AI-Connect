import { eq } from "drizzle-orm";

import { getDb } from "../../db/client.js";
import {
  platformCredentials,
  projectProvisioningEvents,
  projects,
} from "../../db/schema.js";
import { logSystem } from "../logging.js";
import {
  getPlatformClient,
  type Platform,
  type ValidatedIdentity,
} from "../platforms/index.js";
import * as vault from "../vault.js";
import { GENESIS_STEPS } from "./steps.js";
import type { GenesisContext } from "./types.js";

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
  state: "provisioned" | "failed",
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

// --- context assembly ------------------------------------------------------

interface ProjectRow {
  id: string;
  name: string;
  slug: string;
  organizationId: string;
  createdByUserId: string;
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
    // Sprint 4 MVP creates an auto-init'd empty repo; template-based scaffolding
    // (cloning a starter) arrives in a later sprint. The field exists now so
    // step signatures stay stable when it does.
    templateRepoUrl: "",
    credentials,
    validated,
    results: {},
  };
}

// --- the run ----------------------------------------------------------------

// Walks the seven steps in order. On the first failure: marks the project
// failed and STOPS (sub-commit 5b replaces this stop with reverse-delete
// rollback). On all seven succeeding: marks the project provisioned.
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
    await setProjectState(db, ctx.projectId, "failed");
    await logSystem(
      "warn",
      "genesis",
      `Genesis stopped: step ${step.name} failed for project ${ctx.projectId}`,
      { projectId: ctx.projectId, step: step.name },
    );
    return; // STOP — rollback deferred to sub-commit 5b.
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
