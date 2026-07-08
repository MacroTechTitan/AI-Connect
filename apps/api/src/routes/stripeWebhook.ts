import { eq } from "drizzle-orm";
import express, { type Express, type Request, type Response } from "express";
import type Stripe from "stripe";

import { getDb } from "../db/client.js";
import { stripeWebhookEvents, subscriptions } from "../db/schema.js";
import {
  StripeError,
  stripeStandardClient,
} from "../lib/integrations/stripeClient.js";
import { logSystem } from "../lib/logging.js";

// node-postgres surfaces a unique_violation (PK conflict) as error.code
// "23505". For the webhook table the PK is Stripe's event.id, so a 23505 on
// INSERT means Stripe re-delivered an event we already recorded.
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "23505"
  );
}

// Stripe SDK v18+ removed `current_period_end` from the Subscription object and
// moved it onto each SubscriptionItem. Our Pro tier is a single-item
// subscription, so all items share one period; read it off the first item.
// Returns a JS Date (Stripe timestamps are Unix seconds) or null if absent.
function periodEndFromSubscription(
  subscription: Stripe.Subscription,
): Date | null {
  const seconds = subscription.items.data[0]?.current_period_end;
  return typeof seconds === "number" ? new Date(seconds * 1000) : null;
}

// Our subscriptions.status CHECK constraint only allows these five values.
// Stripe's Subscription.Status has more (incomplete_expired, unpaid, paused);
// anything outside our set collapses to 'active' so the write never violates
// the constraint.
const OUR_STATUSES = [
  "active",
  "past_due",
  "canceled",
  "incomplete",
  "trialing",
] as const;

function mapStripeStatus(status: string): (typeof OUR_STATUSES)[number] {
  return (OUR_STATUSES as readonly string[]).includes(status)
    ? (status as (typeof OUR_STATUSES)[number])
    : "active";
}

/**
 * Stripe webhook handler.
 *
 * Flow:
 * 1. Verify signature (throws if invalid → 400 response)
 * 2. Insert event into stripe_webhook_events; PK conflict = duplicate, skip
 * 3. Route event to appropriate handler based on event.type
 * 4. On handler success: update processed=true, processed_at=now()
 * 5. On handler failure: log processing_error, return 500 so Stripe retries
 *
 * IMPORTANT: This route is mounted with express.raw() middleware, so
 * req.body is a Buffer, not a parsed object. Do NOT try to access
 * fields on req.body directly — use it as the raw payload for
 * signature verification, then read parsed fields from event.data.
 */
export async function handleStripeWebhook(
  req: Request,
  res: Response,
): Promise<void> {
  const signature = req.headers["stripe-signature"];
  if (!signature || typeof signature !== "string") {
    res.status(400).json({
      error: "missing_signature",
      message: "stripe-signature header is required",
    });
    return;
  }

  // Step 1: Verify signature
  let event: Stripe.Event;
  try {
    // req.body is a Buffer because of express.raw() middleware
    event = stripeStandardClient.constructWebhookEvent(req.body, signature);
  } catch (err) {
    const message =
      err instanceof StripeError ? err.message : (err as Error).message;
    await logSystem(
      "warn",
      "stripe_webhook",
      "signature_verification_failed",
      {
        error: message,
        signature_header_present: true,
      },
    );
    res.status(400).json({ error: "invalid_signature", message });
    return;
  }

  // Step 2: Idempotency — insert or detect duplicate
  const db = getDb();
  let isDuplicate = false;
  try {
    await db.insert(stripeWebhookEvents).values({
      id: event.id,
      eventType: event.type,
      payload: event as unknown as Record<string, unknown>,
      processed: false,
    });
  } catch (err) {
    // PK conflict = duplicate. Any other error is a real DB failure.
    if (isUniqueViolation(err)) {
      isDuplicate = true;
    } else {
      await logSystem("error", "stripe_webhook", "db_insert_failed", {
        event_id: event.id,
        event_type: event.type,
        error: (err as Error).message ?? "",
      });
      res
        .status(500)
        .json({ error: "db_error", message: "Failed to record webhook event" });
      return;
    }
  }

  if (isDuplicate) {
    // Already recorded (and possibly already processed). Return 200
    // so Stripe stops retrying. This is safe because either:
    // (a) the previous processing succeeded, or
    // (b) it failed and Stripe already got a 500 and retried;
    //     we're now on that retry. The first attempt's row is
    //     the source of truth for processed state.
    await logSystem("info", "stripe_webhook", "duplicate_event_skipped", {
      event_id: event.id,
      event_type: event.type,
    });
    res.status(200).json({ received: true, duplicate: true });
    return;
  }

  // Step 3: Route to handler
  try {
    await routeStripeEvent(event);

    // Step 4: Mark processed
    await db
      .update(stripeWebhookEvents)
      .set({ processed: true, processedAt: new Date() })
      .where(eq(stripeWebhookEvents.id, event.id));

    await logSystem("info", "stripe_webhook", "event_processed", {
      event_id: event.id,
      event_type: event.type,
    });

    res.status(200).json({ received: true });
  } catch (err) {
    // Step 5: Log error but don't crash. Return 500 so Stripe retries.
    // Next retry will find the row already exists (isDuplicate=true) and skip.
    // We're accepting one retry per failure; longer-term we'd want retry
    // logic with backoff, but that's Sprint 10+.
    const errMsg = (err as Error).message ?? "Unknown error";
    await db
      .update(stripeWebhookEvents)
      .set({ processingError: errMsg })
      .where(eq(stripeWebhookEvents.id, event.id));

    await logSystem("error", "stripe_webhook", "handler_failed", {
      event_id: event.id,
      event_type: event.type,
      error: errMsg,
    });

    res.status(500).json({ error: "handler_failed", message: errMsg });
  }
}

