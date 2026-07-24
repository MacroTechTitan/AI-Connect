// Site config for the Life Hack Protocol mobile auth broker.
//
// This is the "site-config entry for lifehackprotocol.com" the broker runs on:
// the WordPress base URL plus the credential used to reach it. The credential is
// the ai-connect WordPress plugin token (X-AI-Connect-Token) — NOT a MemberPress
// API key. Password verification goes through the plugin's wp_authenticate()
// route, so no MemberPress key is needed at all (see docs/MOBILE_AUTH.md).
//
// The token value lives ONLY in Supabase Vault; env holds just the secret id
// pointing at it (env.LHP_WP_TOKEN_SECRET_ID), the same indirection the
// integrations table uses. Nothing here is ever returned to the app.

import { env } from "../env.js";
import * as vault from "../vault.js";

export interface LhpSiteConfig {
  siteUrl: string;
  /** ai-connect plugin token. Server-to-server only; never sent to the app. */
  token: string;
}

/** Thrown when the broker isn't configured. Route layer maps this to a 500. */
export class MobileConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MobileConfigError";
  }
}

// The vault decrypt is a DB round trip; the token rotates rarely, so cache it
// briefly to keep the login path fast under bursts. TTL is short so a rotated
// token is picked up within a few minutes without a redeploy.
const TOKEN_CACHE_TTL_MS = 5 * 60_000;
let cached: { token: string; fetchedAt: number } | null = null;

async function getPluginToken(): Promise<string> {
  const secretId = env.LHP_WP_TOKEN_SECRET_ID;
  if (!secretId) {
    throw new MobileConfigError(
      "LHP_WP_TOKEN_SECRET_ID is not set — the mobile broker has no WordPress plugin token.",
    );
  }

  // Date.now() is fine here (not a workflow script); cache freshness only.
  const now = Date.now();
  if (cached && now - cached.fetchedAt < TOKEN_CACHE_TTL_MS) {
    return cached.token;
  }

  let token: string;
  try {
    token = await vault.getSecret(secretId);
  } catch (err) {
    throw new MobileConfigError(
      `Couldn't read the WordPress plugin token from Vault: ${
        err instanceof Error ? err.message : "unknown error"
      }`,
    );
  }

  cached = { token, fetchedAt: now };
  return token;
}

/** Resolve the base URL + plugin token for the broker's WordPress calls. */
export async function getLhpSiteConfig(): Promise<LhpSiteConfig> {
  const token = await getPluginToken();
  return { siteUrl: env.LHP_SITE_URL, token };
}

/** Test/ops hook: drop the cached token so the next call re-reads Vault. */
export function clearLhpTokenCache(): void {
  cached = null;
}
