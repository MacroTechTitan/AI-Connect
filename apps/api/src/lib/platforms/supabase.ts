import type { PlatformClient } from "./interface.js";
import type {
  PlatformActionResult,
  PlatformCreateResourceRequest,
  PlatformDeleteResult,
  PlatformValidationResult,
} from "./types.js";

const SUPABASE_MGMT_API = "https://api.supabase.com/v1";
const TIMEOUT_MS = 30_000;

interface SupabaseOrg {
  id: string;
  name?: string;
}

interface SupabaseErrorBody {
  message?: string;
  error?: string;
}

interface SupabaseProject {
  id: string;
  name?: string;
  region?: string;
  status?: string;
}

function networkErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "AbortError") {
      return `Supabase request exceeded ${TIMEOUT_MS}ms.`;
    }
    return `Network error contacting Supabase: ${err.message}`;
  }
  return "Unknown network error contacting Supabase.";
}

async function validate(credential: string): Promise<PlatformValidationResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${SUPABASE_MGMT_API}/organizations`, {
      headers: { Authorization: `Bearer ${credential}` },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      return {
        valid: false,
        errorMessage:
          "Supabase rejected the token — generate a new one at supabase.com/dashboard/account/tokens",
      };
    }
    if (!res.ok) {
      return {
        valid: false,
        errorMessage: `Supabase validation failed with HTTP ${res.status}.`,
      };
    }
    const body = (await res.json()) as SupabaseOrg[];
    const first = body[0];
    return {
      valid: true,
      identity: {
        name: first?.name ?? undefined,
        // The orchestrator creates projects under this organization id.
        organizationId: first?.id ?? undefined,
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
  if (!req.organizationId) {
    return {
      status: "error",
      errorCode: "missing_input",
      errorMessage: "Supabase project creation requires organizationId.",
      isRetryable: false,
    };
  }
  if (!req.dbPass) {
    return {
      status: "error",
      errorCode: "missing_input",
      errorMessage:
        "Supabase project creation requires dbPass (the orchestrator generates this).",
      isRetryable: false,
    };
  }

  // Capture once: TS would re-widen req.dbPass to string|undefined after the
  // awaited fetch below, and this is the value we echo back so the orchestrator
  // can build the connection string (Supabase never exposes it again).
  const dbPass = req.dbPass;
  const region = req.region ?? "us-east-2";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${SUPABASE_MGMT_API}/projects`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${req.credential}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: req.name,
        region,
        organization_id: req.organizationId,
        db_pass: dbPass,
        plan: "free",
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errBody = (await res
        .json()
        .catch(() => ({}))) as SupabaseErrorBody;
      const providerMsg = errBody.message ?? errBody.error ?? undefined;

      if (res.status === 401 || res.status === 403) {
        return {
          status: "error",
          errorCode: "auth_failed",
          errorMessage:
            providerMsg ??
            "Supabase rejected the token — verify it at supabase.com/dashboard/account/tokens.",
          isRetryable: false,
        };
      }
      if (res.status === 409) {
        return {
          status: "error",
          errorCode: "name_taken",
          errorMessage:
            providerMsg ??
            `A Supabase project named '${req.name}' already exists in this organization.`,
          isRetryable: true,
        };
      }
      if (res.status === 422) {
        return {
          status: "error",
          errorCode: "invalid_input",
          errorMessage:
            providerMsg ??
            "Supabase rejected the project config — check name/region/organizationId.",
          isRetryable: false,
        };
      }
      if (res.status === 429) {
        return {
          status: "error",
          errorCode: "rate_limited",
          errorMessage:
            providerMsg ?? "Supabase rate limit hit — try again shortly.",
          isRetryable: true,
        };
      }
      if (res.status >= 500) {
        return {
          status: "error",
          errorCode: `http_${res.status}`,
          errorMessage:
            providerMsg ?? "Supabase server error — try again shortly.",
          isRetryable: true,
        };
      }
      return {
        status: "error",
        errorCode: `http_${res.status}`,
        errorMessage:
          providerMsg ?? `Supabase returned HTTP ${res.status}.`,
        isRetryable: false,
      };
    }

    // Supabase returns the project as soon as creation is accepted; the
    // project may still be COMING_UP for 30-90s. The orchestrator polls
    // status separately — this client just hands back the IDs.
    const project = (await res.json()) as SupabaseProject;
    return {
      status: "success",
      resourceId: project.id,
      urls: {
        dashboard: `https://supabase.com/dashboard/project/${project.id}`,
        api: `https://${project.id}.supabase.co`,
      },
      details: {
        id: project.id,
        name: project.name,
        // Fall back to the requested region; Supabase doesn't always echo it,
        // and the orchestrator needs it to build the connection string.
        region: project.region ?? region,
        status: project.status ?? "COMING_UP",
        // The generated Postgres password. Supabase's API will not return this
        // again post-creation, so the orchestrator must capture it here to
        // construct DATABASE_URL later. Lives only in the in-memory result and
        // is encrypted straight to Vault by the orchestrator — never logged.
        dbPass,
      },
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return {
        status: "error",
        errorCode: "timeout",
        errorMessage: `Supabase request exceeded ${TIMEOUT_MS}ms.`,
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
    const res = await fetch(`${SUPABASE_MGMT_API}/projects/${resourceId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${credential}` },
      signal: controller.signal,
    });
    // Supabase returns 200 on successful delete (not 204).
    if (res.status === 200 || res.status === 204 || res.status === 404) {
      return { deleted: true };
    }
    const errBody = (await res
      .json()
      .catch(() => ({}))) as SupabaseErrorBody;
    return {
      deleted: false,
      errorMessage:
        errBody.message ??
        errBody.error ??
        `Supabase returned HTTP ${res.status} on delete.`,
    };
  } catch (err) {
    return { deleted: false, errorMessage: networkErrorMessage(err) };
  } finally {
    clearTimeout(timeout);
  }
}