/**
 * Routes a Stripe event to the appropriate handler based on event.type.
 * Unknown event types are logged and treated as no-op (return 200 to Stripe).
 */
async function routeStripeEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    // ============================================================
    // Stripe Standard events (AI Connect's paid tier billing)
    // ============================================================
    case "checkout.session.completed":
      await handleCheckoutSessionCompleted(
        event.data.object as Stripe.Checkout.Session,
      );
      break;

    case "customer.subscription.updated":
      await handleSubscriptionUpdated(
        event.data.object as Stripe.Subscription,
      );
      break;

    case "customer.subscription.deleted":
      await handleSubscriptionDeleted(
        event.data.object as Stripe.Subscription,
      );
      break;

    case "invoice.payment_failed":
      await handleInvoicePaymentFailed(event.data.object as Stripe.Invoice);
      break;

    // ============================================================
    // Stripe Connect events — Commit 6 wires these up
    // ============================================================
    case "account.updated":
      // Commit 6: handleAccountUpdated
      await logSystem(
        "info",
        "stripe_webhook",
        "account_updated_not_yet_handled",
        {
          event_id: event.id,
        },
      );
      break;

    default:
      await logSystem("info", "stripe_webhook", "unhandled_event_type", {
        event_id: event.id,
        event_type: event.type,
      });
  }
}

// ============================================================
// Stripe Standard event handlers
// ============================================================

/**
 * checkout.session.completed:
 * Fires when a user completes Stripe Checkout for a subscription.
 * The Checkout Session has:
 * - client_reference_id → our ai_connect_user_id
 * - customer → Stripe Customer ID
 * - subscription → Stripe Subscription ID
 *
 * Action: upsert subscriptions row for the user. Set tier='pro',
 * status='active', stripe_customer_id, stripe_subscription_id.
 */
