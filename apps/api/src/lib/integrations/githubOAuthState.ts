import { createHmac, timingSafeEqual } from "node:crypto";

import { env } from "../env.js";

/**
 * Encodes and signs a state parameter for the GitHub OAuth install flow.
 * Contains the AI Connect user_id, HMAC-signed with a server secret to
 * prevent CSRF (an attacker can't forge a state pointing at another user).
 *
 * Format: base64url(user_id) + '.' + base64url(hmac_sha256(user_id))
 *
 * Uses GITHUB_STATE_SIGNING_KEY as the HMAC key — a dedicated high-entropy
 * server secret. (The spec sketch reused AUTH0_CLIENT_SECRET, but this
 * codebase has no such env var, and overloading MASTER_KEY — the vault AES
 * key — for a second cryptographic purpose is poor hygiene. Hence a
 * dedicated key.)
 */

function getStateSigningKey(): string {
  const key = env.GITHUB_STATE_SIGNING_KEY;
  if (!key) {
    throw new Error(
      "GITHUB_STATE_SIGNING_KEY is required for OAuth state signing.",
    );
  }
  return key;
}

export function encodeState(userId: string): string {
  const key = getStateSigningKey();
  const payload = Buffer.from(userId, "utf8").toString("base64url");
  const sig = createHmac("sha256", key).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyState(state: string): string | null {
  const parts = state.split(".");
  if (parts.length !== 2) return null;

  const [payload, sig] = parts;
  if (!payload || !sig) return null;

  const key = getStateSigningKey();
  const expectedSig = createHmac("sha256", key)
    .update(payload)
    .digest("base64url");

  const sigBuf = Buffer.from(sig, "base64url");
  const expectedBuf = Buffer.from(expectedSig, "base64url");
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!timingSafeEqual(sigBuf, expectedBuf)) return null;

  try {
    return Buffer.from(payload, "base64url").toString("utf8");
  } catch {
    return null;
  }
}
