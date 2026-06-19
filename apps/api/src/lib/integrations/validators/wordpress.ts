import type {
  IntegrationValidator,
  WordPressConfig,
} from "../types.js";

const WORDPRESS_VALIDATION_TIMEOUT_MS = 10_000;

/**
 * Validates a WordPress integration by hitting the AI Connect plugin's /ping
 * endpoint with the stored token. Mirrors the SendGrid validator's status-code
 * branching, but each failure maps to a concrete remediation step the wizard
 * surfaces (404 → plugin not activated, 401 → wrong token, network → wrong URL).
 */
export const wordpressValidator: IntegrationValidator = async ({
  credential,
  config,
}) => {
  if (typeof credential !== "string" || credential.length === 0) {
    return {
      valid: false,
      errorMessage: "WordPress integration requires the plugin token.",
    };
  }

  const c = config as WordPressConfig;
  if (typeof c.site_url !== "string" || !/^https?:\/\//i.test(c.site_url)) {
    return {
      valid: false,
      errorMessage: "WordPress site_url must start with http:// or https://.",
    };
  }

  const pingUrl = `${c.site_url.replace(/\/$/, "")}/wp-json/ai-connect/v1/ping`;

  let res: Response;
  try {
    res = await fetch(pingUrl, {
      method: "GET",
      headers: {
        "X-AI-Connect-Token": credential,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(WORDPRESS_VALIDATION_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      valid: false,
      errorMessage: `Unable to reach WordPress site: ${
        err instanceof Error ? err.message : "Network error"
      }. Check the site URL and that the AI Connect plugin is installed and activated.`,
    };
  }

  if (res.status === 404) {
    return {
      valid: false,
      errorMessage:
        "The AI Connect plugin endpoint was not found. Make sure the plugin is installed and activated on this WordPress site.",
    };
  }

  if (res.status === 401) {
    return {
      valid: false,
      errorMessage:
        "WordPress rejected the token. Generate a new token in the plugin settings and copy it carefully.",
    };
  }

  if (!res.ok) {
    return {
      valid: false,
      errorMessage: `WordPress returned status ${res.status}. Check the AI Connect plugin is configured correctly.`,
    };
  }

  let body: { status?: string; version?: string; site_url?: string } = {};
  try {
    body = (await res.json()) as {
      status?: string;
      version?: string;
      site_url?: string;
    };
  } catch {
    return {
      valid: false,
      errorMessage:
        "WordPress responded but the response was not valid JSON. Plugin may need to be reinstalled.",
    };
  }

  return {
    valid: true,
    identity: {
      site_url: body.site_url ?? c.site_url,
      plugin_version: body.version ?? "unknown",
    },
  };
};
