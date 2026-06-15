import type {
  IntegrationValidator,
  IntegrationValidationResult,
} from "../types.js";

const SENDGRID_API_BASE = "https://api.sendgrid.com/v3";
const SENDGRID_VALIDATION_TIMEOUT_MS = 10_000;

/**
 * Validates a SendGrid API key by calling GET /v3/user/account.
 *
 * SendGrid returns the account's primary email and reputation on success,
 * which we surface to the user as the "identity" of the credential.
 *
 * Common failure modes:
 * - 401 Unauthorized: API key is invalid or revoked
 * - 403 Forbidden: API key lacks the read scope for user.account
 * - 5xx: SendGrid is down — treat as transient, surface a retriable message
 */
export const sendgridValidator: IntegrationValidator = async ({
  credential,
}) => {
  if (typeof credential !== "string" || credential.length === 0) {
    return {
      valid: false,
      errorMessage: "SendGrid integration requires an API key.",
    };
  }

  let res: Response;
  try {
    res = await fetch(`${SENDGRID_API_BASE}/user/account`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${credential}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(SENDGRID_VALIDATION_TIMEOUT_MS),
    });
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : "Network error contacting SendGrid.";
    return {
      valid: false,
      errorMessage: `Unable to reach SendGrid: ${message}`,
    };
  }

  if (res.status === 401) {
    return {
      valid: false,
      errorMessage:
        "SendGrid rejected the API key (401). Verify the key is correct and not revoked.",
    };
  }

  if (res.status === 403) {
    return {
      valid: false,
      errorMessage:
        "SendGrid API key lacks the required scopes (403). The key needs 'user.account' read access — try a Full Access key.",
    };
  }

  if (res.status >= 500) {
    return {
      valid: false,
      errorMessage: `SendGrid is currently unavailable (${res.status}). Try again in a few minutes.`,
    };
  }

  if (!res.ok) {
    return {
      valid: false,
      errorMessage: `SendGrid returned an unexpected status (${res.status}).`,
    };
  }

  // Parse the account body for identity confirmation.
  let body: { type?: string; reputation?: number } = {};
  try {
    body = (await res.json()) as { type?: string; reputation?: number };
  } catch {
    // Account endpoint returns JSON on success; if it doesn't parse, still
    // valid (we got 200) but we can't show identity. Not a hard fail.
  }

  return {
    valid: true,
    identity: {
      type: body.type ?? "unknown",
      reputation: body.reputation ?? null,
    },
  };
};
