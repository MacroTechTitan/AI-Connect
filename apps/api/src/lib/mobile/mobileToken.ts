// AI-Connect-signed tokens for the mobile auth broker.
//
// PURE and unit-testable: the signing secret is passed in, no env/DB/clock
// globals are read here beyond the current time jose stamps. HS256 with a
// dedicated symmetric secret (env.MOBILE_JWT_SIGNING_KEY) — the app never signs
// or verifies, only AI Connect holds the key, so a symmetric MAC is right.
//
// Two independent lifetimes live in the token:
//   - exp: the access-token TTL (short — the app must re-validate to keep going).
//   - mtc ("membership checked-at", unix seconds): when MemberPress was last
//     read. The validate route re-checks MemberPress once this is older than
//     MEMBERSHIP_RECHECK_TTL so a revoked membership can't linger for a full exp.

import { SignJWT, jwtVerify, errors } from "jose";

/** Access-token lifetime. Short by design; validate is the refresh path. */
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60; // 1 hour

/** Re-check MemberPress when a token's membership snapshot is older than this. */
export const MEMBERSHIP_RECHECK_TTL_SECONDS = 15 * 60; // 15 minutes

const ISSUER = "ai-connect";
const AUDIENCE = "lhp-mobile";
const ALG = "HS256";

/** Identity + entitlement snapshot carried by a mobile token. */
export interface MobileTokenClaims {
  /** WordPress user id. */
  userId: string;
  email: string | null;
  displayName: string | null;
  /** Active MemberPress membership ids. */
  tiers: string[];
  /** Convenience mirror of tiers.length > 0. */
  active: boolean;
  /** Unix seconds when MemberPress was last read for this token. */
  membershipCheckedAt: number;
}

function keyBytes(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

/**
 * Sign a mobile access token. `ttlSeconds` and the membership-checked timestamp
 * are explicit so the refresh path can re-stamp them.
 */
export async function signMobileToken(
  claims: MobileTokenClaims,
  secret: string,
  ttlSeconds: number = ACCESS_TOKEN_TTL_SECONDS,
): Promise<string> {
  return new SignJWT({
    email: claims.email,
    display_name: claims.displayName,
    tiers: claims.tiers,
    active: claims.active,
    mtc: claims.membershipCheckedAt,
  })
    .setProtectedHeader({ alg: ALG })
    .setSubject(claims.userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(keyBytes(secret));
}

/** Discriminated result so callers branch on the reason without try/catch. */
export type VerifyResult =
  | { ok: true; claims: MobileTokenClaims }
  | { ok: false; reason: "expired" | "invalid" };

/**
 * Verify signature + issuer/audience + expiry. Returns a discriminated result;
 * an expired token is reported distinctly from a malformed/forged one, though
 * both are unauthorized to the app.
 */
export async function verifyMobileToken(
  token: string,
  secret: string,
): Promise<VerifyResult> {
  try {
    const { payload } = await jwtVerify(token, keyBytes(secret), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: [ALG],
    });

    const tiers = Array.isArray(payload.tiers)
      ? (payload.tiers as unknown[]).filter(
          (t): t is string => typeof t === "string",
        )
      : [];

    return {
      ok: true,
      claims: {
        userId: typeof payload.sub === "string" ? payload.sub : "",
        email: typeof payload.email === "string" ? payload.email : null,
        displayName:
          typeof payload.display_name === "string"
            ? payload.display_name
            : null,
        tiers,
        active: payload.active === true,
        membershipCheckedAt:
          typeof payload.mtc === "number" ? payload.mtc : 0,
      },
    };
  } catch (err) {
    if (err instanceof errors.JWTExpired) {
      return { ok: false, reason: "expired" };
    }
    return { ok: false, reason: "invalid" };
  }
}

/** True when a token's membership snapshot is stale and should be re-checked. */
export function membershipIsStale(
  membershipCheckedAt: number,
  nowSeconds: number,
): boolean {
  return nowSeconds - membershipCheckedAt >= MEMBERSHIP_RECHECK_TTL_SECONDS;
}
