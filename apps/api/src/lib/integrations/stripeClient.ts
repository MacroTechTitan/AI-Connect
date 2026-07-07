/**
 * Stripe SDK wrapper for AI Connect.
 *
 * Two clients from one SDK:
 * - StripeStandardClient: AI Connect's platform Stripe account.
 *   Used for AI Connect's own Free/Pro subscription billing.
 * - StripeConnectClient: Same platform account BUT acts on behalf
 *   of user projects' Stripe Connected Accounts via the
 *   Stripe-Account header (via stripeAccount parameter on API calls).
 *
 * Both use the same STRIPE_SECRET_KEY. What differs is which account
 * the request targets.
 */

import Stripe from "stripe";
import { env } from "../env.js";

export type StripeErrorCode =
  | "invalid_credentials"
  | "account_not_found"
  | "subscription_not_found"
  | "customer_not_found"
  | "charge_failed"
  | "rate_limited"
  | "invalid_request"
  | "api_error"
  | "network_error";

export class StripeError extends Error {
  constructor(
    public readonly code: StripeErrorCode,
    message: string,
    public readonly stripeError?: Stripe.errors.StripeError,
  ) {
    super(message);
    this.name = "StripeError";
  }
}

/**
 * Lazily-instantiated Stripe SDK client. STRIPE_SECRET_KEY isn't
 * required in local dev, so we don't fail at import time — only at
 * first use.
 */
let stripeInstance: Stripe | null = null;

function getStripe(): Stripe {
  if (stripeInstance) return stripeInstance;

  const secretKey = env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new StripeError(
      "invalid_credentials",
      "STRIPE_SECRET_KEY is not set. Configure it in environment variables to use Stripe.",
    );
  }

  stripeInstance = new Stripe(secretKey, {
    // Pin the API version explicitly (matches the version bundled with the SDK)
    // so a Stripe-side default change never silently alters request/response
    // shapes. Bump deliberately when upgrading the SDK.
    apiVersion: "2026-06-24.dahlia",
    typescript: true,
    maxNetworkRetries: 2,
    telemetry: false,
  });

  return stripeInstance;
}

/**
 * Maps Stripe SDK errors to typed StripeError with an actionable code.
 */
function mapStripeError(err: unknown): StripeError {
  if (err instanceof StripeError) return err;

  if (err instanceof Stripe.errors.StripeAuthenticationError) {
    return new StripeError("invalid_credentials", err.message, err);
  }
  if (err instanceof Stripe.errors.StripeInvalidRequestError) {
    // Distinguish not-found from other invalid requests
    if (err.code === "resource_missing") {
      if (err.param?.includes("customer")) {
        return new StripeError("customer_not_found", err.message, err);
      }
      if (err.param?.includes("subscription")) {
        return new StripeError("subscription_not_found", err.message, err);
      }
      if (err.param?.includes("account")) {
        return new StripeError("account_not_found", err.message, err);
      }
    }
    return new StripeError("invalid_request", err.message, err);
  }
  if (err instanceof Stripe.errors.StripeRateLimitError) {
    return new StripeError("rate_limited", err.message, err);
  }
  if (err instanceof Stripe.errors.StripeAPIError) {
    return new StripeError("api_error", err.message, err);
  }
  if (err instanceof Stripe.errors.StripeConnectionError) {
    return new StripeError("network_error", err.message, err);
  }
  if (err instanceof Stripe.errors.StripeCardError) {
    return new StripeError("charge_failed", err.message, err);
  }

  return new StripeError(
    "api_error",
    (err as Error).message ?? "Unknown Stripe error",
  );
}

// ============================================================
// StripeStandardClient — for AI Connect's own paid tier billing
// ============================================================

export class StripeStandardClient {
  /**
   * Finds an existing Stripe Customer by email, or creates a new one
   * if none exists. Idempotent per email.
   */
  async getOrCreateCustomer(
    email: string,
    userId: string,
  ): Promise<Stripe.Customer> {
    const stripe = getStripe();
    try {
      // Try to find existing customer by metadata.userId (more reliable than email)
      const existing = await stripe.customers.list({
        limit: 1,
        email,
      });

      // If found and the metadata matches our userId, reuse
      const match = existing.data.find(
        (c) => c.metadata?.ai_connect_user_id === userId,
      );
      if (match) return match;

      // Otherwise, create new
      return await stripe.customers.create({
        email,
        metadata: {
          ai_connect_user_id: userId,
        },
      });
    } catch (err) {
      throw mapStripeError(err);
    }
  }

