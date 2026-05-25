import { eq } from "drizzle-orm";
import type { Express, Request, Response } from "express";
import { getDb } from "../db/client.js";
import { users } from "../db/schema.js";
import { logUserAction } from "../lib/logging.js";
import { requireAuth } from "../middleware/requireAuth.js";

const userProjection = {
  id: users.id,
  email: users.email,
  role: users.role,
  createdAt: users.createdAt,
  lastSeenAt: users.lastSeenAt,
} as const;

async function handleMe(req: Request, res: Response): Promise<void> {
  // requireAuth always sets req.user before reaching here; the optional
  // access keeps TypeScript happy without an `!` non-null assertion.
  const auth = req.user;
  if (!auth) {
    res.status(401).json({ error: "unauthorized", reason: "no_user_context" });
    return;
  }
  if (!auth.email) {
    res.status(400).json({ error: "email claim missing" });
    return;
  }

  const email = auth.email;
  const db = getDb();

  // Race-safe upsert: INSERT ... ON CONFLICT (email) DO NOTHING followed by
  // an UPDATE for the existing-row branch. Wrapped in a transaction so both
  // statements see the same snapshot of the table.
  const { user, created } = await db.transaction(async (tx) => {
    const now = new Date();
    const [insertedRow] = await tx
      .insert(users)
      .values({ email, role: "user", lastSeenAt: now })
      .onConflictDoNothing({ target: users.email })
      .returning(userProjection);

    if (insertedRow) {
      return { user: insertedRow, created: true as const };
    }

    const [updatedRow] = await tx
      .update(users)
      .set({ lastSeenAt: now })
      .where(eq(users.email, email))
      .returning(userProjection);

    if (!updatedRow) {
      // Pathological: row vanished between the failed insert and the update.
      throw new Error("user row disappeared during upsert");
    }
    return { user: updatedRow, created: false as const };
  });

  if (created) {
    // logUserAction swallows its own errors and never throws — safe to await.
    // Runs outside the upsert transaction so a logging-table hiccup can't
    // roll back a successful user creation.
    await logUserAction(user.id, "first_login_create_user", "user", user.id);
  }

  res.status(200).json(user);
}

export function registerMeRoutes(app: Express): void {
  app.get("/api/me", requireAuth, handleMe);
}
