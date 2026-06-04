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

  const buildCommand = "pnpm install && pnpm build";
  const startCommand = "node dist/index.js";

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

export const renderClient: PlatformClient = {
  validate,
  createResource,
  deleteResource,
};
