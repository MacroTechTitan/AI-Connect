/**
 * Auth0 Management API client.
 *
 * Hand-rolled fetch wrapper, no Auth0 SDK dependency. Handles M2M token
 * caching with auto-refresh (tokens expire ~24h). Each method returns a typed
 * result or throws an Auth0Error.
 *
 * Tokens are cached per-(domain, client_id) tuple in-process. For AI Connect's
 * single-server topology this is fine; a multi-server deployment would need a
 * shared cache (Sprint 9+ Redis).
 *
 * The M2M client_secret is passed in by callers (read from the integration's
 * vault secret at the route layer) — the client never touches the vault.
 */

export type Auth0ErrorCode =
  | "invalid_credentials"
  | "insufficient_scope"
  | "rate_limited"
  | "application_not_found"
  | "application_already_exists"
  | "validation_error"
  | "network_error"
  | "unexpected_response"
  | "token_refresh_failed";

export class Auth0Error extends Error {
  constructor(
    public readonly code: Auth0ErrorCode,
    message: string,
    public readonly responseBody?: unknown,
  ) {
    super(message);
    this.name = "Auth0Error";
  }
}

export type Auth0AppType = "spa" | "native" | "regular_web" | "non_interactive";

export type Auth0Application = {
  client_id: string;
  client_secret?: string; // only on create or with read:client_keys scope
  name: string;
  description?: string;
  app_type?: Auth0AppType;
  callbacks?: string[];
  allowed_origins?: string[];
  allowed_logout_urls?: string[];
  web_origins?: string[];
  is_first_party?: boolean;
  oidc_conformant?: boolean;
};

export type Auth0TenantInfo = {
  friendly_name?: string;
  picture_url?: string;
  support_email?: string;
  support_url?: string;
  enabled_locales?: string[];
};

export type CreateApplicationParams = {
  name: string;
  description?: string;
  app_type?: Auth0AppType;
  callbacks?: string[];
  allowed_logout_urls?: string[];
  allowed_origins?: string[];
  web_origins?: string[];
};

export type UpdateApplicationCallbacksParams = {
  callbacks?: string[];
  allowed_logout_urls?: string[];
  allowed_origins?: string[];
  web_origins?: string[];
};

type TokenCacheEntry = {
  access_token: string;
  expires_at: number; // epoch ms
  scope: string; // space-separated scopes
};

// In-process token cache. Key: `${domain}:${client_id}`.
const tokenCache = new Map<string, TokenCacheEntry>();
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // refresh 5min before expiry

