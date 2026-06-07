import type { PlatformClient } from "./interface.js";
import type {
  PlatformActionResult,
  PlatformCreateResourceRequest,
  PlatformDeleteResult,
  PlatformValidationResult,
} from "./types.js";

const GITHUB_API = "https://api.github.com";
const TIMEOUT_MS = 30_000;

const COMMON_HEADERS = {
  "User-Agent": "AI-Connect",
  Accept: "application/vnd.github.v3+json",
};

interface GitHubUser {
  login?: string;
  name?: string | null;
  email?: string | null;
}

interface GitHubErrorBody {
  message?: string;
  errors?: Array<{ message?: string }>;
}

interface GitHubRepo {
  id: number;
  full_name: string;
  html_url: string;
  clone_url: string;
  ssh_url: string;
  url: string;
  default_branch?: string;
  owner?: { login: string; id: number };
}

function networkErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "AbortError") {
      return `GitHub request exceeded ${TIMEOUT_MS}ms.`;
    }
    return `Network error contacting GitHub: ${err.message}`;
  }
  return "Unknown network error contacting GitHub.";
}

async function validate(credential: string): Promise<PlatformValidationResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${GITHUB_API}/user`, {
      headers: {
        ...COMMON_HEADERS,
        Authorization: `Bearer ${credential}`,
      },
      signal: controller.signal,
    });
    if (res.status === 401) {
      return {
        valid: false,
        errorMessage:
          "GitHub rejected the token — verify it at github.com/settings/tokens",
      };
    }
    if (!res.ok) {
      return {
        valid: false,
        errorMessage: `GitHub validation failed with HTTP ${res.status}.`,
      };
    }
    const body = (await res.json()) as GitHubUser;
    return {
      valid: true,
      identity: {
        name: body.name ?? body.login ?? undefined,
        email: body.email ?? undefined,
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${GITHUB_API}/user/repos`, {
      method: "POST",
      headers: {
        ...COMMON_HEADERS,
        Authorization: `Bearer ${req.credential}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: req.name,
        description: req.description ?? "",
        private: req.private ?? true,
        auto_init: req.autoInit ?? true,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errBody = (await res
        .json()
        .catch(() => ({}))) as GitHubErrorBody;
      const providerMsg =
        errBody.errors?.[0]?.message ?? errBody.message ?? undefined;

      if (res.status === 401) {
        return {
          status: "error",
          errorCode: "auth_failed",
          errorMessage:
            "GitHub rejected the token. Verify it has 'repo' scope at github.com/settings/tokens.",
          isRetryable: false,
        };
      }
      if (res.status === 403) {
        return {
          status: "error",
          errorCode: "forbidden",
          errorMessage:
            providerMsg ??
            "GitHub rejected the request — the token may be missing required scopes (need 'repo').",
          isRetryable: false,
        };
      }
      if (res.status === 422) {
        return {
          status: "error",
          errorCode: "name_taken",
          errorMessage:
            providerMsg ??
            `A repository named '${req.name}' already exists on this account.`,
          isRetryable: true,
        };
      }
      if (res.status === 429) {
        return {
          status: "error",
          errorCode: "rate_limited",
          errorMessage:
            providerMsg ?? "GitHub rate limit hit — try again shortly.",
          isRetryable: true,
        };
      }
      if (res.status >= 500) {
        return {
          status: "error",
          errorCode: `http_${res.status}`,
          errorMessage:
            providerMsg ?? "GitHub server error — try again shortly.",
          isRetryable: true,
        };
      }
      return {
        status: "error",
        errorCode: `http_${res.status}`,
        errorMessage:
          providerMsg ?? `GitHub returned HTTP ${res.status}.`,
        isRetryable: false,
      };
    }

    const body = (await res.json()) as GitHubRepo;
    return {
      status: "success",
      resourceId: body.full_name,
      urls: {
        html: body.html_url,
        clone: body.clone_url,
        ssh: body.ssh_url,
        api: body.url,
      },
      details: {
        id: body.id,
        default_branch: body.default_branch,
        owner: body.owner,
      },
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return {
        status: "error",
        errorCode: "timeout",
        errorMessage: `GitHub request exceeded ${TIMEOUT_MS}ms.`,
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
    const res = await fetch(`${GITHUB_API}/repos/${resourceId}`, {
      method: "DELETE",
      headers: {
        ...COMMON_HEADERS,
        Authorization: `Bearer ${credential}`,
      },
      signal: controller.signal,
    });
    // 204 = deleted, 404 = already gone (idempotent).
    if (res.status === 204 || res.status === 404) {
      return { deleted: true };
    }
    const errBody = (await res
      .json()
      .catch(() => ({}))) as GitHubErrorBody;
    return {
      deleted: false,
      errorMessage:
        errBody.message ?? `GitHub returned HTTP ${res.status} on delete.`,
    };
  } catch (err) {
    return { deleted: false, errorMessage: networkErrorMessage(err) };
  } finally {
    clearTimeout(timeout);
  }
}

// Create a new repo FROM a template repo, rather than empty-with-auto-init.
// Separate from the PlatformClient interface so the Sprint 4 genesis flow keeps
// working unchanged; the Sprint 5 orchestrator (Commit 4) picks between this and
// createResource based on the project's template_choice. Returns the same
// PlatformActionResult shape as createResource so the orchestrator handles both
// uniformly. Costs one extra GET /user call to resolve the new owner's login,
// which the /generate endpoint requires.
export async function createRepoFromTemplate(
  credential: string,
  templateOwner: string,
  templateRepo: string,
  newRepoName: string,
  options?: { description?: string; private?: boolean },
): Promise<PlatformActionResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    // Step 1: resolve the authenticated user's login — the new repo's owner.
    const userRes = await fetch(`${GITHUB_API}/user`, {
      headers: {
        ...COMMON_HEADERS,
        Authorization: `Bearer ${credential}`,
      },
      signal: controller.signal,
    });
    if (userRes.status === 401 || userRes.status === 403) {
      return {
        status: "error",
        errorCode: "auth_failed",
        errorMessage:
          "GitHub rejected the token. Verify it has 'repo' scope at github.com/settings/tokens.",
        isRetryable: false,
      };
    }
    if (!userRes.ok) {
      return {
        status: "error",
        errorCode: `http_${userRes.status}`,
        errorMessage: `GitHub returned HTTP ${userRes.status} resolving the authenticated user.`,
        isRetryable: userRes.status >= 500,
      };
    }
    const user = (await userRes.json()) as GitHubUser;
    const owner = user.login;
    if (!owner) {
      return {
        status: "error",
        errorCode: "auth_failed",
        errorMessage:
          "GitHub did not return a login for the authenticated user.",
        isRetryable: false,
      };
    }

    // Step 2: generate the new repo from the template.
    const res = await fetch(
      `${GITHUB_API}/repos/${templateOwner}/${templateRepo}/generate`,
      {
        method: "POST",
        headers: {
          "User-Agent": "AI-Connect",
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          Authorization: `Bearer ${credential}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          owner,
          name: newRepoName,
          description: options?.description ?? null,
          private: options?.private ?? true,
          include_all_branches: false,
        }),
        signal: controller.signal,
      },
    );

    if (!res.ok) {
      const errBody = (await res
        .json()
        .catch(() => ({}))) as GitHubErrorBody;
      const providerMsg =
        errBody.errors?.[0]?.message ?? errBody.message ?? undefined;

      if (res.status === 401 || res.status === 403) {
        return {
          status: "error",
          errorCode: "auth_failed",
          errorMessage:
            providerMsg ??
            "GitHub rejected the token. Verify it has 'repo' scope at github.com/settings/tokens.",
          isRetryable: false,
        };
      }
      if (res.status === 404) {
        return {
          status: "error",
          errorCode: "template_not_found",
          errorMessage:
            providerMsg ??
            `Template repo '${templateOwner}/${templateRepo}' was not found, or it is not marked as a template repository.`,
          isRetryable: false,
        };
      }
      if (res.status === 422) {
        return {
          status: "error",
          errorCode: "name_taken",
          errorMessage:
            providerMsg ??
            `A repository named '${newRepoName}' already exists on this account.`,
          isRetryable: true,
        };
      }
      if (res.status >= 500) {
        return {
          status: "error",
          errorCode: "github_error",
          errorMessage:
            providerMsg ?? "GitHub server error — try again shortly.",
          isRetryable: true,
        };
      }
      return {
        status: "error",
        errorCode: `http_${res.status}`,
        errorMessage: providerMsg ?? `GitHub returned HTTP ${res.status}.`,
        isRetryable: false,
      };
    }

    const body = (await res.json()) as GitHubRepo;
    return {
      status: "success",
      resourceId: body.full_name,
      urls: {
        html: body.html_url,
        clone: body.clone_url,
        ssh: body.ssh_url,
        api: body.url,
      },
      details: {
        id: body.id,
        default_branch: body.default_branch,
        owner: body.owner,
        template: `${templateOwner}/${templateRepo}`,
      },
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return {
        status: "error",
        errorCode: "timeout",
        errorMessage: `GitHub request exceeded ${TIMEOUT_MS}ms.`,
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

export const githubClient: PlatformClient = {
  validate,
  createResource,
  deleteResource,
};
