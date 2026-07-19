# Managing your subscription

Once you're on Pro, you can manage your subscription from Settings → Billing.

## Managing via Customer Portal

Click **Manage subscription** → opens Stripe's hosted Customer Portal in a new tab.

From the portal you can:
- Update payment method
- View invoice history
- Download receipts
- Cancel or change plans

## Cancellation

Two ways to cancel:

**From AI Connect:** Settings → Billing → **Cancel subscription**. This schedules cancellation at the end of your current billing period. You keep Pro access until then.

**From the Stripe Portal:** Same effect — schedules cancellation at period end.

Reactivate any time before the period ends via the Customer Portal.

## What happens after cancellation

At the end of the billing period, `customer.subscription.deleted` fires:
- Your tier drops from Pro to Free
- Your existing integrations and projects remain accessible (view / edit / delete only)
- You can't create new integrations or projects beyond Free limits

## Payment failures

If Stripe fails to charge for a renewal, your status changes to `past_due`. Stripe retries automatically per its dunning policy — typically 3 retries over 2 weeks. During this time your Pro access continues.

If all retries fail, the subscription cancels and you downgrade to Free.

You'll receive email notifications from Stripe throughout this process.

## Refunds

For refund requests, contact support@macrotechtitan.com. Refunds are handled case-by-case in v1.
