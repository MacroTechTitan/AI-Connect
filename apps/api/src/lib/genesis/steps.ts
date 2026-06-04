import { randomBytes } from "node:crypto";

import { getPlatformClient } from "../platforms/index.js";
import type { GenesisContext, GenesisStep, GenesisStepResult } from "./types.js";

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

  const candidates = [ctx.slug];
  for (let i = 2; i <= GITHUB_NAME_RETRIES + 1; i++) {
    candidates.push(`${ctx.slug}-${i}`);
  }

  let lastError = `Could not create a GitHub repo for '${ctx.slug}'.`;
  for (const name of candidates) {
    const result = await github.createResource({
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
        details: {
          full_name: result.resourceId,
          html_url: result.urls.html ?? "",
          clone_url: result.urls.clone ?? "",
          name,
          repo_id: result.details.id,
          default_branch: result.details.default_branch,
        },
      };
    }

    lastError = result.errorMessage;
    // Only a retryable name collision earns another candidate; anything else
    // (auth, scopes, server error) is terminal.
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

// Supabase accepts the project immediately but it stays COMING_UP for 30-90s.
// Sprint 4 MVP hands back the project id without waiting for ACTIVE_HEALTHY —
// nothing downstream needs the DB yet (env-var injection is deferred to
// Sprint 5). When that lands, this is where an ACTIVE_HEALTHY poll goes.
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

  const result = await getPlatformClient("supabase").createResource({
    credential: ctx.credentials.supabase,
    name: ctx.slug,
    region: "us-east-2",
    organizationId,
    dbPass: generateDbPassword(),
  });

  if (result.status === "success") {
    return {
      status: "succeeded",
      resourceId: result.resourceId,
      details: {
        id: result.resourceId,
        dashboard_url: result.urls.dashboard ?? "",
        api_url: result.urls.api ?? "",
        status: result.details.status,
      },
    };
  }

  return { status: "failed", errorMessage: result.errorMessage };
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

  const result = await getPlatformClient("render").createResource({
    credential: ctx.credentials.render,
    name: ctx.slug,
    repo: repoUrl,
    branch: "main",
    ownerId,
  });

  if (result.status === "success") {
    return {
      status: "succeeded",
      resourceId: result.resourceId,
      details: {
        id: result.resourceId,
        // The deployed service URL — verify_deployment polls this.
        url: result.urls.service ?? "",
        dashboard_url: result.urls.dashboard ?? "",
      },
    };
  }

  return { status: "failed", errorMessage: result.errorMessage };
}

// --- step e: wire GitHub → Render (no-op for Sprint 4) ----------------------

// Render auto-creates the deploy webhook when a service is created from a
// GitHub repo URL, so there is nothing to do here yet. The step exists so
// Sprint 5+ can add explicit webhook validation without reshaping the
// orchestrator's step list.
export async function wireGithubToRender(
  _ctx: GenesisContext,
): Promise<GenesisStepResult> {
  return {
    status: "succeeded",
    details: { note: "auto-wired by Render at service creation time" },
  };
}

// --- step f: inject env vars (no-op for Sprint 4) ---------------------------

// Real env-var injection needs the deployed URL, which needs DNS automation —
// out of scope for Sprint 4. Activates with the Sprint 5 DNS + Auth0 wiring.
export async function injectEnvVars(
  _ctx: GenesisContext,
): Promise<GenesisStepResult> {
  return {
    status: "succeeded",
    details: {
      note: "env var injection deferred to Sprint 5 (DNS + Auth0 wiring)",
    },
  };
}

// --- step g: verify the deployment is live ---------------------------------

const VERIFY_TIMEOUT_MS = 5 * 60_000;
const VERIFY_POLL_INTERVAL_MS = 10_000;
const VERIFY_REQUEST_TIMEOUT_MS = 10_000;

export async function verifyDeployment(
  ctx: GenesisContext,
): Promise<GenesisStepResult> {
  const url = detailString(ctx, "create_render_service", "url");
  if (!url) {
    return {
      status: "failed",
      errorMessage:
        "No Render service URL was returned at creation time — cannot verify the deployment. Check the Render dashboard for build status.",
    };
  }

  const deadline = Date.now() + VERIFY_TIMEOUT_MS;
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts++;
    const reqStart = Date.now();
    try {
      const res = await fetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(VERIFY_REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200) {
        return {
          status: "succeeded",
          details: {
            url,
            statusCode: 200,
            latencyMs: Date.now() - reqStart,
            attempts,
          },
        };
      }
    } catch {
      // Service not reachable yet (build in progress, cold DNS, timeout) —
      // swallow and poll again until the deadline.
    }
    if (Date.now() + VERIFY_POLL_INTERVAL_MS < deadline) {
      await sleep(VERIFY_POLL_INTERVAL_MS);
    } else {
      break;
    }
  }

  return {
    status: "failed",
    errorMessage: `Deployment took longer than 5 minutes to come up. The Render service URL is ${url} — check the Render dashboard for build status.`,
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
