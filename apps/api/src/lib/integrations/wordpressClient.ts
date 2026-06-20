// Client for an end user's installed AI Connect WordPress plugin. Every call is
// authenticated with the plugin token via the X-AI-Connect-Token header and
// times out after 10s. Errors throw a WordPressClientError carrying an HTTP-ish
// status so the route layer can translate to a sensible response code.

const WORDPRESS_CLIENT_TIMEOUT_MS = 10_000;

export interface WordPressModule {
  slug: string;
  title: string;
  source_url: string;
  required_memberpress_tier: string | null;
}

export interface WordPressMembership {
  id: string;
  title: string;
}

export interface WordPressStatus {
  wp_version: string;
  plugin_version: string;
  active_theme: string | null;
  memberpress_installed: boolean;
  memberpress_version: string | null;
  memberpress_memberships: WordPressMembership[] | null;
}

export class WordPressClientError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "WordPressClientError";
    this.status = status;
  }
}

function endpoint(siteUrl: string, path: string): string {
  return `${siteUrl.replace(/\/$/, "")}/wp-json/ai-connect/v1${path}`;
}

async function request<T>(
  siteUrl: string,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
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
      signal: AbortSignal.timeout(WORDPRESS_CLIENT_TIMEOUT_MS),
    });
  } catch (err) {
    throw new WordPressClientError(
      `Couldn't reach the WordPress site: ${
        err instanceof Error ? err.message : "network error"
      }.`,
      502,
    );
  }

  if (res.status === 401) {
    throw new WordPressClientError(
      "WordPress rejected the plugin token. Regenerate it in the plugin settings.",
      401,
    );
  }
  if (res.status === 404) {
    throw new WordPressClientError(
      "The AI Connect plugin endpoint was not found. Confirm the plugin is installed and activated.",
      404,
    );
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Some responses (rare) may be empty; leave body null.
  }

  if (!res.ok) {
    const message =
      body &&
      typeof body === "object" &&
      "message" in body &&
      typeof (body as { message?: unknown }).message === "string"
        ? (body as { message: string }).message
        : `WordPress returned status ${res.status}.`;
    // Surface a duplicate-slug 409 as-is; collapse other 4xx to 400.
    const status = res.status === 409 ? 409 : res.status >= 500 ? 502 : 400;
    throw new WordPressClientError(message, status);
  }

  return body as T;
}

export const wordpressClient = {
  getStatus(siteUrl: string, token: string): Promise<WordPressStatus> {
    return request<WordPressStatus>(siteUrl, token, "/status");
  },

  listModules(siteUrl: string, token: string): Promise<WordPressModule[]> {
    return request<WordPressModule[]>(siteUrl, token, "/modules");
  },

  addModule(
    siteUrl: string,
    token: string,
    module: WordPressModule,
  ): Promise<WordPressModule> {
    return request<WordPressModule>(siteUrl, token, "/modules", {
      method: "POST",
      body: JSON.stringify(module),
    });
  },

  updateModule(
    siteUrl: string,
    token: string,
    slug: string,
    module: WordPressModule,
  ): Promise<WordPressModule> {
    return request<WordPressModule>(
      siteUrl,
      token,
      `/modules/${encodeURIComponent(slug)}`,
      {
        method: "PUT",
        body: JSON.stringify(module),
      },
    );
  },

  deleteModule(
    siteUrl: string,
    token: string,
    slug: string,
  ): Promise<{ slug: string; deleted: boolean }> {
    return request<{ slug: string; deleted: boolean }>(
      siteUrl,
      token,
      `/modules/${encodeURIComponent(slug)}`,
      { method: "DELETE" },
    );
  },
};
