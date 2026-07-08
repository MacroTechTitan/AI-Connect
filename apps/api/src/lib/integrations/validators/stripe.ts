import { StripeError, stripeConnectClient } from "../stripeClient.js";
import type {
  IntegrationValidator,
  StripeConfig,
  StripeIdentity,
} from "../types.js";

/**
 * Factory function. Returns an IntegrationValidator for Stripe Connect
 * integrations. userId is unused (no per-user ownership check), so it's
 * prefixed `_`.
 *
 * Stripe Connect uses AI Connect's platform STRIPE_SECRET_KEY plus the
 * Stripe-Account header per call, so there is no per-user credential — the
 * validator ignores `credential`. It verifies the Connected Account exists
 * (and that the platform account has access) via getAccount, then derives the
 * account status the same way the account.updated webhook handler does.
 */
export function makeStripeValidator(_userId: string): IntegrationValidator {
  return async ({ config }) => {
    const c = config as StripeConfig;

    if (typeof c.stripe_account_id !== "string" || c.stripe_account_id.length === 0) {
      return {
        valid: false,
        errorMessage:
          'Stripe config requires "stripe_account_id" (Connected Account ID starting with "acct_").',
      };
    }

    if (!c.stripe_account_id.startsWith("acct_")) {
      return {
        valid: false,
        errorMessage: `Stripe Connected Account ID must start with "acct_". Got: ${c.stripe_account_id.slice(0, 10)}...`,
      };
    }

    // Fetch the account to verify it exists AND we have access.
    let account;
    try {
      account = await stripeConnectClient.getAccount(c.stripe_account_id);
    } catch (err) {
      if (err instanceof StripeError) {
        if (err.code === "account_not_found") {
          return {
            valid: false,
            errorMessage: `Stripe Connected Account not found: ${c.stripe_account_id}. Verify the ID is correct and that AI Connect's platform account has access.`,
          };
        }
        return { valid: false, errorMessage: err.message };
      }
      throw err;
    }

    // Derive status the same way the account.updated webhook handler does.
    let status: "pending" | "active" | "restricted";
    if (account.requirements?.disabled_reason) {
      status = "restricted";
    } else if (
      account.charges_enabled &&
      account.payouts_enabled &&
      account.details_submitted
    ) {
      status = "active";
    } else {
      status = "pending";
    }

    const identity: StripeIdentity = {
      account_id: account.id,
      charges_enabled: account.charges_enabled ?? false,
      payouts_enabled: account.payouts_enabled ?? false,
      details_submitted: account.details_submitted ?? false,
      status,
      country: account.country ?? "",
      business_type: account.business_type ?? undefined,
      requirements_summary: account.requirements
        ? {
            currently_due_count: account.requirements.currently_due?.length ?? 0,
            past_due_count: account.requirements.past_due?.length ?? 0,
            disabled_reason: account.requirements.disabled_reason ?? undefined,
          }
        : undefined,
    };

    return { valid: true, identity };
  };
}
