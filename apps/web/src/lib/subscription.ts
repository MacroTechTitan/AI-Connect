// Subscription/billing API helpers shared by the billing UI components
// (PricingPage, SubscriptionPanel, UpgradePromptModal). Built on the same
// authedFetch bearer-token model as lib/api.ts so a session_expired sentinel
// propagates to the caller for <SessionExpiredNotice /> handling.

import { authedFetch, type GetAccessToken } from "./api";

export type Tier = "free" | "pro";
export type SubscriptionStatus =
  | "active"
  | "past_due"
  | "canceled"
  | "incomplete"
  | "trialing";

// Shape returned by GET /api/subscription.
export interface Subscription {
  tier: Tier;
  status: SubscriptionStatus;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  is_grandfathered: boolean;
  has_stripe_customer: boolean;
}

async function messageFrom(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string; error?: string };
    return body.message ?? body.error ?? fallback;
  } catch {
    return fallback;
  }
}

export async function fetchSubscription(
  getAccessTokenSilently: GetAccessToken,
): Promise<Subscription> {
  const res = await authedFetch(
    "/api/subscription",
    {},
    getAccessTokenSilently,
  );
  if (!res.ok) {
    throw new Error(await messageFrom(res, "Couldn't load subscription."));
  }
  return (await res.json()) as Subscription;
}

/**
 * Starts a Pro checkout and redirects the browser to Stripe's hosted
 * Checkout page. If the user already has a paid subscription (409), falls
 * back to the customer portal. Throws on any other failure.
 */
export async function startCheckout(
  getAccessTokenSilently: GetAccessToken,
): Promise<void> {
  const res = await authedFetch(
    "/api/subscription/checkout",
    { method: "POST" },
    getAccessTokenSilently,
  );
  if (res.status === 409) {
    // Already subscribed — the right destination is the portal, not checkout.
    await openPortal(getAccessTokenSilently);
    return;
  }
  if (!res.ok) {
    throw new Error(await messageFrom(res, "Couldn't start checkout."));
  }
  const body = (await res.json()) as { url?: string };
  if (!body.url) throw new Error("Checkout returned no URL.");
  window.location.href = body.url;
}

/**
 * Opens the Stripe Customer Portal by redirecting the browser to it.
 */
export async function openPortal(
  getAccessTokenSilently: GetAccessToken,
): Promise<void> {
  const res = await authedFetch(
    "/api/subscription/portal",
    { method: "POST" },
    getAccessTokenSilently,
  );
  if (!res.ok) {
    throw new Error(await messageFrom(res, "Couldn't open the customer portal."));
  }
  const body = (await res.json()) as { url?: string };
  if (!body.url) throw new Error("Portal returned no URL.");
  window.location.href = body.url;
}

/**
 * Schedules cancellation at period end. Does not redirect — the caller
 * refreshes the subscription to reflect cancel_at_period_end.
 */
export async function cancelSubscription(
  getAccessTokenSilently: GetAccessToken,
): Promise<void> {
  const res = await authedFetch(
    "/api/subscription/cancel",
    { method: "POST" },
    getAccessTokenSilently,
  );
  if (!res.ok) {
    throw new Error(await messageFrom(res, "Couldn't cancel the subscription."));
  }
}

// Shared display helper for period-end dates.
export function formatPeriodEnd(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
}
