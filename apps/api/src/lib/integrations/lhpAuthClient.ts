// Client for the ai-connect WordPress plugin's mobile-auth routes (see
// wp-plugin/ai-connect/includes/mobile-auth.php). Server-to-server, authenticated
// with the plugin token via X-AI-Connect-Token, 10s timeout — mirrors
// wordpressClient.ts.
//
// The plugin returns 401 for TWO very different reasons, and the route layer must
// treat them oppositely, so this client disambiguates by response body:
//   - a bad plugin token       -> body { code: "ai_connect_unauthorized", ... }
//     => a server MISCONFIG, surfaced to the app as a 502, not a login failure.
//   - a bad username/password  -> body { error: "invalid_credentials" }
//     => the expected login failure, surfaced to the app as a clean 401.

const LHP_AUTH_TIMEOUT_MS = 10_000;

export type LhpAuthErrorCode =
  | "invalid_credentials" // user's login was wrong — expected, maps to 401
  | "wp_unauthorized" // plugin rejected OUR token — misconfig, maps to 502
  | "not_found" // plugin route missing — plugin not updated, maps to 502
  | "unreachable" // network/timeout — maps to 502
  | "upstream"; // any other non-ok — maps to 502

export class LhpAuthClientError extends Error {
  code: LhpAuthErrorCode;
  status: number;
  constructor(code: LhpAuthErrorCode, message: string, status: number) {
    super(message);
    this.name = "LhpAuthClientError";
    this.code = code;
    this.status = status;
  }
}

/** Membership half of the plugin payload, shared by both routes. */
export interface LhpMembership {
  user: { id: string; email: string | null; display_name: string | null };
  active: boolean;
  tiers: string[];
}

function endpoint(siteUrl: string, path: string): string {
  return `${siteUrl.replace(/\/$/, "")}/wp-json/ai-connect/v1${path}`;
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function isInvalidCredentials(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    (body as { error?: unknown }).error === "invalid_credentials"
  );
}

async function request(
  siteUrl: string,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<{ res: Response; body: unknown }> {
  let res: Response;
  try {
    res = await fetch(endpoint(siteUrl, path), {
      ...init,
      headers: {
        "X-AI-Connect-Token": token,
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(LHP_AUTH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new LhpAuthClientError(
      "unreachable",
      `Couldn't reach the WordPress site: ${
        err instanceof Error ? err.message : "network error"
      }.`,
      502,
    );
  }

  const body = await readJson(res);

  if (res.status === 401) {
    // Distinguish a login failure from our token being wrong.
    if (isInvalidCredentials(body)) {
      throw new LhpAuthClientError(
        "invalid_credentials",
        "WordPress rejected the username or password.",
        401,
      );
    }
    throw new LhpAuthClientError(
      "wp_unauthorized",
      "WordPress rejected the AI Connect plugin token. Regenerate it in the plugin settings.",
      502,
    );
  }
  if (res.status === 404) {
    throw new LhpAuthClientError(
      "not_found",
      "The ai-connect mobile-auth route was not found. Update the plugin to v1.1.0+.",
      502,
    );
  }
  if (!res.ok) {
    throw new LhpAuthClientError(
      "upstream",
      `WordPress returned status ${res.status}.`,
      502,
    );
  }

  return { res, body };
}

function asMembership(body: unknown): LhpMembership {
  const obj = (body ?? {}) as Record<string, unknown>;
  const user = (obj.user ?? {}) as Record<string, unknown>;
  const tiers = Array.isArray(obj.tiers)
    ? obj.tiers.filter((t): t is string => typeof t === "string")
    : [];
  return {
    user: {
      id: typeof user.id === "string" ? user.id : "",
      email: typeof user.email === "string" ? user.email : null,
      display_name:
        typeof user.display_name === "string" ? user.display_name : null,
    },
    active: obj.active === true,
    tiers,
  };
}

export const lhpAuthClient = {
  /**
   * Verify a login. Resolves to the membership payload on success; throws
   * LhpAuthClientError("invalid_credentials", 401) on a bad login.
   */
  async validateLogin(
    siteUrl: string,
    token: string,
    username: string,
    password: string,
  ): Promise<LhpMembership> {
    const { body } = await request(siteUrl, token, "/validate-login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    return asMembership(body);
  },

  /**
   * Re-read a user's membership by id, no password. Used on the token-refresh
   * path so revoked/expired memberships stop lingering in issued tokens.
   */
  async membershipStatus(
    siteUrl: string,
    token: string,
    userId: string,
  ): Promise<LhpMembership> {
    const { body } = await request(
      siteUrl,
      token,
      `/membership-status?user_id=${encodeURIComponent(userId)}`,
    );
    return asMembership(body);
  },
};
