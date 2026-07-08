import { eq } from "drizzle-orm";
import type { Express, Request, Response } from "express";

import { getDb } from "../db/client.js";
import { subscriptions } from "../db/schema.js";
import { env } from "../lib/env.js";
import {
  StripeError,
  stripeStandardClient,
} from "../lib/integrations/stripeClient.js";
import { logSystem } from "../lib/logging.js";
import type { AuthedUserContext } from "../lib/orgScope.js";
import { getTierForUser } from "../lib/tiers.js";
import {
  requireAuth,
  requireHydratedUser,
} from "../middleware/requireAuth.js";

/**
 * Subscription management routes for AI Connect's paid tier (Stripe Standard).
 */

// The frontend origin used to build Stripe success/cancel/return URLs. Prefer
// the request's Origin header (works for localhost + preview deploys); fall
// back to the production web app URL. There is no dedicated env var for this.
const DEFAULT_WEB_APP_URL = "https://aiconnect.macrotechtitan.com";

function resolveOrigin(req: Request): string {
  const origin = req.headers.origin;
  return typeof origin === "string" && origin.length > 0
    ? origin
    : DEFAULT_WEB_APP_URL;
}

// req.user is guaranteed by requireHydratedUser; this just narrows the type.
function getCtx(req: Request): AuthedUserContext {
  return req.user!;
}

// Maps a StripeError to an HTTP status. Anything non-StripeError is rethrown
// for the global handler (matches handleAuth0Error / handleWordPressError).
function handleStripeError(err: unknown, res: Response): void {
  if (err instanceof StripeError) {
    const statusByCode: Record<string, number> = {
      invalid_credentials: 500, // config problem, not user's fault
      account_not_found: 404,
      subscription_not_found: 404,
      customer_not_found: 404,
      charge_failed: 402,
      rate_limited: 429,
      invalid_request: 400,
      api_error: 502,
      network_error: 502,
    };
    const status = statusByCode[err.code] ?? 502;
    res.status(status).json({
      error: err.code,
      message: err.message,
    });
    return;
  }
  throw err;
}

/**
 * POST /api/subscription/checkout
 *
 * Creates a Stripe Checkout Session for Pro tier upgrade.
 * Returns { url } — frontend redirects browser to it.
 *
 * Idempotent per user via customer reuse: existing Stripe Customer
 * for the user is reused if one exists, otherwise created.
 *
 * Users already on paid Pro get 409 (should upgrade UI to send them to
 * portal instead of checkout). Grandfathered Pro users (no Stripe
 * subscription) fall through and CAN check out to convert to paying.
 */
async function handleCreateCheckout(
  req: Request,
  res: Response,
): Promise<void> {
  const ctx = getCtx(req);

  try {
    // Reject if user is already on real paid Pro (they should use portal).
    const currentTier = await getTierForUser(ctx.userId);
    if (currentTier === "pro") {
      const db = getDb();
      const sub = await db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.userId, ctx.userId))
        .limit(1)
        .then((rows) => rows[0]);

      if (sub?.stripeSubscriptionId) {
        // Real paying Pro user — send them to portal
        res.status(409).json({
          error: "already_subscribed",
          message:
            "You already have an active Pro subscription. Use the customer portal to manage it.",
          portal_url: "/api/subscription/portal",
        });
        return;
      }
      // Grandfathered Pro — allow them to convert to paying if they want
      // (falls through to checkout below).
    }

    if (!env.STRIPE_PRO_PRICE_ID) {
      res.status(500).json({
        error: "stripe_not_configured",
        message:
          "STRIPE_PRO_PRICE_ID is not set. Configure it in environment variables.",
      });
      return;
    }

    // Get or create the Stripe Customer for this user
    const customer = await stripeStandardClient.getOrCreateCustomer(
      ctx.email,
      ctx.userId,
    );

    // Persist customer ID if we don't have it yet
    const db = getDb();
    const existingSub = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.userId, ctx.userId))
      .limit(1)
      .then((rows) => rows[0]);

    if (existingSub && !existingSub.stripeCustomerId) {
      await db
        .update(subscriptions)
        .set({ stripeCustomerId: customer.id, updatedAt: new Date() })
        .where(eq(subscriptions.userId, ctx.userId));
    }

    // Build success/cancel URLs based on request origin
    const origin = resolveOrigin(req);

    const session = await stripeStandardClient.createCheckoutSession({
      customerId: customer.id,
      priceId: env.STRIPE_PRO_PRICE_ID,
      successUrl: `${origin}/settings/billing?session_id={CHECKOUT_SESSION_ID}&result=success`,
      cancelUrl: `${origin}/settings/billing?result=canceled`,
      userId: ctx.userId,
    });

    if (!session.url) {
      res.status(502).json({
        error: "checkout_session_no_url",
        message: "Stripe returned a checkout session without a URL.",
      });
      return;
    }

    await logSystem("info", "subscription", "checkout_session_created", {
      user_id: ctx.userId,
      customer_id: customer.id,
      session_id: session.id,
    });

    res.json({ url: session.url });
  } catch (err) {
    handleStripeError(err, res);
  }
}

/**
 * POST /api/subscription/portal
 *
 * Creates a Stripe Customer Portal session. Returns { url } — frontend
 * redirects browser to it.
 *
 * User must have a Stripe Customer ID on file (either they've been to
 * checkout, or their subscription row's stripe_customer_id is set).
 */
