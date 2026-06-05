import type { PlatformClient } from "./interface.js";
import type {
  PlatformActionResult,
  PlatformCreateResourceRequest,
  PlatformDeleteResult,
  PlatformValidationResult,
} from "./types.js";

const VERCEL_API = "https://api.vercel.com";
const TIMEOUT_MS = 30_000;

interface VercelUser {
  user?: {
    username?: string;
    name?: string;
    email?: string;
  };
}

interface VercelErrorBody {
  error?: { code?: string; message?: string };
}

interface VercelProject {
  id: string;
  name: string;
  accountId?: string;
  createdAt?: number;
}

function networkErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "AbortError") {
      return `Vercel request exceeded ${TIMEOUT_MS}ms.`;
    }
    return `Network error contacting Vercel: ${err.message}`;
  }
  return "Unknown network error contacting Vercel.";
}

async function validate(credential: string): Promise<PlatformValidationResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${VERCEL_API}/v2/user`, {
      headers: { Authorization: `Bearer ${credential}` },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      return {
        valid: false,
        errorMessage:
          "Vercel rejected the token — check that it has full access scope at vercel.com/account/tokens",
      };
    }
    if (!res.ok) {
      return {
        valid: false,
        errorMessage: `Vercel validation failed with HTTP ${res.status}.`,
      };
    }
    const body = (await res.json()) as VercelUser;
    const u = body.user;
    return {
      valid: true,
      identity: {
        name: u?.name ?? u?.username ?? undefined,
        email: u?.email ?? undefined,
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
  if (!req.gitRepository) {
    return {
      status: "error",
      errorCode: "missing_input",
      errorMessage:
        "Vercel project creation requires gitRepository ({ type, repo }).",
      isRetryable: false,
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${VERCEL_API}/v10/projects`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${req.credential}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: req.name,
        gitRepository: {
          type: req.gitRepository.type,
          repo: req.gitRepository.repo,
        },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errBody = (await res
        .json()
        .catch(() => ({}))) as VercelErrorBody;
      const providerMsg = errBody.error?.message;

      if (res.status === 401 || res.status === 403) {
        return {
          status: "error",
          errorCode: "auth_failed",
          errorMessage:
            providerMsg ??
            "Vercel rejected the token — verify it has full access scope at vercel.com/account/tokens.",
          isRetryable: false,
        };
      }
      if (res.status === 409) {
        return {
          status: "error",
          errorCode: "name_taken",
          errorMessage:
            providerMsg ??
            `A Vercel project named '${req.name}' already exists.`,
          isRetryable: true,
        };
      }
      if (res.status === 429) {
        return {
          status: "error",
          errorCode: "rate_limited",
          errorMessage:
            providerMsg ?? "Vercel rate limit hit — try again shortly.",
          isRetryable: true,
        };
      }
      if (res.status >= 500) {
        return {
          status: "error",
          errorCode: `http_${res.status}`,
          errorMessage:
            providerMsg ?? "Vercel server error — try again shortly.",
          isRetryable: true,
        };
      }
      return {
        status: "error",
        errorCode: `http_${res.status}`,
        errorMessage:
          providerMsg ?? `Vercel returned HTTP ${res.status}.`,
        isRetryable: false,
      };
    }

    const project = (await res.json()) as VercelProject;
    // /v2/user gives us the username for the dashboard URL. Fetch it in
    // parallel with project creation isn't safe (we need the username after
    // we know the project name), so do a follow-up call here. If it fails,
    // we still return the project with a placeholder dashboard URL.
    let username: string | undefined;
    try {
      const userRes = await fetch(`${VERCEL_API}/v2/user`, {
        headers: { Authorization: `Bearer ${req.credential}` },
        signal: controller.signal,
      });
      if (userRes.ok) {
        const userBody = (await userRes.json()) as VercelUser;
        username = userBody.user?.username;
      }
    } catch {
      // username lookup is best-effort; dashboard URL gracefully degrades
    }

    return {
      status: "success",
      resourceId: project.id,
      urls: {
        dashboard: username
          ? `https://vercel.com/${username}/${project.name}`
          : `https://vercel.com/dashboard`,
        production: `https://${project.name}.vercel.app`,
      },
      details: {
        id: project.id,
        name: project.name,
        accountId: project.accountId,
        createdAt: project.createdAt,
      },
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return {
        status: "error",
        errorCode: "timeout",
        errorMessage: `Vercel request exceeded ${TIMEOUT_MS}ms.`,
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
    const res = await fetch(`${VERCEL_API}/v9/projects/${resourceId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${credential}` },
      signal: controller.signal,
    });
    if (res.status === 204 || res.status === 404) {
      return { deleted: true };
    }
    const errBody = (await res
      .json()
      .catch(() => ({}))) as VercelErrorBody;
    return {
      deleted: false,
      errorMessage:
        errBody.error?.message ??
        `Vercel returned HTTP ${res.status} on delete.`,
    };
  } catch (err) {
    return { deleted: false, errorMessage: networkErrorMessage(err) };
  } finally {
    clearTimeout(timeout);
  }
}

export const vercelClient: PlatformClient = {
  validate,
  createResource,
  deleteResource,
};
