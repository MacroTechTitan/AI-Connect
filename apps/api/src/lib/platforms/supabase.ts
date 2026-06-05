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
        region: req.region ?? "us-east-2",
        organization_id: req.organizationId,
        db_pass: req.dbPass,
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
        region: project.region,
        status: project.status ?? "COMING_UP",
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

export const supabaseClient: PlatformClient = {
  validate,
  createResource,
  deleteResource,
};
