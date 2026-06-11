import type { PlatformClient } from "./interface.js";
import type {
  PlatformActionResult,
  PlatformCreateResourceRequest,
  PlatformDeleteResult,
  PlatformValidationResult,
} from "./types.js";

const RENDER_API = "https://api.render.com/v1";
const TIMEOUT_MS = 30_000;

interface RenderOwner {
  owner?: {
    id: string;
    name?: string;
    email?: string;
  };
}

interface RenderErrorBody {
  message?: string;
  errors?: Array<{ message?: string }>;
}

interface RenderService {
  service?: {
    id: string;
    name?: string;
    ownerId?: string;
    dashboardUrl?: string;
    serviceDetails?: {
      url?: string;
    };
  };
}

function networkErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "AbortError") {
      return `Render request exceeded ${TIMEOUT_MS}ms.`;
    }
    return `Network error contacting Render: ${err.message}`;
  }
  return "Unknown network error contacting Render.";
}

async function validate(credential: string): Promise<PlatformValidationResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${RENDER_API}/owners`, {
      headers: { Authorization: `Bearer ${credential}` },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      return {
        valid: false,
        errorMessage:
          "Render rejected the token — verify it at dashboard.render.com/account/api-keys",
      };
    }
    if (!res.ok) {
      return {
        valid: false,
        errorMessage: `Render validation failed with HTTP ${res.status}.`,
      };
    }
    const body = (await res.json()) as RenderOwner[];
    const first = body[0]?.owner;
    return {
      valid: true,
      identity: {
        name: first?.name ?? undefined,
        email: first?.email ?? undefined,
        // The orchestrator creates services under this owner id.
        ownerId: first?.id ?? undefined,
      },
    };
  } catch (err) {
    return { valid: false, errorMessage: networkErrorMessage(err) };
  } finally {
    clearTimeout(timeout);
  }
}

async function createResource(
  req: PlatformCreateResourceRequest,
): Promise<PlatformActionResult> {
  if (!req.repo) {
    return {
      status: "error",
      errorCode: "missing_input",
      errorMessage:
        "Render service creation requires repo (https://github.com/owner/repo).",
      isRetryable: false,
    };
  }
  if (!req.ownerId) {
    return {
      status: "error",
      errorCode: "missing_input",
      errorMessage: "Render service creation requires ownerId.",
      isRetryable: false,
    };
  }

  // Sprint 5.5: caller passes per-template build/start commands. Fall back to
  // Sprint 4's pnpm/node-dist defaults for legacy projects that don't supply
  // them (no template_choice set).
  const buildCommand = req.buildCommand ?? "pnpm install && pnpm build";
  const startCommand = req.startCommand ?? "node dist/index.js";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${RENDER_API}/services`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${req.credential}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "web_service",
        name: req.name,
        ownerId: req.ownerId,
        repo: req.repo,
        branch: req.branch ?? "main",
        autoDeploy: "yes",
        serviceDetails: {
          env: "node",
          region: "oregon",
          plan: "starter",
          buildCommand,
          startCommand,
          numInstances: 1,
          envSpecificDetails: {
            buildCommand,
            startCommand,
          },
        },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errBody = (await res
        .json()
        .catch(() => ({}))) as RenderErrorBody;
      const providerMsg =
        errBody.errors?.[0]?.message ?? errBody.message ?? undefined;

      if (res.status === 401 || res.status === 403) {
        return {
          status: "error",
          errorCode: "auth_failed",
          errorMessage:
            providerMsg ??
            "Render rejected the token — verify it at dashboard.render.com/account/api-keys.",
          isRetryable: false,
        };
      }
      if (res.status === 409) {
        return {
          status: "error",
          errorCode: "name_taken",
          errorMessage:
            providerMsg ??
            `A Render service named '${req.name}' already exists in this account.`,
          isRetryable: true,
        };
      }
      if (res.status === 422) {
        return {
          status: "error",
          errorCode: "invalid_input",
          errorMessage:
            providerMsg ??
            "Render rejected the service config — check repo/branch/ownerId values.",
          isRetryable: false,
        };
      }
      if (res.status === 429) {
        return {
          status: "error",
          errorCode: "rate_limited",
          errorMessage:
            providerMsg ?? "Render rate limit hit — try again shortly.",
          isRetryable: true,
        };
      }
      if (res.status >= 500) {
        return {
          status: "error",
          errorCode: `http_${res.status}`,
          errorMessage:
            providerMsg ?? "Render server error — try again shortly.",
          isRetryable: true,
        };
      }
      return {
        status: "error",
        errorCode: `http_${res.status}`,
        errorMessage:
          providerMsg ?? `Render returned HTTP ${res.status}.`,
        isRetryable: false,
      };
    }

    const body = (await res.json()) as RenderService;
    const service = body.service;
    if (!service) {
      return {
        status: "error",
        errorCode: "unexpected_response",
        errorMessage:
          "Render returned a 2xx but no service body — treat as failure for safety.",
        isRetryable: true,
      };
    }

    return {
      status: "success",
      resourceId: service.id,
      urls: {
        dashboard: service.dashboardUrl ?? "",
        service: service.serviceDetails?.url ?? "",
      },
      details: {
        id: service.id,
        name: service.name,
        ownerId: service.ownerId,
      },
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return {
        status: "error",
        errorCode: "timeout",
        errorMessage: `Render request exceeded ${TIMEOUT_MS}ms.`,
        isRetryable: true,
      };
    }
    return {
      status: "error",
      errorCode: "network_error",
      errorMessage: networkErrorMessage(err),
      isRetryable: true,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function deleteResource(
  credential: string,
  resourceId: string,
): Promise<PlatformDeleteResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${RENDER_API}/services/${resourceId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${credential}` },
      signal: controller.signal,
    });
    if (res.status === 204 || res.status === 404) {
      return { deleted: true };
    }
    const errBody = (await res
      .json()
      .catch(() => ({}))) as RenderErrorBody;
    return {
      deleted: false,
      errorMessage:
        errBody.message ?? `Render returned HTTP ${res.status} on delete.`,
    };
  } catch (err) {
    return { deleted: false, errorMessage: networkErrorMessage(err) };
  } finally {
    clearTimeout(timeout);
  }
}

// --- Sprint 5: env-var read/replace (standalone, not part of PlatformClient) -
// Render's env-vars endpoint is total-replace, not partial-update: the orchestrator
// must GET the current set, merge/filter, then PUT the whole thing back. These two
// helpers wrap that so both the inject step and its rollback share one code path.

export interface RenderEnvVar {
  key: string;
  value: string;
}

interface RenderEnvVarItem {
  envVar?: { key?: string; value?: string };
}

// Fetch the service's current env vars, normalized to {key, value}. Items
// without a plain string value (e.g. Render-generated values) are skipped —
// fresh genesis services don't have any, and we only ever round-trip the
// plain key/value pairs we manage.
export async function getServiceEnvVars(
  credential: string,
  serviceId: string,
): Promise<{ success: boolean; envVars?: RenderEnvVar[]; errorMessage?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(
      `${RENDER_API}/services/${serviceId}/env-vars?limit=100`,
      {
        headers: { Authorization: `Bearer ${credential}` },
        signal: controller.signal,
      },
    );
    if (res.status === 401 || res.status === 403) {
      return { success: false, errorMessage: "Render auth failed" };
    }
    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as RenderErrorBody;
      return {
        success: false,
        errorMessage:
          errBody.message ??
          `Render returned HTTP ${res.status} listing env vars.`,
      };
    }
    const body = (await res.json()) as RenderEnvVarItem[];
    const envVars: RenderEnvVar[] = [];
    for (const item of body) {
      const key = item.envVar?.key;
      const value = item.envVar?.value;
      if (typeof key === "string" && typeof value === "string") {
        envVars.push({ key, value });
      }
    }
    return { success: true, envVars };
  } catch (err) {
    return { success: false, errorMessage: networkErrorMessage(err) };
  } finally {
    clearTimeout(timeout);
  }
}

// Replace ALL of the service's env vars with the given set (Render's PUT is a
// total replace). Callers are responsible for having merged in the current set.
export async function putServiceEnvVars(
  credential: string,
  serviceId: string,
  envVars: RenderEnvVar[],
): Promise<{ success: boolean; errorMessage?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${RENDER_API}/services/${serviceId}/env-vars`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${credential}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(
        envVars.map((v) => ({ key: v.key, value: v.value })),
      ),
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      return { success: false, errorMessage: "Render auth failed" };
    }
    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as RenderErrorBody;
      return {
        success: false,
        errorMessage:
          errBody.message ??
          `Render returned HTTP ${res.status} updating env vars.`,
      };
    }
    return { success: true };
  } catch (err) {
    return { success: false, errorMessage: networkErrorMessage(err) };
  } finally {
    clearTimeout(timeout);
  }
}

