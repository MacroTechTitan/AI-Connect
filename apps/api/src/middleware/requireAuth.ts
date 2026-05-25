import type { NextFunction, Request, Response } from "express";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { env } from "../lib/env.js";

export type AuthenticatedUser = {
  sub: string;
  email: string | undefined;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

// Auth0 emits the `iss` claim with a trailing slash. The env var may or may
// not include it depending on how the operator entered the value, so we
// normalize before both building the JWKS URL and comparing.
function normalizeIssuer(raw: string): string {
  return raw.endsWith("/") ? raw : `${raw}/`;
}

// JWKS instance is cached per issuer URL. jose's createRemoteJWKSet has its
// own internal cache + refresh on key rotation, so we just need to avoid
// constructing it on every request.
type Jwks = ReturnType<typeof createRemoteJWKSet>;
let jwksCache: { issuer: string; jwks: Jwks } | undefined;

function getJwks(issuer: string): Jwks {
  if (jwksCache && jwksCache.issuer === issuer) return jwksCache.jwks;
  const url = new URL(".well-known/jwks.json", issuer);
  const jwks = createRemoteJWKSet(url);
  jwksCache = { issuer, jwks };
  return jwks;
}

function deny(res: Response, reason: string): void {
  res.status(401).json({ error: "unauthorized", reason });
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!env.AUTH0_ISSUER_BASE_URL || !env.AUTH0_AUDIENCE) {
    deny(res, "auth0_not_configured");
    return;
  }

  const header = req.header("authorization");
  if (!header || !header.startsWith("Bearer ")) {
    deny(res, "missing_bearer_token");
    return;
  }

  const token = header.slice("Bearer ".length).trim();
  if (!token) {
    deny(res, "missing_bearer_token");
    return;
  }

  const issuer = normalizeIssuer(env.AUTH0_ISSUER_BASE_URL);

  let payload: JWTPayload;
  try {
    const result = await jwtVerify(token, getJwks(issuer), {
      issuer,
      audience: env.AUTH0_AUDIENCE,
    });
    payload = result.payload;
  } catch {
    deny(res, "invalid_token");
    return;
  }

  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    deny(res, "missing_sub_claim");
    return;
  }

  const email =
    typeof payload.email === "string" && payload.email.length > 0
      ? payload.email
      : undefined;

  req.user = { sub: payload.sub, email };
  next();
}

export default requireAuth;