async function handleCreatePortal(req: Request, res: Response): Promise<void> {
  const ctx = getCtx(req);

  try {
    const db = getDb();
    const sub = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.userId, ctx.userId))
      .limit(1)
      .then((rows) => rows[0]);

    if (!sub?.stripeCustomerId) {
      res.status(404).json({
        error: "no_stripe_customer",
        message: "No Stripe customer on file. Complete a checkout first.",
      });
      return;
    }

    const origin = resolveOrigin(req);

    const session = await stripeStandardClient.createCustomerPortalSession({
      customerId: sub.stripeCustomerId,
      returnUrl: `${origin}/settings/billing`,
    });

    await logSystem("info", "subscription", "portal_session_created", {
      user_id: ctx.userId,
      customer_id: sub.stripeCustomerId,
    });

    res.json({ url: session.url });
  } catch (err) {
    handleStripeError(err, res);
  }
}

/**
 * GET /api/subscription
 *
 * Returns the current user's subscription details.
 *
 * Response shape:
 * {
 *   tier: 'free' | 'pro',
 *   status: 'active' | 'past_due' | 'canceled' | 'incomplete' | 'trialing',
 *   current_period_end: ISO string | null,
 *   cancel_at_period_end: boolean,
 *   is_grandfathered: boolean,  // pro without stripe subscription
 *   has_stripe_customer: boolean,  // whether portal is available
 * }
 */
async function handleGetSubscription(
  req: Request,
  res: Response,
): Promise<void> {
  const ctx = getCtx(req);

  // Ensure user has a subscription row (lazy bootstrap if needed)
  await getTierForUser(ctx.userId);

  const db = getDb();
  const sub = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.userId, ctx.userId))
    .limit(1)
    .then((rows) => rows[0]);

  if (!sub) {
    // Shouldn't happen after getTierForUser call, but defensive
    res.status(500).json({
      error: "no_subscription_row",
      message:
        "Subscription bootstrap failed. Please try again or contact support.",
    });
    return;
  }

  res.json({
    tier: sub.tier,
    status: sub.status,
    current_period_end: sub.currentPeriodEnd?.toISOString() ?? null,
    cancel_at_period_end: sub.cancelAtPeriodEnd,
    is_grandfathered: sub.tier === "pro" && !sub.stripeSubscriptionId,
    has_stripe_customer: !!sub.stripeCustomerId,
  });
}

/**
 * POST /api/subscription/cancel
 *
 * Schedules the user's Pro subscription for cancellation at period end.
 * Sets cancel_at_period_end=true on the Stripe subscription.
 *
 * The webhook customer.subscription.updated then syncs our row.
 * The webhook customer.subscription.deleted fires at period end and
 * downgrades tier to 'free'.
 *
 * Grandfathered users have no Stripe subscription to cancel — return
 * 400. (They can just... not use Pro features. There's nothing to
 * cancel.)
 */
async function handleCancelSubscription(
  req: Request,
  res: Response,
): Promise<void> {
  const ctx = getCtx(req);

  try {
    const db = getDb();
    const sub = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.userId, ctx.userId))
      .limit(1)
      .then((rows) => rows[0]);

    if (!sub) {
      res.status(404).json({
        error: "no_subscription",
        message: "No subscription found.",
      });
      return;
    }

    if (!sub.stripeSubscriptionId) {
      res.status(400).json({
        error: "no_stripe_subscription",
        message:
          sub.tier === "pro"
            ? "You have grandfathered Pro access, not a paid subscription. There is nothing to cancel."
            : "You are on the Free tier. There is nothing to cancel.",
      });
      return;
    }

    // Cancel at period end (default true — user keeps access through end of paid period)
    const canceledSub = await stripeStandardClient.cancelSubscription(
      sub.stripeSubscriptionId,
      true,
    );

    // Optimistically update our row; webhook customer.subscription.updated will confirm
    await db
      .update(subscriptions)
      .set({
        cancelAtPeriodEnd: true,
        updatedAt: new Date(),
      })
      .where(eq(subscriptions.userId, ctx.userId));

    const periodEnd = canceledSub.items.data[0]?.current_period_end
      ? new Date(
          canceledSub.items.data[0].current_period_end * 1000,
        ).toISOString()
      : null;

    await logSystem("info", "subscription", "cancellation_scheduled", {
      user_id: ctx.userId,
      subscription_id: sub.stripeSubscriptionId,
      period_end: periodEnd,
    });

    res.json({
      success: true,
      cancel_at_period_end: true,
      current_period_end: periodEnd,
    });
  } catch (err) {
    handleStripeError(err, res);
  }
}

// ============================================================
// Route registration
// ============================================================

export function registerSubscriptionRoutes(app: Express): void {
  app.post(
    "/api/subscription/checkout",
    requireAuth,
    requireHydratedUser,
    handleCreateCheckout,
  );
  app.post(
    "/api/subscription/portal",
    requireAuth,
    requireHydratedUser,
    handleCreatePortal,
  );
  app.get(
    "/api/subscription",
    requireAuth,
    requireHydratedUser,
    handleGetSubscription,
  );
  app.post(
    "/api/subscription/cancel",
    requireAuth,
    requireHydratedUser,
    handleCancelSubscription,
  );
}
