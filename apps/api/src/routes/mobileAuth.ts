// Mobile auth broker for the Life Hack Protocol app.
//
//   POST /api/mobile/lhp/login     { username, password }  -> token + membership
//   POST /api/mobile/lhp/validate  { token }               -> current membership
//
// These are PUBLIC (no Auth0 user) — the caller is a WordPress member logging in
// through the app, not an AI Connect user. Trust comes from the credentials on
// login and the AI-Connect-signed token on validate. The app never sees the
// WordPress plugin token or any MemberPress key: AI Connect brokers everything
// server-to-server via the ai-connect WordPress plugin. See docs/MOBILE_AUTH.md.

import type { Express, Request, Response } from "express";
import rateLimit from "express-rate-limit";

import { env } from "../lib/env.js";
import { logSystem } from "../lib/logging.js";
import {
  lhpAuthClient,
  LhpAuthClientError,
} from "../lib/integrations/lhpAuthClient.js";
import {
  getLhpSiteConfig,
  MobileConfigError,
} from "../lib/mobile/lhpSiteConfig.js";
import {
  signMobileToken,
  verifyMobileToken,
  membershipIsStale,
  type MobileTokenClaims,
} from "../lib/mobile/mobileToken.js";

const MAX_USERNAME_CHARS = 256;
const MAX_PASSWORD_CHARS = 256;
const MAX_TOKEN_CHARS = 4096;

// One generic sentence for every login failure — no user enumeration.
const GENERIC_LOGIN_FAILURE = "Incorrect username or password.";

/**
 * Per-IP limiter on login: throttles credential-stuffing without needing user
 * state. trust proxy is set in index.ts, so the client IP is the real one.
 */
const loginLimiter = rateLimit({
  windowMs: 15 * 60_000, // 15 min
  limit: 10, // 10 login attempts per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req: Request, res: Response) => {
    res.status(429).json({
      error: "too_many_requests",
      message: "Too many login attempts. Try again later.",
    });
  },
});

/** Looser limiter on validate — it's the app's regular refresh heartbeat. */
const validateLimiter = rateLimit({
  windowMs: 5 * 60_000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req: Request, res: Response) => {
    res.status(429).json({
      error: "too_many_requests",
      message: "Too many requests. Try again later.",
    });
  },
});

function getSigningKey(res: Response): string | null {
  const key = env.MOBILE_JWT_SIGNING_KEY;
  if (!key) {
    // Config invariant, not a client error.
    res.status(500).json({ error: "mobile_broker_not_configured" });
    return null;
  }
  return key;
}

/** Best-effort audit line. Never logs the password; usernames are truncated. */
function auditLogin(outcome: string, username: string, active?: boolean): void {
  void logSystem("info", "mobile_auth", `login_${outcome}`, {
    username_len: username.length,
    active: active ?? null,
  });
}

async function handleLogin(req: Request, res: Response): Promise<void> {
  const signingKey = getSigningKey(res);
  if (!signingKey) return;

  const body = (req.body ?? {}) as Record<string, unknown>;
  const username = body.username;
  const password = body.password;

  if (
    typeof username !== "string" ||
    typeof password !== "string" ||
    username.length < 1 ||
    username.length > MAX_USERNAME_CHARS ||
    password.length < 1 ||
    password.length > MAX_PASSWORD_CHARS
  ) {
    // Shape errors get the SAME generic 401 as a wrong password, so a caller
    // can't probe the boundary between "malformed" and "wrong".
    res.status(401).json({ error: "invalid_credentials", message: GENERIC_LOGIN_FAILURE });
    return;
  }

  let config;
  try {
    config = await getLhpSiteConfig();
  } catch (err) {
    if (err instanceof MobileConfigError) {
      res.status(500).json({ error: "mobile_broker_not_configured" });
      return;
    }
    throw err;
  }

  let membership;
  try {
    membership = await lhpAuthClient.validateLogin(
      config.siteUrl,
      config.token,
      username,
      password,
    );
  } catch (err) {
    if (err instanceof LhpAuthClientError) {
      if (err.code === "invalid_credentials") {
        auditLogin("failed", username);
        res
          .status(401)
          .json({ error: "invalid_credentials", message: GENERIC_LOGIN_FAILURE });
        return;
      }
      // Token misconfig / plugin missing / upstream down — a server problem.
      auditLogin("upstream_error", username);
      res.status(502).json({ error: "upstream_error", reason: err.message });
      return;
    }
    throw err;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const claims: MobileTokenClaims = {
    userId: membership.user.id,
    email: membership.user.email,
    displayName: membership.user.display_name,
    tiers: membership.tiers,
    active: membership.active,
    membershipCheckedAt: nowSeconds,
  };

  const token = await signMobileToken(claims, signingKey);
  auditLogin("ok", username, membership.active);

  res.status(200).json({
    token,
    membership: { active: membership.active, tiers: membership.tiers },
    user: { email: membership.user.email, displayName: membership.user.display_name },
  });
}

async function handleValidate(req: Request, res: Response): Promise<void> {
  const signingKey = getSigningKey(res);
  if (!signingKey) return;

  const body = (req.body ?? {}) as Record<string, unknown>;
  const token = body.token;
  if (typeof token !== "string" || token.length < 1 || token.length > MAX_TOKEN_CHARS) {
    res.status(401).json({ error: "invalid_token" });
    return;
  }

  const verified = await verifyMobileToken(token, signingKey);
  if (!verified.ok) {
    res.status(401).json({ error: verified.reason === "expired" ? "token_expired" : "invalid_token" });
    return;
  }

  const claims = verified.claims;
  const nowSeconds = Math.floor(Date.now() / 1000);

  // Fresh enough: refresh the access-token lifetime without re-hitting WordPress.
  if (!membershipIsStale(claims.membershipCheckedAt, nowSeconds)) {
    const refreshed = await signMobileToken(claims, signingKey);
    res.status(200).json({
      token: refreshed,
      membership: { active: claims.active, tiers: claims.tiers },
    });
    return;
  }

  // Stale: re-read MemberPress so a revoked/expired membership stops lingering.
  let config;
  try {
    config = await getLhpSiteConfig();
  } catch (err) {
    if (err instanceof MobileConfigError) {
      res.status(500).json({ error: "mobile_broker_not_configured" });
      return;
    }
    throw err;
  }

  let membership;
  try {
    membership = await lhpAuthClient.membershipStatus(
      config.siteUrl,
      config.token,
      claims.userId,
    );
  } catch (err) {
    if (err instanceof LhpAuthClientError) {
      res.status(502).json({ error: "upstream_error", reason: err.message });
      return;
    }
    throw err;
  }

  const nextClaims: MobileTokenClaims = {
    userId: claims.userId,
    email: membership.user.email ?? claims.email,
    displayName: membership.user.display_name ?? claims.displayName,
    tiers: membership.tiers,
    active: membership.active,
    membershipCheckedAt: nowSeconds,
  };
  const refreshed = await signMobileToken(nextClaims, signingKey);

  res.status(200).json({
    token: refreshed,
    membership: { active: membership.active, tiers: membership.tiers },
  });
}

export function registerMobileAuthRoutes(app: Express): void {
  app.post("/api/mobile/lhp/login", loginLimiter, handleLogin);
  app.post("/api/mobile/lhp/validate", validateLimiter, handleValidate);
}
