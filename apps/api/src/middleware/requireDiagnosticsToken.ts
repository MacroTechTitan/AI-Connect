import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { env } from "../lib/env.js";

// Bearer-token auth for admin diagnostics. Constant-time compare to prevent
// timing attacks. Hashes both sides to SHA-256 so the comparison is over
// fixed-length buffers regardless of input length.
//
// Returns 401 on:
//   - DIAGNOSTICS_TOKEN env var not set (dev mode — endpoint stays locked)
//   - missing Authorization header
//   - header doesn't start with "Bearer "
//   - token doesn't match
//
// Never logs the provided token.
export function requireDiagnosticsToken(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const expected = env.DIAGNOSTICS_TOKEN;
  if (!expected) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const header = req.header("authorization");
  if (!header || !header.startsWith("Bearer ")) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const provided = header.slice("Bearer ".length);
  const expectedHash = createHash("sha256").update(expected).digest();
  const providedHash = createHash("sha256").update(provided).digest();

  if (!timingSafeEqual(expectedHash, providedHash)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  next();
}

export default requireDiagnosticsToken;
