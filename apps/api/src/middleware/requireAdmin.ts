import { eq } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";

import { getDb } from "../db/client.js";
import { users } from "../db/schema.js";
import { logSystem } from "../lib/logging.js";

/**
 * Requires the authenticated user to have is_admin=true (migration 0013).
 * Runs AFTER requireAuth + requireHydratedUser, so req.user is populated.
 *
 * Non-admins receive 403 with { error: 'admin_required' }. Access attempts
 * (both success and failure) are audit-logged for observability.
 */
export async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const user = req.user;
  if (!user?.userId) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }

  const [row] = await getDb()
    .select({ isAdmin: users.isAdmin })
    .from(users)
    .where(eq(users.id, user.userId))
    .limit(1);

  if (!row?.isAdmin) {
    await logSystem("warn", "admin", "unauthorized_admin_access", {
      user_id: user.userId,
      path: req.path,
      method: req.method,
    });
    res.status(403).json({
      error: "admin_required",
      message: "This action requires admin privileges.",
    });
    return;
  }

  await logSystem("info", "admin", "admin_access", {
    user_id: user.userId,
    path: req.path,
    method: req.method,
  });

  next();
}
