import "./PricingPage.css";

import { useCallback, useEffect, useState } from "react";

import { isSessionExpired, type GetAccessToken } from "../lib/api";
import {
  fetchSubscription,
  startCheckout,
  type Subscription,
} from "../lib/subscription";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { SessionExpiredNotice } from "./SessionExpiredNotice";

type PricingPageProps = {
  getAccessTokenSilently: GetAccessToken;
};

const FREE_FEATURES = [
  "2 integrations",
  "1 project",
  "WordPress + SendGrid connectors",
  "Community support",
];

const PRO_FEATURES = [
  "Unlimited integrations",
  "Unlimited projects",
  "All connectors including OpenClaw, Auth0, Stripe",
  "Project Genesis auto-wiring",
  "Priority support",
];

export function PricingPage({ getAccessTokenSilently }: PricingPageProps) {
  const [sub, setSub] = useState<Subscription | null>(null);
  const [inFlight, setInFlight] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);

  // Best-effort — the pricing table renders even if this fails; it only
  // decides which CTA to show (current plan vs upgrade vs convert).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const s = await fetchSubscription(getAccessTokenSilently);
        if (!cancelled) setSub(s);
      } catch (err) {
        if (isSessionExpired(err) && !cancelled) setSessionExpired(true);
        // Otherwise leave sub null; the table still displays.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [getAccessTokenSilently]);

  const handleUpgrade = useCallback(async () => {
    setError(null);
    setInFlight(true);
    try {
      await startCheckout(getAccessTokenSilently);
      // On success the browser navigates to Stripe; inFlight stays true.
    } catch (err) {
      if (isSessionExpired(err)) {
        setSessionExpired(true);
        return;
      }
      setError(err instanceof Error ? err.message : "Couldn't start checkout.");
      setInFlight(false);
    }
  }, [getAccessTokenSilently]);

  if (sessionExpired) {
    return (
      <div className="settings-subsection">
        <h3>Pricing</h3>
        <SessionExpiredNotice />
      </div>
    );
  }

  const isPro = sub?.tier === "pro";
  const isGrandfathered = sub?.is_grandfathered ?? false;
  const isPaidPro = isPro && !isGrandfathered;
  const isFree = sub?.tier === "free";

  return (
    <div className="settings-subsection pricing">
      <h3>Pricing</h3>
      <p className="muted">Simple pricing for AI Connect</p>

      <div className="pricing__grid">
        {/* Free */}
        <Card
          variant="outlined"
          header={
            <div className="pricing__plan">
              <span className="pricing__plan-name">Free</span>
              <span className="pricing__price">
                $0
                <span className="pricing__price-suffix">/mo</span>
              </span>
            </div>
          }
          footer={
            isFree ? (
              <Button variant="secondary" fullWidth disabled>
                Current plan
              </Button>
            ) : (
              <Button variant="ghost" fullWidth disabled>
                Get started
              </Button>
            )
          }
        >
          <ul className="pricing__features">
            {FREE_FEATURES.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </Card>

        {/* Pro */}
        <Card
          variant="elevated"
          header={
            <div className="pricing__plan">
              <Badge variant="info">Most popular</Badge>
              <span className="pricing__plan-name">Pro</span>
              <span className="pricing__price">
                $49
                <span className="pricing__price-suffix">/mo</span>
              </span>
            </div>
          }
          footer={
            isPaidPro ? (
              <Button variant="secondary" fullWidth disabled>
                Current plan
              </Button>
            ) : isGrandfathered ? (
              <div className="pricing__foot-stack">
                <p className="pricing__grandfathered">
                  You have grandfathered Pro access — thanks!
                </p>
                <Button
                  variant="ghost"
                  fullWidth
                  loading={inFlight}
                  onClick={() => void handleUpgrade()}
                >
                  Convert to paid
                </Button>
              </div>
            ) : (
              <Button
                variant="primary"
                fullWidth
                loading={inFlight}
                onClick={() => void handleUpgrade()}
              >
                Upgrade to Pro
              </Button>
            )
          }
        >
          <ul className="pricing__features">
            {PRO_FEATURES.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </Card>
      </div>

      {error ? <p className="pricing__error">{error}</p> : null}
    </div>
  );
}
