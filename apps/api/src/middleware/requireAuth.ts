import type { NextFunction, Request, Response } from "express";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { env } from "../lib/env.js";
import {
  getUserOrgContext,
  type AuthedUserContext,
} from "../lib/orgScope.js";

// Raw JWT identity attached to every authenticated request. Always present
// after requireAuth resolves successfully — does NOT depend on a DB lookup.
export interface JwtAuthContext {
  sub: string;
  email: string | undefined;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      // Set by requireAuth on every successful JWT verification.
      jwt?: JwtAuthContext;
      // Set by requireAuth ONLY when the user row exists in the DB. Routes
      // that need a hydrated context use requireHydratedUser to assert this.
      // /api/me deliberately tolerates this being undefined so it can lazily
      // create the user row on first sign-in.
      user?: AuthedUserContext;
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

  // Auth0 access tokens don't include the bare `email` claim by default —
  // it lives on ID tokens. The Post Login Auth0 Action adds a namespaced
  // custom claim (https://aiconnect.macrotechtitan.com/email) onto access
  // tokens. We read that first; the bare `email` is a fallback in case
  // future SDK config starts attaching it directly. If neither is present
  // /api/me will return 400 "email claim missing" as documented.
  const emailSources = [
    payload["https://aiconnect.macrotechtitan.com/email"],
    payload.email,
  ];
  const email = emailSources.find(
    (v): v is string => typeof v === "string" && v.length > 0,
  );

  req.jwt = { sub: payload.sub, email };

  // Attempt to hydrate the user from the DB. If the row exists, attach the
  // full AuthedUserContext. If not (first /api/me hit, or a DB hiccup),
  // leave req.user undefined and let downstream middleware/handlers decide.
  if (email) {
    try {
      const ctx = await getUserOrgContext(email);
      if (ctx) req.user = ctx;
    } catch {
      // Swallow — we still want the request to proceed for routes that
      // can work from req.jwt alone. requireHydratedUser will 401 anything
      // that needs the hydrated context.
    }
  }

  next();
}

// Asserts the request has a hydrated AuthedUserContext on req.user. Use
// this after requireAuth on every route that touches user/org-scoped data.
// /api/me deliberately does NOT use it — it needs to handle the no-user-yet
// case to support first sign-in.
export function requireHydratedUser(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!req.user) {
    res
      .status(401)
      .json({ error: "unauthorized", reason: "user_not_hydrated" });
    return;
  }
  next();
}

export default requireAuth;