async function handleCheckoutSessionCompleted(
  session: Stripe.Checkout.Session,
): Promise<void> {
  const userId =
    session.client_reference_id ?? session.metadata?.ai_connect_user_id;
  if (!userId) {
    throw new Error(
      `checkout.session.completed missing client_reference_id and metadata.ai_connect_user_id (session ${session.id})`,
    );
  }

  const customerId =
    typeof session.customer === "string"
      ? session.customer
      : session.customer?.id;
  const subscriptionId =
    typeof session.subscription === "string"
      ? session.subscription
      : session.subscription?.id;

  if (!customerId) {
    throw new Error(
      `checkout.session.completed missing customer (session ${session.id})`,
    );
  }
  if (!subscriptionId) {
    throw new Error(
      `checkout.session.completed missing subscription (session ${session.id})`,
    );
  }

  // Fetch subscription details for current_period_end
  const subscription =
    await stripeStandardClient.getSubscription(subscriptionId);

  const db = getDb();

  // Upsert: try update first, insert if no row exists
  const existing = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId))
    .limit(1)
    .then((rows) => rows[0]);

  if (existing) {
    await db
      .update(subscriptions)
      .set({
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscriptionId,
        tier: "pro",
        status: "active",
        currentPeriodEnd: periodEndFromSubscription(subscription),
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
        updatedAt: new Date(),
      })
      .where(eq(subscriptions.userId, userId));
  } else {
    await db.insert(subscriptions).values({
      userId,
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscriptionId,
      tier: "pro",
      status: "active",
      currentPeriodEnd: periodEndFromSubscription(subscription),
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
    });
  }
}

/**
 * customer.subscription.updated:
 * Fires when a subscription changes (plan change, cancellation scheduled,
 * payment method updated, etc.). Sync current_period_end, status, and
 * cancel_at_period_end.
 */
async function handleSubscriptionUpdated(
  subscription: Stripe.Subscription,
): Promise<void> {
  const db = getDb();

  const existing = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.stripeSubscriptionId, subscription.id))
    .limit(1)
    .then((rows) => rows[0]);

  if (!existing) {
    // Subscription not in our DB yet. This can happen if the
    // subscription was created outside of our checkout flow. Log
    // and skip — the checkout.session.completed for this sub should
    // eventually arrive and create the row.
    await logSystem(
      "info",
      "stripe_webhook",
      "subscription_updated_no_local_row",
      {
        stripe_subscription_id: subscription.id,
      },
    );
    return;
  }

  await db
    .update(subscriptions)
    .set({
      status: mapStripeStatus(subscription.status),
      currentPeriodEnd: periodEndFromSubscription(subscription),
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      updatedAt: new Date(),
    })
    .where(eq(subscriptions.stripeSubscriptionId, subscription.id));
}

/**
 * customer.subscription.deleted:
 * Fires when a subscription is fully canceled (not just scheduled).
 * Downgrade tier to 'free', set status='canceled'. Existing resources
 * are preserved (feature gates enforce on CREATE only, per spec).
 */
async function handleSubscriptionDeleted(
  subscription: Stripe.Subscription,
): Promise<void> {
  const db = getDb();

  await db
    .update(subscriptions)
    .set({
      tier: "free",
      status: "canceled",
      stripeSubscriptionId: null, // clear the ID since it's no longer active
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      updatedAt: new Date(),
    })
    .where(eq(subscriptions.stripeSubscriptionId, subscription.id));
}

/**
 * invoice.payment_failed:
 * Fires when Stripe fails to charge for a subscription renewal.
 * Set status='past_due' but keep tier='pro' — Stripe will retry
 * per configured dunning policy, and we don't want to disrupt the
 * user's access mid-retry-window.
 */
async function handleInvoicePaymentFailed(
  invoice: Stripe.Invoice,
): Promise<void> {
  // Stripe SDK v18+ removed the top-level `invoice.subscription`; the link now
  // lives under invoice.parent.subscription_details.subscription.
  const subRef = invoice.parent?.subscription_details?.subscription;
  if (!subRef) return; // Not a subscription invoice

  const subscriptionId = typeof subRef === "string" ? subRef : subRef.id;

  const db = getDb();

  await db
    .update(subscriptions)
    .set({
      status: "past_due",
      updatedAt: new Date(),
    })
    .where(eq(subscriptions.stripeSubscriptionId, subscriptionId));
}

/**
 * Registers the Stripe webhook route.
 *
 * CRITICAL: this route uses express.raw() so req.body is the unparsed Buffer
 * Stripe signature verification needs. It must be mounted BEFORE the app's
 * general express.json() middleware — otherwise express.json() consumes the
 * request stream first and the raw bytes are lost. It is also deliberately
 * NOT behind requireAuth: Stripe authenticates via the signature header, not
 * an Auth0 bearer token.
 */
export function registerStripeWebhookRoutes(app: Express): void {
  app.post(
    "/api/stripe/webhook",
    express.raw({ type: "application/json" }),
    handleStripeWebhook,
  );
}
