import { getDb } from "../db/client.js";
import { users } from "../db/schema.js";
import { env } from "./env.js";

// Idempotent admin seed. Safe to call on every boot — ON CONFLICT (email)
// DO NOTHING means this is a no-op once the row exists.
//
// Skips silently when DATABASE_URL is unset so dev without a DB can still boot.
export async function seedAdmin(): Promise<void> {
  if (!env.DATABASE_URL) return;

  await getDb()
    .insert(users)
    .values({ email: env.ADMIN_EMAIL, role: "admin" })
    .onConflictDoNothing({ target: users.email });
}