// Supabase project creation is asynchronous: the create call returns while the
// project is still COMING_UP (30-90s to ACTIVE_HEALTHY). These two helpers are
// Supabase-specific (not part of PlatformClient) and let the Sprint 5
// orchestrator wait for readiness, then build the Postgres connection string
// from the pieces createResource handed back.

const READY_INTERVAL_MS = 5_000;
const READY_TIMEOUT_MS = 120_000;
// Terminal statuses that mean the project will never come up — bail immediately.
const FAILED_STATUSES = new Set(["INIT_FAILED", "REMOVED", "RESTORE_FAILED"]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Polls the project's status until it reaches ACTIVE_HEALTHY. Transient errors
// (network blips, 5xx) don't abort the wait — they're retried until the overall
// deadline. Per-request timeouts count against that deadline, so a hung request
// can't extend the wait past timeoutMs.
export async function waitUntilReady(
  credential: string,
  projectId: string,
  options?: { intervalMs?: number; timeoutMs?: number },
): Promise<{ ready: boolean; status: string; errorMessage?: string }> {
  const intervalMs = options?.intervalMs ?? READY_INTERVAL_MS;
  const timeoutMs = options?.timeoutMs ?? READY_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  let lastStatus = "unknown";
  let lastTransientError: string | undefined;

  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${SUPABASE_MGMT_API}/projects/${projectId}`, {
        headers: { Authorization: `Bearer ${credential}` },
        signal: controller.signal,
      });

      if (res.status === 401 || res.status === 403) {
        return { ready: false, status: "unknown", errorMessage: "Supabase auth failed" };
      }
      if (res.status === 404) {
        return {
          ready: false,
          status: "removed",
          errorMessage: "Supabase project not found (may have been deleted)",
        };
      }
      if (res.ok) {
        const project = (await res.json()) as SupabaseProject;
        lastStatus = project.status ?? "unknown";
        if (lastStatus === "ACTIVE_HEALTHY") {
          return { ready: true, status: "ACTIVE_HEALTHY" };
        }
        if (FAILED_STATUSES.has(lastStatus)) {
          return {
            ready: false,
            status: lastStatus,
            errorMessage: "Supabase project failed to initialize",
          };
        }
        // COMING_UP / INACTIVE / RESTORING / etc. — keep waiting.
      } else {
        // 5xx and other non-terminal codes (e.g. 429) are transient — retry.
        lastTransientError = `Supabase returned HTTP ${res.status} while polling status.`;
      }
    } catch (err) {
      // Network error or per-request timeout — transient, keep polling.
      lastTransientError = networkErrorMessage(err);
    } finally {
      clearTimeout(timeout);
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(intervalMs, remaining));
  }

  const base = `Supabase project did not reach ACTIVE_HEALTHY within ${timeoutMs}ms`;
  return {
    ready: false,
    status: lastStatus,
    errorMessage: lastTransientError
      ? `${base} (last error: ${lastTransientError})`
      : base,
  };
}

// Pure helper (no API call) that assembles the standard Supabase Postgres
// pooler connection string from the pieces createResource returns. The
// orchestrator encrypts the result straight to Vault.
export function buildConnectionString(
  projectRef: string,
  dbPass: string,
  region: string,
): string {
  return `postgresql://postgres.${projectRef}:${dbPass}@aws-0-${region}.pooler.supabase.com:6543/postgres`;
}

export const supabaseClient: PlatformClient = {
  validate,
  createResource,
  deleteResource,
};
