/**
 * Bootstrap script: grandfather all existing users to Pro tier.
 *
 * Run once at Sprint 9 deploy time. Idempotent — running multiple
 * times has no effect after the first run.
 *
 * Usage: pnpm --filter @ai-connect/api tsx src/scripts/bootstrapSubscriptions.ts
 */

import { notInArray } from "drizzle-orm";

import { getDb } from "../db/client.js";
import { subscriptions, users } from "../db/schema.js";
import { logSystem } from "../lib/logging.js";

async function bootstrapSubscriptions(): Promise<void> {
  const db = getDb();

  // Find all users without a subscription row
  const usersWithSubs = await db
    .select({ userId: subscriptions.userId })
    .from(subscriptions);

  const existingSubUserIds = usersWithSubs.map((s) => s.userId);

  const usersToBootstrap =
    existingSubUserIds.length > 0
      ? await db
          .select({ id: users.id })
          .from(users)
          .where(notInArray(users.id, existingSubUserIds))
      : await db.select({ id: users.id }).from(users);

  if (usersToBootstrap.length === 0) {
    console.log(
      "No users need bootstrapping. All users have subscription rows.",
    );
    return;
  }

  console.log(`Bootstrapping ${usersToBootstrap.length} users to Pro tier...`);

  // Insert Pro subscription rows for all users without one.
  // Grandfathered users have:
  // - tier='pro', status='active'
  // - stripe_customer_id=null, stripe_subscription_id=null
  //   (they don't have Stripe records; they're not paying)
  // - current_period_end=null (indefinite Pro access)

  const values = usersToBootstrap.map((u) => ({
    userId: u.id,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    tier: "pro" as const,
    status: "active" as const,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
  }));

  await db.insert(subscriptions).values(values);

  await logSystem("info", "bootstrap", "grandfathered_users_to_pro", {
    user_count: usersToBootstrap.length,
  });

  console.log(`Bootstrapped ${usersToBootstrap.length} users to Pro.`);
}

bootstrapSubscriptions()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Bootstrap failed:", err);
    process.exit(1);
  });