// --- Sprint 5.5: deploy-status read (standalone, not part of PlatformClient) -
// verify_deployment polls this instead of the public URL so it can distinguish
// "still building" from "deploy crashed" and fast-fail on terminal states. The
// typed status union is documentation (Render's known states); rawStatus is the
// source of truth and may carry any string Render returns.

export type RenderDeployStatus =
  | "live"
  | "build_in_progress"
  | "update_in_progress"
  | "build_failed"
  | "update_failed"
  | "canceled"
  | "deactivated"
  | "pre_deploy_in_progress"
  | "pre_deploy_failed"
  | "auth_failed"
  | "not_found"
  | (string & {});

export interface RenderDeployResult {
  status: RenderDeployStatus;
  errorMessage?: string;
  finishedAt?: string;
  rawStatus: string;
}

interface RenderDeployItem {
  deploy?: {
    id?: string;
    status?: string;
    finishedAt?: string;
  };
}

// Fetch the service's most recent deploy and surface its status. Returns the
// distinct auth_failed / not_found sentinels for 401/403 and 404 so the caller
// can give a precise error rather than a generic polling timeout.
export async function getLatestDeploy(
  credential: string,
  serviceId: string,
): Promise<RenderDeployResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(
      `${RENDER_API}/services/${serviceId}/deploys?limit=1`,
      {
        headers: { Authorization: `Bearer ${credential}` },
        signal: controller.signal,
      },
    );
    if (res.status === 401 || res.status === 403) {
      return {
        status: "auth_failed",
        errorMessage: "Render auth failed",
        rawStatus: "auth_failed",
      };
    }
    if (res.status === 404) {
      return {
        status: "not_found",
        errorMessage: "Render service not found",
        rawStatus: "not_found",
      };
    }
    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as RenderErrorBody;
      return {
        status: `http_${res.status}`,
        errorMessage:
          errBody.message ??
          `Render returned HTTP ${res.status} listing deploys.`,
        rawStatus: `http_${res.status}`,
      };
    }
    const body = (await res.json()) as RenderDeployItem[];
    const deploy = body[0]?.deploy;
    if (!deploy || typeof deploy.status !== "string") {
      return {
        status: "unknown",
        errorMessage: "Render returned no deploy for this service.",
        rawStatus: "unknown",
      };
    }
    return {
      status: deploy.status,
      finishedAt: deploy.finishedAt,
      rawStatus: deploy.status,
    };
  } catch (err) {
    return {
      status: "network_error",
      errorMessage: networkErrorMessage(err),
      rawStatus: "network_error",
    };
  } finally {
    clearTimeout(timeout);
  }
}

export const renderClient: PlatformClient = {
  validate,
  createResource,
  deleteResource,
};