export class Auth0Client {
  /**
   * Fetches a Management API access token via client_credentials grant.
   * Caches in-process for the token's lifetime (minus 5min buffer).
   */
  async getManagementToken(
    domain: string,
    clientId: string,
    clientSecret: string,
  ): Promise<TokenCacheEntry> {
    const cacheKey = `${domain}:${clientId}`;
    const cached = tokenCache.get(cacheKey);
    const now = Date.now();

    if (cached && cached.expires_at - TOKEN_REFRESH_BUFFER_MS > now) {
      return cached;
    }

    const url = `https://${domain}/oauth/token`;
    const requestBody = {
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      audience: `https://${domain}/api/v2/`,
    };

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });
    } catch (err) {
      throw new Auth0Error(
        "network_error",
        `Could not reach ${url}: ${err instanceof Error ? err.message : "network error"}`,
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new Auth0Error(
        "invalid_credentials",
        "Auth0 rejected the M2M client credentials. Verify domain, client_id, and client_secret are correct.",
      );
    }

    if (!response.ok) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = await response.text().catch(() => undefined);
      }
      throw new Auth0Error(
        "token_refresh_failed",
        `Token refresh failed with status ${response.status}.`,
        body,
      );
    }

    const data = (await response.json()) as {
      access_token: string;
      expires_in: number;
      scope?: string;
      token_type: string;
    };

    const entry: TokenCacheEntry = {
      access_token: data.access_token,
      expires_at: now + data.expires_in * 1000,
      scope: data.scope ?? "",
    };

    tokenCache.set(cacheKey, entry);
    return entry;
  }

  /** Lists applications in the tenant. Requires read:clients scope. */
  async listApplications(
    domain: string,
    clientId: string,
    clientSecret: string,
  ): Promise<Auth0Application[]> {
    const token = await this.getManagementToken(domain, clientId, clientSecret);
    return this.fetchManagementApi<Auth0Application[]>(
      domain,
      token.access_token,
      "/api/v2/clients",
      { method: "GET" },
    );
  }

  /**
   * Gets a single application by ID. Returns client_secret if the M2M cred has
   * the read:client_keys scope.
   */
  async getApplication(
    domain: string,
    clientId: string,
    clientSecret: string,
    applicationId: string,
  ): Promise<Auth0Application> {
    const token = await this.getManagementToken(domain, clientId, clientSecret);
    return this.fetchManagementApi<Auth0Application>(
      domain,
      token.access_token,
      `/api/v2/clients/${encodeURIComponent(applicationId)}`,
      { method: "GET" },
    );
  }

  /**
   * Creates a new application. Returns the app including client_id +
   * client_secret. Requires create:clients scope.
   */
  async createApplication(
    domain: string,
    clientId: string,
    clientSecret: string,
    params: CreateApplicationParams,
  ): Promise<Auth0Application> {
    const token = await this.getManagementToken(domain, clientId, clientSecret);
    return this.fetchManagementApi<Auth0Application>(
      domain,
      token.access_token,
      "/api/v2/clients",
      {
        method: "POST",
        body: JSON.stringify({
          name: params.name,
          description: params.description,
          app_type: params.app_type ?? "spa",
          callbacks: params.callbacks ?? [],
          allowed_logout_urls: params.allowed_logout_urls ?? [],
          allowed_origins: params.allowed_origins ?? [],
          web_origins: params.web_origins ?? [],
          is_first_party: true,
          oidc_conformant: true,
        }),
      },
    );
  }

  /**
   * Updates an existing application's callback URLs and related fields.
   * Requires update:clients scope.
   */
  async updateApplicationCallbacks(
    domain: string,
    clientId: string,
    clientSecret: string,
    applicationId: string,
    params: UpdateApplicationCallbacksParams,
  ): Promise<Auth0Application> {
    const token = await this.getManagementToken(domain, clientId, clientSecret);
    const body: Record<string, unknown> = {};
    if (params.callbacks) body.callbacks = params.callbacks;
    if (params.allowed_logout_urls) {
      body.allowed_logout_urls = params.allowed_logout_urls;
    }
    if (params.allowed_origins) body.allowed_origins = params.allowed_origins;
    if (params.web_origins) body.web_origins = params.web_origins;

    return this.fetchManagementApi<Auth0Application>(
      domain,
      token.access_token,
      `/api/v2/clients/${encodeURIComponent(applicationId)}`,
      { method: "PATCH", body: JSON.stringify(body) },
    );
  }

  /**
   * Gets tenant settings. Requires read:tenant_settings scope. Returns null
   * gracefully if the scope is missing (optional info, not a hard requirement).
   */
  async getTenantInfo(
    domain: string,
    clientId: string,
    clientSecret: string,
  ): Promise<Auth0TenantInfo | null> {
    const token = await this.getManagementToken(domain, clientId, clientSecret);
    try {
      return await this.fetchManagementApi<Auth0TenantInfo>(
        domain,
        token.access_token,
        "/api/v2/tenants/settings",
        { method: "GET" },
      );
    } catch (err) {
      if (err instanceof Auth0Error && err.code === "insufficient_scope") {
        return null;
      }
      throw err;
    }
  }

  /**
   * Verifies which of the expected scopes the M2M cred actually has. Used by
   * the validator to give actionable error messages.
   */
  async verifyScopes(
    domain: string,
    clientId: string,
    clientSecret: string,
    requiredScopes: string[],
  ): Promise<{ granted: string[]; missing: string[] }> {
    const token = await this.getManagementToken(domain, clientId, clientSecret);
    const granted = token.scope.split(" ").filter(Boolean);
    return {
      granted,
      missing: requiredScopes.filter((s) => !granted.includes(s)),
    };
  }

  // ============================================================
  // Private: shared fetch wrapper with error mapping
  // ============================================================

  private async fetchManagementApi<T>(
    domain: string,
    accessToken: string,
    path: string,
    init: RequestInit,
  ): Promise<T> {
    const url = `https://${domain}${path}`;
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
          ...(init.headers ?? {}),
        },
      });
    } catch (err) {
      throw new Auth0Error(
        "network_error",
        `Could not reach Auth0 Management API: ${err instanceof Error ? err.message : "network error"}`,
      );
    }

    if (response.status === 401) {
      // Token rejected despite our buffer; surface as invalid_credentials.
      throw new Auth0Error(
        "invalid_credentials",
        "Management API token rejected.",
      );
    }

    if (response.status === 403) {
      throw new Auth0Error(
        "insufficient_scope",
        `M2M client lacks the required scope for ${path}. Grant it in Auth0 Dashboard > Applications > Machine to Machine > [your app] > APIs > Auth0 Management API.`,
      );
    }

    if (response.status === 404) {
      throw new Auth0Error(
        "application_not_found",
        `Resource not found: ${path}`,
      );
    }

    if (response.status === 409) {
      throw new Auth0Error(
        "application_already_exists",
        "An application with this name already exists in the tenant.",
      );
    }

    if (response.status === 429) {
      throw new Auth0Error(
        "rate_limited",
        "Auth0 Management API rate limit exceeded. Retry in a few seconds.",
      );
    }

    if (response.status >= 400 && response.status < 500) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = await response.text().catch(() => undefined);
      }
      throw new Auth0Error(
        "validation_error",
        `Auth0 rejected the request (${response.status}).`,
        body,
      );
    }

    if (!response.ok) {
      throw new Auth0Error(
        "unexpected_response",
        `Unexpected response status: ${response.status}`,
      );
    }

    return (await response.json()) as T;
  }
}

// Singleton instance — stateless aside from the token cache, safe to share.
export const auth0Client = new Auth0Client();
