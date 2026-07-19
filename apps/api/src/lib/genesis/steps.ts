import { randomBytes } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { getDb } from "../../db/client.js";
import { githubInstallations, integrations, projects } from "../../db/schema.js";
import { githubClient } from "../integrations/githubClient.js";
import type { GithubConfig } from "../integrations/types.js";
import { logSystem } from "../logging.js";
import {
  createRepoFromTemplate,
  getPlatformClient,
  getServiceEnvVars,
  renderGetLatestDeploy,
  supabaseBuildConnectionString,
  supabaseWaitUntilReady,
  type PlatformActionResult,
  type RenderEnvVar,
} from "../platforms/index.js";
import * as vault from "../vault.js";
import { wireAuth0ForProject } from "./auth0Wiring.js";
import { wireStripeForProject } from "./stripeWiring.js";
import {
  TEMPLATE_REPOS,
  type GenesisContext,
  type GenesisStep,
  type GenesisStepResult,
} from "./types.js";

// --- helpers ---------------------------------------------------------------

// Random alphanumeric secret for the Supabase project's Postgres role. 24 chars
// comfortably clears the 16-char floor. randomBytes (not Math.random) so it's
// cryptographically sound. The value lives only in the createResource call and
// is never logged or returned to the caller.
const DB_PASS_CHARSET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
function generateDbPassword(): string {
  const bytes = randomBytes(24);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += DB_PASS_CHARSET[bytes[i]! % DB_PASS_CHARSET.length];
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Pull a string field out of an earlier step's stored details. Returns
// undefined if the step never ran or the field is missing/non-string.
function detailString(
  ctx: GenesisContext,
  step: keyof GenesisContext["results"],
  key: string,
): string | undefined {
  const value = ctx.results[step]?.details?.[key];
  return typeof value === "string" ? value : undefined;
}

// --- step a: create the GitHub repo ----------------------------------------

// On a 422 name_taken (isRetryable), GitHub already has a repo by that name on
// the account. Retry with -2, -3, -4 suffixes before giving up. Any other error
// is terminal — the orchestrator stops the run.
const GITHUB_NAME_RETRIES = 3;

// Sprint 10: resolves the project creator's validated GitHub App integration
// (with include_in_projects=true), if any. Returns the installation to create
// the repo under, or null when the user has no usable installation (no
// integration, uninstalled, or suspended) — in which case create_github_repo
// falls back to the platform-PAT flow.
async function findUserGithubInstallation(userId: string): Promise<{
  installationId: number;
  accountLogin: string;
  accountType: "User" | "Organization";
} | null> {
  const db = getDb();

  const integration = await db
    .select({ config: integrations.config })
    .from(integrations)
    .where(
      and(
        eq(integrations.userId, userId),
        eq(integrations.integrationType, "github"),
        eq(integrations.status, "validated"),
        eq(integrations.includeInProjects, true),
      ),
    )
    .limit(1)
    .then((rows) => rows[0]);

  if (!integration) return null;

  const config = integration.config as GithubConfig;

  // The installation could have been uninstalled/suspended since validation.
  const installation = await db
    .select({ suspendedAt: githubInstallations.suspendedAt })
    .from(githubInstallations)
    .where(eq(githubInstallations.installationId, config.installation_id))
    .limit(1)
    .then((rows) => rows[0]);

  if (!installation) return null;
  if (installation.suspendedAt) return null;

  return {
    installationId: config.installation_id,
    accountLogin: config.account_login,
    accountType: config.account_type,
  };
}

// Best-effort: record which GitHub org the repo landed in. Display/tracking
// only, so a failed write never fails provisioning.
async function persistRepoOwnerOrg(
  projectId: string,
  repoOwnerOrg: string,
): Promise<void> {
  await getDb()
    .update(projects)
    .set({ repoOwnerOrg, updatedAt: new Date() })
    .where(eq(projects.id, projectId))
    .catch(() => {});
}

// Runs the platform-PAT flow and records the resulting repo's owner org.
// The shared fallback for every "not Path A" case.
async function createGithubRepoViaPlatformAndRecordOwner(
  ctx: GenesisContext,
): Promise<GenesisStepResult> {
  const result = await createGithubRepoViaPlatform(ctx);
  if (result.status === "succeeded" && result.resourceId) {
    const owner = result.resourceId.split("/")[0];
    if (owner) await persistRepoOwnerOrg(ctx.projectId, owner);
  }
  return result;
}

// Sprint 10: prefer creating the repo in the user's own GitHub org via their
// AI Connect App installation (Path A). Falls back to the existing platform-PAT
// flow (createGithubRepoViaPlatform) when the user has no usable installation OR
// the App-based create fails. Zero change for users without a GitHub integration.
//
// GATE (Sprint 10.5): Path A only fires when the chosen template opts in via
// supportsGithubAppPath. All templates are false in v1 because the App path
// creates an empty auto_init repo (App-side template scaffolding is deferred),
// which would break Render's first deploy. Until scaffolding lands, this gate
// keeps the platform-PAT flow as the only reachable path.
export async function createGithubRepo(
  ctx: GenesisContext,
): Promise<GenesisStepResult> {
  const template = ctx.templateChoice
    ? TEMPLATE_REPOS[ctx.templateChoice]
    : undefined;

  // Legacy/unset templateChoice → undefined → treated as unsupported.
  if (!template?.supportsGithubAppPath) {
    const userInstallation = await findUserGithubInstallation(ctx.userId);
    await logSystem(
      "info",
      "genesis",
      `GitHub App path skipped (template unsupported) for project ${ctx.projectId}`,
      {
        projectId: ctx.projectId,
        templateChoice: ctx.templateChoice ?? null,
        // Tracks latent demand: users who'd benefit once scaffolding lands.
        userHasGithubIntegration: userInstallation !== null,
      },
    );
    return createGithubRepoViaPlatformAndRecordOwner(ctx);
  }

  const userInstallation = await findUserGithubInstallation(ctx.userId);

  if (userInstallation) {
    try {
      const repo = await githubClient.createRepo(
        userInstallation.installationId,
        userInstallation.accountType,
        userInstallation.accountLogin,
        {
          name: ctx.slug,
          description: ctx.name,
          private: true,
          auto_init: true,
        },
      );

      await persistRepoOwnerOrg(ctx.projectId, userInstallation.accountLogin);

      await logSystem(
        "info",
        "genesis",
        `GitHub repo created via user installation for project ${ctx.projectId}: ${repo.full_name}`,
        {
          projectId: ctx.projectId,
          installationId: userInstallation.installationId,
          accountLogin: userInstallation.accountLogin,
          repoFullName: repo.full_name,
        },
      );

      // Mirror the platform-flow detail keys so create_vercel_project /
      // create_render_service keep reading full_name + html_url unchanged.
      return {
        status: "succeeded",
        resourceId: repo.full_name,
        platform: "github",
        rollbackable: true,
        details: {
          full_name: repo.full_name,
          html_url: repo.html_url,
          clone_url: `${repo.html_url}.git`,
          name: repo.name,
          repo_id: repo.id,
          default_branch: repo.default_branch,
          // App path doesn't scaffold from a template (deferred).
          template: null,
          // Sprint 10 rollback fork reads these to delete via the installation.
          created_via: "user_installation",
          installation_id: userInstallation.installationId,
          repo_owner_org: userInstallation.accountLogin,
        },
      };
    } catch (err) {
      // App-based create failed — log and fall through to the platform flow.
      await logSystem(
        "warn",
        "genesis",
        `User-installation repo creation failed for project ${ctx.projectId}; falling back to platform flow`,
        {
          projectId: ctx.projectId,
          installationId: userInstallation.installationId,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }

  // Path A opted in but no usable installation, or App create failed — fall
  // back to the existing platform-PAT flow (unchanged).
  return createGithubRepoViaPlatformAndRecordOwner(ctx);
}

// The original Sprint 4/5 GitHub repo creation, unchanged — now the fallback
// path when the user has no usable GitHub App installation. Uses the project
// creator's platform-credential GitHub PAT (ctx.credentials.github).
async function createGithubRepoViaPlatform(
  ctx: GenesisContext,
): Promise<GenesisStepResult> {
  const github = getPlatformClient("github");
  // Branch on template: a chosen template generates from the matching
  // AI-Connect template repo; otherwise fall back to Sprint 4's empty auto_init
  // repo (legacy / unset projects). Both paths return the same shape.
  const template = ctx.templateChoice
    ? TEMPLATE_REPOS[ctx.templateChoice]
    : undefined;

  const candidates = [ctx.slug];
  for (let i = 2; i <= GITHUB_NAME_RETRIES + 1; i++) {
    candidates.push(`${ctx.slug}-${i}`);
  }

  let lastError = `Could not create a GitHub repo for '${ctx.slug}'.`;
  for (const name of candidates) {
    const result: PlatformActionResult = template
      ? await createRepoFromTemplate(
          ctx.credentials.github,
          template.owner,
          template.repo,
          name,
          { description: ctx.name, private: true },
        )
      : await github.createResource({
          credential: ctx.credentials.github,
          name,
          description: ctx.name,
          private: true,
          autoInit: true,
        });

    if (result.status === "success") {
      // github's resourceId IS the full_name (owner/repo); html_url comes back
      // under urls.html. Stash both so the Vercel and Render steps can read them.
      return {
        status: "succeeded",
        resourceId: result.resourceId,
        platform: "github",
        rollbackable: true,
        details: {
          full_name: result.resourceId,
          html_url: result.urls.html ?? "",
          clone_url: result.urls.clone ?? "",
          name,
          repo_id: result.details.id,
          default_branch: result.details.default_branch,
          // Record which template scaffolded the repo (or that none did).
          template: template ? `${template.owner}/${template.repo}` : null,
        },
      };
    }

    lastError = result.errorMessage;
    // Only a retryable name collision earns another candidate; anything else
    // (auth, scopes, server error, template_not_found) is terminal.
    if (result.errorCode === "name_taken" && result.isRetryable) {
      continue;
    }
    return { status: "failed", errorMessage: result.errorMessage };
  }

  return {
    status: "failed",
    errorMessage: `Every candidate repo name was already taken (${candidates.join(", ")}). Last error: ${lastError}`,
  };
}

// --- step b: create the Supabase project -----------------------------------

const SUPABASE_READY_INTERVAL_MS = 5_000;
const SUPABASE_READY_TIMEOUT_MS = 120_000;

// Supabase accepts the project immediately but it stays COMING_UP for 30-90s.
// Sprint 5 now waits for ACTIVE_HEALTHY, builds the Postgres connection string
// from the dbPass the create call returned, encrypts it to Vault, and records
// the vault id on the project (inject_env_vars reads it back as DATABASE_URL).
//
// Self-cleanup note: the orchestrator's reverse-order rollback only undoes
// steps that SUCCEEDED before the failed one — it does not touch the failed
// step's own resource. So if creation succeeds but the wait or the Vault write
// fails, THIS step deletes the Supabase project it just made before returning
// failed. (A later-step failure rolls it back the normal way, via rollbackable.)
export async function createSupabaseProject(
  ctx: GenesisContext,
): Promise<GenesisStepResult> {
  const organizationId = ctx.validated.supabase.organizationId;
  if (!organizationId) {
    return {
      status: "failed",
      errorMessage:
        "Supabase credential validated but exposed no organization to create the project under.",
    };
  }

  const supabase = getPlatformClient("supabase");
  const result = await supabase.createResource({
    credential: ctx.credentials.supabase,
    name: ctx.slug,
    region: "us-east-2",
    organizationId,
    dbPass: generateDbPassword(),
  });

  if (result.status !== "success") {
    return { status: "failed", errorMessage: result.errorMessage };
  }

  const projectRef = result.resourceId;
  const dbPass =
    typeof result.details.dbPass === "string" ? result.details.dbPass : undefined;
  const region =
    typeof result.details.region === "string"
      ? result.details.region
      : "us-east-2";

  // Anything past this point that fails must delete the project we just made.
  const selfClean = async (errorMessage: string): Promise<GenesisStepResult> => {
    await supabase
      .deleteResource(ctx.credentials.supabase, projectRef)
      .catch(() => {});
    return { status: "failed", errorMessage };
  };

  if (!dbPass) {
    return selfClean(
      "Supabase create did not return a db password — cannot build the connection string.",
    );
  }

  const ready = await supabaseWaitUntilReady(
    ctx.credentials.supabase,
    projectRef,
    { intervalMs: SUPABASE_READY_INTERVAL_MS, timeoutMs: SUPABASE_READY_TIMEOUT_MS },
  );
  if (!ready.ready) {
    return selfClean(
      ready.errorMessage ??
        `Supabase project ${projectRef} did not reach ACTIVE_HEALTHY.`,
    );
  }

  // Build → encrypt → persist. Self-clean (project + any Vault secret) on error.
  let vaultSecretId: string | undefined;
  try {
    const connectionString = supabaseBuildConnectionString(
      projectRef,
      dbPass,
      region,
    );
    vaultSecretId = await vault.createSecret(
      `ai-connect:project:${ctx.projectId}:database-connection-string`,
      connectionString,
      `Supabase Postgres connection string for project ${ctx.projectId}`,
    );
    await getDb()
      .update(projects)
      .set({ databaseConnectionStringVaultId: vaultSecretId })
      .where(eq(projects.id, ctx.projectId));
    // Only commit to ctx once everything persisted.
    ctx.databaseConnectionString = connectionString;
    ctx.databaseConnectionStringVaultId = vaultSecretId;
  } catch (err) {
    if (vaultSecretId) {
      await vault.deleteSecret(vaultSecretId).catch(() => {});
    }
    return selfClean(
      `Supabase project is healthy but storing its connection string failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  return {
    status: "succeeded",
    resourceId: projectRef,
    platform: "supabase",
    rollbackable: true,
    details: {
      id: projectRef,
      dashboard_url: result.urls.dashboard ?? "",
      api_url: result.urls.api ?? "",
      status: "ACTIVE_HEALTHY",
      dbReady: true,
      // The Vault id (a reference), never the connection string itself.
      vaultSecretId,
    },
  };
}

// --- step c: create the Vercel project -------------------------------------

export async function createVercelProject(
  ctx: GenesisContext,
): Promise<GenesisStepResult> {
  const repo = detailString(ctx, "create_github_repo", "full_name");
  if (!repo) {
    return {
      status: "failed",
      errorMessage:
        "Vercel step ran without a GitHub repo in context — create_github_repo must succeed first.",
    };
  }

  const result = await getPlatformClient("vercel").createResource({
    credential: ctx.credentials.vercel,
    name: ctx.slug,
    gitRepository: { type: "github", repo },
  });

  if (result.status === "success") {
    return {
      status: "succeeded",
      resourceId: result.resourceId,
      platform: "vercel",
      rollbackable: true,
      details: {
        id: result.resourceId,
        dashboard_url: result.urls.dashboard ?? "",
        production_url: result.urls.production ?? "",
      },
    };
  }

  return { status: "failed", errorMessage: result.errorMessage };
}

// --- step d: create the Render service -------------------------------------

export async function createRenderService(
  ctx: GenesisContext,
): Promise<GenesisStepResult> {
  const ownerId = ctx.validated.render.ownerId;
  if (!ownerId) {
    return {
      status: "failed",
      errorMessage:
        "Render credential validated but exposed no owner to create the service under.",
    };
  }

  const repoUrl = detailString(ctx, "create_github_repo", "html_url");
  if (!repoUrl) {
    return {
      status: "failed",
      errorMessage:
        "Render step ran without a GitHub repo URL in context — create_github_repo must succeed first.",
    };
  }

  // Sprint 5.7: env vars are baked into the service at creation time (a
  // post-create PUT to /env-vars doesn't trigger a redeploy, so the first deploy
  // would run without them). create_supabase_project runs earlier in
  // GENESIS_STEPS and populates ctx.databaseConnectionString — require it here.
  const connectionString = ctx.databaseConnectionString;
  if (!connectionString) {
    return {
      status: "failed",
      errorMessage:
        "No database connection string in context — create_supabase_project must succeed before the Render service is created with env vars.",
    };
  }
  // DATABASE_URL carries the secret — never logged or recorded in event details.
  const envVars: RenderEnvVar[] = [
    { key: "DATABASE_URL", value: connectionString },
    { key: "NODE_ENV", value: "production" },
    { key: "PROJECT_NAME", value: ctx.name },
  ];

  // Per-template Render config (TEMPLATE_REPOS is the single source of truth).
  // Legacy projects with no templateChoice pass undefined, and createResource
  // falls back to Sprint 4's pnpm/node-dist defaults.
  const renderConfig = ctx.templateChoice
    ? TEMPLATE_REPOS[ctx.templateChoice].render
    : undefined;

  const result = await getPlatformClient("render").createResource({
    credential: ctx.credentials.render,
    name: ctx.slug,
    repo: repoUrl,
    branch: "main",
    ownerId,
    buildCommand: renderConfig?.buildCommand,
    startCommand: renderConfig?.startCommand,
    envVars,
  });

  if (result.status === "success") {
    const serviceUrl = result.urls.service ?? "";

    // Sprint 5.7: record the live URL on the project row immediately (the DNS
    // step is now a no-op, so there's nothing later to wait for). Best-effort —
    // a failed write here shouldn't fail provisioning, the URL is display-only.
    if (serviceUrl) {
      ctx.deployedUrl = serviceUrl;
      await getDb()
        .update(projects)
        .set({ deployedUrl: serviceUrl })
        .where(eq(projects.id, ctx.projectId))
        .catch(() => {});
    }

    return {
      status: "succeeded",
      resourceId: result.resourceId,
      platform: "render",
      rollbackable: true,
      details: {
        id: result.resourceId,
        // The deployed service URL — verify_deployment polls this.
        url: serviceUrl,
        dashboard_url: result.urls.dashboard ?? "",
      },
    };
  }

  return { status: "failed", errorMessage: result.errorMessage };
}

// --- step e: provision the Cloudflare subdomain CNAME -----------------------

// Sprint 5.7: no-op. Was real Cloudflare DNS in Sprint 5, but the constructed
// subdomain *.aiconnectprojects.macrotechtitan.com doesn't resolve in browsers
// — Cloudflare's universal SSL cert doesn't cover 3-level-deep subdomains. DNS
// automation is deferred to Sprint 6+ when a dedicated short domain (e.g.
// aiconnect.app) is acquired; re-enabling is a matter of restoring the
// createSubdomainCname call below. The project's live URL is now Render's
// onrender.com URL, captured at create_render_service time (see deployedUrl).
//
// The Cloudflare client (lib/platforms/cloudflare.ts) and the CLOUDFLARE_* env
// vars stay in place, just unused. The step keeps its slot in GENESIS_STEPS so
// the ordering and the events table shape stay consistent.
export async function wireGithubToRender(
  _ctx: GenesisContext,
): Promise<GenesisStepResult> {
  return {
    status: "succeeded",
    platform: undefined,
    rollbackable: false,
    details: {
      note: "DNS automation deferred to Sprint 6+ (custom domain support, blocked on SSL cert depth for aiconnectprojects.macrotechtitan.com subdomain)",
    },
  };
}

// --- step f: verify the Render service's env vars ---------------------------

// Sprint 5.7: env vars are now baked into the service at create_render_service
// time (see that step). This step no longer WRITES anything — it READS the
// service's env vars back and confirms DATABASE_URL, NODE_ENV, and PROJECT_NAME
// all landed with the expected values. That catches a Render API regression
// where create succeeds but the env vars don't actually get set, before
// verify_deployment burns minutes on a misconfigured service.
//
// Read-only, so rollbackable: false — there's nothing to undo, and the env vars
// go away with the service when create_render_service is rolled back.
export async function injectEnvVars(
  ctx: GenesisContext,
): Promise<GenesisStepResult> {
  const serviceId = ctx.results.create_render_service?.resourceId;
  if (!serviceId) {
    return {
      status: "failed",
      errorMessage:
        "No Render service id in context — create_render_service must succeed before env var verification.",
    };
  }

  const current = await getServiceEnvVars(ctx.credentials.render, serviceId);
  if (!current.success) {
    return {
      status: "failed",
      errorMessage:
        current.errorMessage ??
        "Failed to read the Render service's env vars for verification.",
    };
  }

  const byKey = new Map(
    (current.envVars ?? []).map((v) => [v.key, v.value] as const),
  );
  const missing: string[] = [];
  const wrongValue: string[] = [];

  // DATABASE_URL holds the secret — only check existence + length, never log or
  // compare-print the value.
  const dbUrl = byKey.get("DATABASE_URL");
  if (dbUrl === undefined) {
    missing.push("DATABASE_URL");
  } else if (
    !ctx.databaseConnectionString ||
    dbUrl.length !== ctx.databaseConnectionString.length
  ) {
    wrongValue.push("DATABASE_URL");
  }

  const nodeEnv = byKey.get("NODE_ENV");
  if (nodeEnv === undefined) missing.push("NODE_ENV");
  else if (nodeEnv !== "production") wrongValue.push("NODE_ENV");

  const projectName = byKey.get("PROJECT_NAME");
  if (projectName === undefined) missing.push("PROJECT_NAME");
  else if (projectName !== ctx.name) wrongValue.push("PROJECT_NAME");

  if (missing.length > 0 || wrongValue.length > 0) {
    return {
      status: "failed",
      errorMessage: `Render env var verification failed (missing: [${missing.join(", ")}], wrong value: [${wrongValue.join(", ")}]). Env vars are set at service-creation time (Sprint 5.7); a mismatch points at a Render API regression.`,
      details: { missing, wrongValue, serviceId },
    };
  }

  return {
    status: "succeeded",
    rollbackable: false,
    details: {
      verified: ["DATABASE_URL", "NODE_ENV", "PROJECT_NAME"],
      serviceId,
    },
  };
}

// --- step g: verify the deployment is live ---------------------------------

// Sprint 5.5 Commit 2: poll Render's deploys API for the real deploy status
// instead of hammering the public URL for a 200. This lets us fast-fail on
// terminal states (build_failed, etc.) within seconds with Render's own status,
// rather than burning the full deadline polling a URL that will never come up.
//
// The deadline is 8 minutes (up from 5) — but it's only consumed by unhealthy
// deploys; healthy ones reach "live" in 2-4 minutes. The longer window trades
// total wait time for fewer false-positive failures.
const VERIFY_TIMEOUT_MS = 8 * 60_000;
const VERIFY_POLL_INTERVAL_MS = 10_000;
const VERIFY_REQUEST_TIMEOUT_MS = 10_000;
// Sprint 5.6: Render's "live" status is reliable but the public URL often needs
// another ~10-60s before it actually serves 200 (the Node process is still
// accepting its first connection on $PORT). Retry the post-live 200-check up to
// 6 times, sleeping VERIFY_POLL_INTERVAL_MS between attempts (~60s of grace).
const VERIFY_POSTLIVE_MAX_ATTEMPTS = 6;

// Terminal failure states — stop polling immediately, the deploy is dead.
const RENDER_FAILED_STATES = new Set([
  "build_failed",
  "update_failed",
  "canceled",
  "pre_deploy_failed",
]);
// In-progress states — keep polling. Any unknown status is treated the same way
// (conservative: never fail on a status we don't recognize).
const RENDER_IN_PROGRESS_STATES = new Set([
  "build_in_progress",
  "update_in_progress",
  "pre_deploy_in_progress",
]);

export async function verifyDeployment(
  ctx: GenesisContext,
): Promise<GenesisStepResult> {
  const url = detailString(ctx, "create_render_service", "url");
  const serviceId = ctx.results.create_render_service?.resourceId;
  if (!serviceId || !url) {
    return {
      status: "failed",
      errorMessage:
        "No Render service id/URL was returned at creation time — cannot verify the deployment. Check the Render dashboard for build status.",
    };
  }
  const credential = ctx.credentials.render;
  const logsUrl = `https://dashboard.render.com/web/${serviceId}/logs`;

  const deadline = Date.now() + VERIFY_TIMEOUT_MS;
  let attempts = 0;
  let lastStatus = "unknown";
  while (Date.now() < deadline) {
    attempts++;
    const deploy = await renderGetLatestDeploy(credential, serviceId);
    lastStatus = deploy.rawStatus;

    if (deploy.status === "live") {
      // Belt-and-suspenders: Render reports live reliably, but the public URL
      // often needs another ~10-60s before it actually answers 200 (the app is
      // still accepting its first connection on $PORT). Retry the 200-check up
      // to VERIFY_POSTLIVE_MAX_ATTEMPTS times before declaring failure — a
      // first-attempt 502 right after "live" is expected startup behavior, not
      // an error, so each miss is logged at info level, not warn.
      let lastResult = "no response";
      for (
        let urlAttempt = 1;
        urlAttempt <= VERIFY_POSTLIVE_MAX_ATTEMPTS;
        urlAttempt++
      ) {
        const reqStart = Date.now();
        try {
          const res = await fetch(url, {
            method: "GET",
            signal: AbortSignal.timeout(VERIFY_REQUEST_TIMEOUT_MS),
          });
          if (res.status === 200) {
            return {
              status: "succeeded",
              // Read-only probe — nothing was created, nothing to roll back.
              rollbackable: false,
              details: {
                url,
                deployStatus: "live",
                finishedAt: deploy.finishedAt ?? null,
                latencyMs: Date.now() - reqStart,
                attempts,
                postLiveAttempts: urlAttempt,
              },
            };
          }
          lastResult = String(res.status);
        } catch {
          lastResult = "network error";
        }
        // Not 200 yet — expected during startup. Log at info, wait, retry.
        await logSystem(
          "info",
          "genesis",
          `verify_deployment post-live check attempt ${urlAttempt}/${VERIFY_POSTLIVE_MAX_ATTEMPTS} returned ${lastResult}`,
          { projectId: ctx.projectId, serviceId, url },
        );
        if (urlAttempt < VERIFY_POSTLIVE_MAX_ATTEMPTS) {
          await sleep(VERIFY_POLL_INTERVAL_MS);
        }
      }
      return {
        status: "failed",
        errorMessage: `Render reports deploy live but service URL returned ${lastResult} after ${VERIFY_POSTLIVE_MAX_ATTEMPTS} retry attempts over 60 seconds. Service may still be starting up — check logs at ${logsUrl}`,
      };
    }

    if (RENDER_FAILED_STATES.has(deploy.status)) {
      return {
        status: "failed",
        errorMessage: `Render deploy failed (status: ${deploy.status}). Check build logs at ${logsUrl}`,
      };
    }
    if (deploy.status === "deactivated") {
      return {
        status: "failed",
        errorMessage: "Render service has been deactivated",
      };
    }
    if (deploy.status === "auth_failed") {
      return {
        status: "failed",
        errorMessage: "Render credential rejected during verification",
      };
    }
    if (deploy.status === "not_found") {
      return {
        status: "failed",
        errorMessage: "Render service not found during verification",
      };
    }
    // In-progress or any unknown status: keep polling. Unknown statuses are
    // logged so a new Render state shows up in the genesis logs.
    if (!RENDER_IN_PROGRESS_STATES.has(deploy.status)) {
      await logSystem(
        "warn",
        "genesis",
        `verify_deployment: unrecognized Render deploy status '${deploy.status}' — treating as in-progress and continuing to poll.`,
        { projectId: ctx.projectId, serviceId, rawStatus: deploy.rawStatus },
      );
    }

    if (Date.now() + VERIFY_POLL_INTERVAL_MS < deadline) {
      await sleep(VERIFY_POLL_INTERVAL_MS);
    } else {
      break;
    }
  }

  return {
    status: "failed",
    errorMessage: `Render deploy did not reach 'live' status within 8 minutes (last status: ${lastStatus}). Check build logs at ${logsUrl}`,
  };
}

// --- step h: best-effort Auth0 wiring --------------------------------------

// Sprint 8: if the project creator has an active Auth0 integration (validated +
// include_in_projects), create an Auth0 application for this project, point its
// callbacks at the Render URL, and merge AUTH0_* into the Render env vars.
//
// BEST-EFFORT by design: this step ALWAYS returns "succeeded" so that an Auth0
// wiring failure (or a plain "no Auth0 integration" skip) never trips the
// orchestrator's rollback of the already-provisioned project. The real outcome —
// success, skip, or failure — rides in details.auth0_wiring for the SSE stream /
// UI to surface. rollbackable: false; the Auth0 app (if created) is intentionally
// left in place for the user to reuse or clean up.
export async function wireAuth0(
  ctx: GenesisContext,
): Promise<GenesisStepResult> {
  const result = await wireAuth0ForProject({
    userId: ctx.userId,
    projectId: ctx.projectId,
    projectName: ctx.name,
    projectSlug: ctx.slug,
    renderServiceId: ctx.results.create_render_service?.resourceId,
    renderCredential: ctx.credentials.render,
    deployedUrl: ctx.deployedUrl,
  });

  return {
    status: "succeeded",
    rollbackable: false,
    details: { auth0_wiring: result },
  };
}

// --- step i: best-effort Stripe Connect wiring -----------------------------

// Sprint 9: if the project creator has an active Stripe integration (validated +
// include_in_projects), create an Express Connected Account for this project,
// generate an onboarding link, and merge STRIPE_* into the Render env vars.
//
// BEST-EFFORT by design (identical contract to wire_auth0): ALWAYS returns
// "succeeded" so a Stripe wiring failure (or a plain "no Stripe integration"
// skip) never trips the orchestrator's rollback of the already-provisioned
// project. The real outcome rides in details.stripe_wiring for the SSE stream /
// UI. rollbackable: false; the Connected Account (if created) is left in place
// for the user to complete onboarding or clean up.
export async function wireStripe(
  ctx: GenesisContext,
): Promise<GenesisStepResult> {
  const result = await wireStripeForProject({
    userId: ctx.userId,
    projectId: ctx.projectId,
    projectName: ctx.name,
    projectSlug: ctx.slug,
    renderServiceId: ctx.results.create_render_service?.resourceId,
    renderCredential: ctx.credentials.render,
    userEmail: ctx.userEmail,
  });

  return {
    status: "succeeded",
    rollbackable: false,
    details: { stripe_wiring: result },
  };
}

// --- the ordered step list the orchestrator walks --------------------------

// Execution order: GitHub first (Vercel + Render both depend on the repo);
// Supabase kicked off early because it provisions slowly; Vercel + Render next;
// the two no-ops; verification; then best-effort Auth0 wiring (last, so a wiring
// failure never affects the core provisioning result).
export const GENESIS_STEPS: GenesisStep[] = [
  { name: "create_github_repo", run: createGithubRepo },
  { name: "create_supabase_project", run: createSupabaseProject },
  { name: "create_vercel_project", run: createVercelProject },
  { name: "create_render_service", run: createRenderService },
  { name: "wire_github_to_render", run: wireGithubToRender },
  { name: "inject_env_vars", run: injectEnvVars },
  { name: "verify_deployment", run: verifyDeployment },
  { name: "wire_auth0", run: wireAuth0 },
  { name: "wire_stripe", run: wireStripe },
];