  /**
   * Creates a Stripe Checkout Session for subscription purchase.
   * Returns a hosted checkout URL the user can redirect to.
   */
  async createCheckoutSession(params: {
    customerId: string;
    priceId: string;
    successUrl: string;
    cancelUrl: string;
    userId: string;
  }): Promise<Stripe.Checkout.Session> {
    const stripe = getStripe();
    try {
      return await stripe.checkout.sessions.create({
        mode: "subscription",
        customer: params.customerId,
        line_items: [{ price: params.priceId, quantity: 1 }],
        success_url: params.successUrl,
        cancel_url: params.cancelUrl,
        client_reference_id: params.userId,
        metadata: {
          ai_connect_user_id: params.userId,
        },
        subscription_data: {
          metadata: {
            ai_connect_user_id: params.userId,
          },
        },
      });
    } catch (err) {
      throw mapStripeError(err);
    }
  }

  /**
   * Creates a Customer Portal session for self-service subscription
   * management (cancel, update payment method, view invoices).
   */
  async createCustomerPortalSession(params: {
    customerId: string;
    returnUrl: string;
  }): Promise<Stripe.BillingPortal.Session> {
    const stripe = getStripe();
    try {
      return await stripe.billingPortal.sessions.create({
        customer: params.customerId,
        return_url: params.returnUrl,
      });
    } catch (err) {
      throw mapStripeError(err);
    }
  }

  async getSubscription(subscriptionId: string): Promise<Stripe.Subscription> {
    const stripe = getStripe();
    try {
      return await stripe.subscriptions.retrieve(subscriptionId);
    } catch (err) {
      throw mapStripeError(err);
    }
  }

  async cancelSubscription(
    subscriptionId: string,
    atPeriodEnd = true,
  ): Promise<Stripe.Subscription> {
    const stripe = getStripe();
    try {
      if (atPeriodEnd) {
        return await stripe.subscriptions.update(subscriptionId, {
          cancel_at_period_end: true,
        });
      }
      return await stripe.subscriptions.cancel(subscriptionId);
    } catch (err) {
      throw mapStripeError(err);
    }
  }

  /**
   * Verifies a webhook signature and constructs the event object.
   * The webhook route handler must pass the RAW body (Buffer or string),
   * not the parsed JSON.
   */
  constructWebhookEvent(
    rawBody: Buffer | string,
    signature: string,
  ): Stripe.Event {
    const stripe = getStripe();
    const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
      throw new StripeError(
        "invalid_credentials",
        "STRIPE_WEBHOOK_SECRET is not set. Configure it in environment variables.",
      );
    }
    try {
      return stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    } catch (err) {
      throw new StripeError(
        "invalid_request",
        `Webhook signature verification failed: ${(err as Error).message}`,
      );
    }
  }
}

// ============================================================
// StripeConnectClient — for user projects' Connected Accounts
// ============================================================

export class StripeConnectClient {
  /**
   * Creates a new Express Connected Account for a user's project.
   * Express means Stripe hosts the onboarding flow and dashboard.
   */
  async createExpressAccount(params: {
    email: string;
    country: string; // ISO 2-letter code, e.g., 'US'
    businessType: "individual" | "company";
    projectId: string;
    userId: string;
  }): Promise<Stripe.Account> {
    const stripe = getStripe();
    try {
      return await stripe.accounts.create({
        type: "express",
        country: params.country,
        email: params.email,
        business_type: params.businessType,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        metadata: {
          ai_connect_project_id: params.projectId,
          ai_connect_user_id: params.userId,
        },
      });
    } catch (err) {
      throw mapStripeError(err);
    }
  }

  /**
   * Creates an Account Link — a URL the user visits to complete
   * Stripe's hosted onboarding. Expires after ~5 minutes; regenerate
   * on demand if the user needs a fresh one.
   */
  async createAccountLink(params: {
    accountId: string;
    refreshUrl: string; // where Stripe redirects if the link expires
    returnUrl: string; // where Stripe redirects after completion
  }): Promise<Stripe.AccountLink> {
    const stripe = getStripe();
    try {
      return await stripe.accountLinks.create({
        account: params.accountId,
        refresh_url: params.refreshUrl,
        return_url: params.returnUrl,
        type: "account_onboarding",
      });
    } catch (err) {
      throw mapStripeError(err);
    }
  }

  /**
   * Creates a Login Link — a URL the user visits to access their
   * Express Dashboard for the given Connected Account.
   */
  async createLoginLink(accountId: string): Promise<Stripe.LoginLink> {
    const stripe = getStripe();
    try {
      return await stripe.accounts.createLoginLink(accountId);
    } catch (err) {
      throw mapStripeError(err);
    }
  }

  async getAccount(accountId: string): Promise<Stripe.Account> {
    const stripe = getStripe();
    try {
      return await stripe.accounts.retrieve(accountId);
    } catch (err) {
      throw mapStripeError(err);
    }
  }
}

// Singletons — stateless aside from the lazy Stripe SDK instance
export const stripeStandardClient = new StripeStandardClient();
export const stripeConnectClient = new StripeConnectClient();
