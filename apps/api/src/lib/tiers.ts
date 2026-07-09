import { count, eq } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";

import { getDb } from "../db/client.js";
import { integrations, projects, subscriptions } from "../db/schema.js";
import { logSystem } from "./logging.js";

export type Tier = "free" | "pro";

/**
 * Free tier limits. Constants, not database-driven — change requires
 * a code deploy. Sprint 10+ may make these per-org configurable.
 */
export const FEATURE_LIMITS = {
  free: {
    max_integrations: 2,
    max_projects: 1,
    allowed_integration_types: ["sendgrid", "wordpress"] as const,
  },
  pro: {
    max_integrations: Infinity,
    max_projects: Infinity,
    allowed_integration_types: "all" as const,
  },
} as const;

type BlockedResult = {
  blocked: true;
  reason: string;
  current_tier: Tier;
  limit_hit: string;
};

/**
 * Gets the current tier for a user. If no subscription row exists,
 * creates one lazily with grandfathered Pro tier (safety net for the
 * bootstrap script edge cases).
 *
 * Callers should generally use this rather than reading subscriptions
 * directly, because it handles the "no row exists yet" case.
 */
export async function getTierForUser(userId: string): Promise<Tier> {
  const db = getDb();

  const existing = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId))
    .limit(1)
    .then((rows) => rows[0]);

  if (existing) {
    // Trust the DB row. Downgrade from Pro to Free happens on
    // subscription.deleted webhook, so if the row says pro, it's pro.
    return existing.tier as Tier;
  }

  // No row — lazy bootstrap this user to grandfathered Pro
  try {
    await db.insert(subscriptions).values({
      userId,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      tier: "pro",
      status: "active",
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
    });

    await logSystem("info", "tiers", "lazy_bootstrap_user_to_pro", {
      user_id: userId,
    });

    return "pro";
  } catch (err) {
    // If insert fails (race with bootstrap script, etc.), just default
    // to pro for safety — better to over-grant than block a real user
    // whose row we couldn't create.
    await logSystem(
      "warn",
      "tiers",
      "lazy_bootstrap_failed_defaulting_to_pro",
      {
        user_id: userId,
        error: (err as Error).message,
      },
    );
    return "pro";
  }
}

/**
 * Counts a user's current active integrations. Used by feature gate
 * middleware to check the max_integrations limit.
 */
export async function countUserIntegrations(userId: string): Promise<number> {
  const db = getDb();
  const result = await db
    .select({ count: count() })
    .from(integrations)
    .where(eq(integrations.userId, userId));
  return Number(result[0]?.count ?? 0);
}

/**
 * Counts a user's current projects. Projects are org-scoped but track their
 * author via created_by_user_id; v1 counts by creator (there is no per-user
 * `userId` column on projects).
 */
export async function countUserProjects(userId: string): Promise<number> {
  const db = getDb();
  const result = await db
    .select({ count: count() })
    .from(projects)
    .where(eq(projects.createdByUserId, userId));
  return Number(result[0]?.count ?? 0);
}

/**
 * Checks whether a user's current tier allows creating a new
 * integration of the given type. Returns null if allowed, or an
 * error object with actionable details if blocked.
 */
export async function checkCanCreateIntegration(
  userId: string,
  integrationType: string,
): Promise<BlockedResult | null> {
  const tier = await getTierForUser(userId);

  if (tier === "pro") return null; // Pro has no limits

  const freeLimits = FEATURE_LIMITS.free;

  // Check integration type allowlist
  if (
    !(freeLimits.allowed_integration_types as readonly string[]).includes(
      integrationType,
    )
  ) {
    return {
      blocked: true,
      reason: `Free tier only supports ${freeLimits.allowed_integration_types.join(", ")}. Upgrade to Pro to use ${integrationType}.`,
      current_tier: tier,
      limit_hit: "integration_type_not_allowed",
    };
  }

  // Check count limit
  const currentCount = await countUserIntegrations(userId);
  if (currentCount >= freeLimits.max_integrations) {
    return {
      blocked: true,
      reason: `Free tier is limited to ${freeLimits.max_integrations} integrations. You have ${currentCount}. Upgrade to Pro for unlimited.`,
      current_tier: tier,
      limit_hit: "max_integrations",
    };
  }

  return null;
}

/**
 * Checks whether a user's current tier allows creating a new project.
 */
export async function checkCanCreateProject(
  userId: string,
): Promise<BlockedResult | null> {
  const tier = await getTierForUser(userId);

  if (tier === "pro") return null;

  const freeLimits = FEATURE_LIMITS.free;

  const currentCount = await countUserProjects(userId);
  if (currentCount >= freeLimits.max_projects) {
    return {
      blocked: true,
      reason: `Free tier is limited to ${freeLimits.max_projects} project. You have ${currentCount}. Upgrade to Pro for unlimited.`,
      current_tier: tier,
      limit_hit: "max_projects",
    };
  }

  return null;
}

/**
 * Express middleware factory: requires the authenticated user to
 * be on the given tier or higher.
 *
 * Usage: app.post('/pro-only-route', requireAuth, requireHydratedUser,
 *   requireTier('pro'), handler);
 *
 * Assumes requireHydratedUser has already run and populated req.user.
 * Not applied to any route yet — reserved for future straight tier gates
 * (the count-based gates use checkCanCreate* directly in the handlers).
 */
export function requireTier(requiredTier: Tier) {
  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    const ctx = req.user;
    if (!ctx?.userId) {
      res.status(401).json({ error: "unauthenticated" });
      return;
    }

    const userTier = await getTierForUser(ctx.userId);

    // Tier ordering: free < pro
    const tierOrder: Record<Tier, number> = { free: 0, pro: 1 };

    if (tierOrder[userTier] < tierOrder[requiredTier]) {
      res.status(403).json({
        error: "tier_upgrade_required",
        message: `This action requires ${requiredTier} tier. You are on ${userTier}.`,
        current_tier: userTier,
        required_tier: requiredTier,
        upgrade_url: "/settings/billing",
      });
      return;
    }

    next();
  };
}
