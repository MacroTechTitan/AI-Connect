import {
  auth0Client,
  Auth0Error,
  type Auth0Application,
} from "../auth0Client.js";
import type {
  Auth0Config,
  Auth0Identity,
  IntegrationValidator,
} from "../types.js";

// Minimum scope needed to use the connector at all (list applications).
const REQUIRED_SCOPES = ["read:clients"];

// Accepts tenant.auth0.com and tenant.<region>.auth0.com (us/eu/au/jp/...).
const AUTH0_DOMAIN_RE = /^[a-z0-9-]+(\.[a-z]{2})?\.auth0\.com$/i;

/**
 * Factory function. Returns an IntegrationValidator for Auth0 integrations.
 * userId is unused (no per-user ownership check), so it's prefixed `_`.
 *
 * The M2M client_secret arrives as `credential` (the validate-before-vault
 * flow — same as sendgrid/wordpress), so the validator never reads the vault.
 * It verifies the credentials against the Management API: fetch a token, confirm
 * read:clients is granted, and list applications to prove access works.
 */
export function makeAuth0Validator(_userId: string): IntegrationValidator {
  return async ({ credential, config }) => {
    const c = config as Auth0Config;

    // Shape checks.
    if (typeof c.domain !== "string" || c.domain.length === 0) {
      return { valid: false, errorMessage: "Auth0 domain is required." };
    }
    // Normalize: strip protocol + trailing slash if the user pasted a URL.
    const domain = c.domain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    if (!AUTH0_DOMAIN_RE.test(domain)) {
      return {
        valid: false,
        errorMessage: `Domain "${domain}" does not look like a valid Auth0 tenant domain. Expected format: yourtenant.us.auth0.com`,
      };
    }
    if (typeof c.m2m_client_id !== "string" || c.m2m_client_id.length === 0) {
      return { valid: false, errorMessage: "M2M client_id is required." };
    }
    if (typeof credential !== "string" || credential.length === 0) {
      return { valid: false, errorMessage: "M2M client_secret is required." };
    }
    const clientSecret = credential;

    // 1) Verify the credentials by fetching a Management API token.
    try {
      await auth0Client.getManagementToken(
        domain,
        c.m2m_client_id,
        clientSecret,
      );
    } catch (err) {
      if (err instanceof Auth0Error) {
        if (err.code === "invalid_credentials") {
          return {
            valid: false,
            errorMessage:
              "Auth0 rejected the M2M credentials. Check client_id and client_secret are correct, and that the M2M app is authorized for the Management API.",
          };
        }
        return { valid: false, errorMessage: err.message };
      }
      throw err;
    }

    // 2) Confirm the required scope is granted.
    const scopeCheck = await auth0Client.verifyScopes(
      domain,
      c.m2m_client_id,
      clientSecret,
      REQUIRED_SCOPES,
    );
    if (scopeCheck.missing.length > 0) {
      return {
        valid: false,
        errorMessage: `M2M client is missing required scopes: ${scopeCheck.missing.join(
          ", ",
        )}. Grant these in Auth0 Dashboard > Applications > Machine to Machine > [your M2M app] > APIs > Auth0 Management API.`,
      };
    }

    // 3) List applications to confirm the Management API actually works.
    let applications: Auth0Application[];
    try {
      applications = await auth0Client.listApplications(
        domain,
        c.m2m_client_id,
        clientSecret,
      );
    } catch (err) {
      if (err instanceof Auth0Error) {
        return { valid: false, errorMessage: err.message };
      }
      throw err;
    }

    // Resolve the default application's name, if one was preselected.
    let defaultAppName: string | undefined;
    if (c.default_application_id) {
      defaultAppName = applications.find(
        (a) => a.client_id === c.default_application_id,
      )?.name;
    }

    const tenantName = domain.split(".")[0] ?? domain;
    const identity: Auth0Identity = {
      tenant_name: tenantName,
      tenant_domain: domain,
      application_count: applications.length,
      default_application_id: c.default_application_id,
      default_application_name: defaultAppName,
      m2m_scopes_verified: scopeCheck.granted,
    };

    return { valid: true, identity };
  };
}
