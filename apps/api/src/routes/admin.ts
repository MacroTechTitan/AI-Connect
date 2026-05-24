import type { Express, Request, Response } from "express";
import { getPool } from "../db/client.js";
import { env } from "../lib/env.js";
import { requireDiagnosticsToken } from "../middleware/requireDiagnosticsToken.js";

const DB_REACHABLE_TIMEOUT_MS = 2000;

// SELECT 1 with a hard 2s ceiling. If the DB hangs, we still answer the
// diagnostic request — that's the whole point of this endpoint.
async function checkDbReachable(): Promise<boolean> {
  if (!env.DATABASE_URL) return false;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      getPool().query("SELECT 1"),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("db_reachable_timeout")),
          DB_REACHABLE_TIMEOUT_MS,
        );
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function handleDiagnostics(_req: Request, res: Response): Promise<void> {
  const reachable = await checkDbReachable();
  res.status(200).json({
    service: "ai-connect-api",
    version: process.env.npm_package_version ?? "0.0.0",
    timestamp: new Date().toISOString(),
    node: process.version,
    uptimeSeconds: Math.floor(process.uptime()),
    // Boolean presence only. Never leak secret values.
    env: {
      DATABASE_URL: Boolean(env.DATABASE_URL),
      AUTH0_ISSUER_BASE_URL: Boolean(env.AUTH0_ISSUER_BASE_URL),
      AUTH0_AUDIENCE: Boolean(env.AUTH0_AUDIENCE),
      MASTER_KEY: Boolean(env.MASTER_KEY),
      DIAGNOSTICS_TOKEN: Boolean(env.DIAGNOSTICS_TOKEN),
      ADMIN_EMAIL: Boolean(env.ADMIN_EMAIL),
    },
    db: {
      configured: Boolean(env.DATABASE_URL),
      reachable,
    },
  });
}

export function registerAdminRoutes(app: Express): void {
  app.get(
    "/api/admin/diagnostics",
    requireDiagnosticsToken,
    handleDiagnostics,
  );
}
