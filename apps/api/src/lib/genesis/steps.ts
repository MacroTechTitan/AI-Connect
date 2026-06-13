import { randomBytes } from "node:crypto";

import { eq } from "drizzle-orm";

import { getDb } from "../../db/client.js";
import { projects } from "../../db/schema.js";
import { logSystem } from "../logging.js";
import {
  createRepoFromTemplate,
  getPlatformClient,
  getServiceEnvVars,
  putServiceEnvVars,
  renderGetLatestDeploy,
  supabaseBuildConnectionString,
  supabaseWaitUntilReady,
  type PlatformActionResult,
  type RenderEnvVar,
} from "../platforms/index.js";
import * as vault from "../vault.js";
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

export async function createGithubRepo(
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

// --- step f: inject env vars onto the Render service ------------------------

// Merge DATABASE_URL (from Vault, via ctx), NODE_ENV, and PROJECT_NAME into the
// Render service's env vars. Render's env-vars endpoint is total-replace, so we
// fetch the current set, overlay our three keys, and PUT the union back. The
// step is rollbackable as platform "render" + step name inject_env_vars, which
// the orchestrator routes to a fetch-filter-put removal of just our keys.
const INJECTED_ENV_KEYS = ["DATABASE_URL", "NODE_ENV", "PROJECT_NAME"] as const;

export async function injectEnvVars(
  ctx: GenesisContext,
): Promise<GenesisStepResult> {
  const connectionString = ctx.databaseConnectionString;
  if (!connectionString) {
    return {
      status: "failed",
      errorMessage:
        "No database connection string in context — create_supabase_project must succeed before env injection.",
    };
  }

  const serviceId = ctx.results.create_render_service?.resourceId;
  if (!serviceId) {
    return {
      status: "failed",
      errorMessage:
        "No Render service id in context — create_render_service must succeed before env injection.",
    };
  }

  const current = await getServiceEnvVars(ctx.credentials.render, serviceId);
  if (!current.success) {
    return {
      status: "failed",
      errorMessage:
        current.errorMessage ?? "Failed to read the Render service's env vars.",
    };
  }

  // Our values (DATABASE_URL holds the secret — kept out of the event details).
  const ourVars: RenderEnvVar[] = [
    { key: "DATABASE_URL", value: connectionString },
    { key: "NODE_ENV", value: "production" },
    { key: "PROJECT_NAME", value: ctx.name },
  ];
  const ourKeys = new Set(ourVars.map((v) => v.key));
  const merged = [
    ...(current.envVars ?? []).filter((v) => !ourKeys.has(v.key)),
    ...ourVars,
  ];

  const put = await putServiceEnvVars(ctx.credentials.render, serviceId, merged);
  if (!put.success) {
    return {
      status: "failed",
      errorMessage:
        put.errorMessage ?? "Failed to update the Render service's env vars.",
    };
  }

  ctx.renderEnvVarKeys = [...INJECTED_ENV_KEYS];

  return {
    status: "succeeded",
    platform: "render",
    rollbackable: true,
    resourceId: serviceId,
    // keysSet only — never the DATABASE_URL value.
    details: { keysSet: ctx.renderEnvVarKeys },
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

// --- the ordered step list the orchestrator walks --------------------------

// Execution order: GitHub first (Vercel + Render both depend on the repo);
// Supabase kicked off early because it provisions slowly; Vercel + Render next;
// the two no-ops; verification last.
export const GENESIS_STEPS: GenesisStep[] = [
  { name: "create_github_repo", run: createGithubRepo },
  { name: "create_supabase_project", run: createSupabaseProject },
  { name: "create_vercel_project", run: createVercelProject },
  { name: "create_render_service", run: createRenderService },
  { name: "wire_github_to_render", run: wireGithubToRender },
  { name: "inject_env_vars", run: injectEnvVars },
  { name: "verify_deployment", run: verifyDeployment },
];
