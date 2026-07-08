import "./SubscriptionPanel.css";

import { useCallback, useEffect, useState } from "react";

import { authedFetch, isSessionExpired, type GetAccessToken } from "../lib/api";
import {
  cancelSubscription,
  fetchSubscription,
  formatPeriodEnd,
  openPortal,
  startCheckout,
  type Subscription,
} from "../lib/subscription";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Modal } from "../ui/Modal";
import { SessionExpiredNotice } from "./SessionExpiredNotice";

type SubscriptionPanelProps = {
  getAccessTokenSilently: GetAccessToken;
};

const FREE_MAX_INTEGRATIONS = 2;
const FREE_MAX_PROJECTS = 1;

export function SubscriptionPanel({
  getAccessTokenSilently,
}: SubscriptionPanelProps) {
  const [sub, setSub] = useState<Subscription | null>(null);
  const [counts, setCounts] = useState<{
    integrations: number;
    projects: number;
  } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [inFlight, setInFlight] = useState(false);
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);

  const refresh = useCallback(async () => {
    setLoadError(null);
    try {
      const s = await fetchSubscription(getAccessTokenSilently);
      setSub(s);
      // Usage counts only matter for the Free tier's "N of M" display.
      if (s.tier === "free") {
        const [intRes, projRes] = await Promise.all([
          authedFetch("/api/integrations", {}, getAccessTokenSilently),
          authedFetch("/api/projects", {}, getAccessTokenSilently),
        ]);
        const intBody = intRes.ok
          ? ((await intRes.json()) as { integrations?: unknown[] })
          : { integrations: [] };
        const projBody = projRes.ok
          ? ((await projRes.json()) as { projects?: unknown[] })
          : { projects: [] };
        setCounts({
          integrations: intBody.integrations?.length ?? 0,
          projects: projBody.projects?.length ?? 0,
        });
      } else {
        setCounts(null);
      }
    } catch (err) {
      if (isSessionExpired(err)) {
        setSessionExpired(true);
        return;
      }
      setLoadError("Couldn't load your subscription. Try again.");
    }
  }, [getAccessTokenSilently]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runAction = useCallback(
    async (fn: () => Promise<void>, refreshAfter: boolean) => {
      setActionError(null);
      setInFlight(true);
      try {
        await fn();
        if (refreshAfter) await refresh();
      } catch (err) {
        if (isSessionExpired(err)) {
          setSessionExpired(true);
          return;
        }
        setActionError(
          err instanceof Error ? err.message : "Something went wrong.",
        );
      } finally {
        setInFlight(false);
      }
    },
    [refresh],
  );

  const handleUpgrade = () =>
    void runAction(() => startCheckout(getAccessTokenSilently), false);
  const handlePortal = () =>
    void runAction(() => openPortal(getAccessTokenSilently), false);
  const handleCancel = () =>
    void runAction(async () => {
      await cancelSubscription(getAccessTokenSilently);
      setCancelConfirmOpen(false);
    }, true);

  if (sessionExpired) {
    return (
      <div className="settings-subsection">
        <h3>Your subscription</h3>
        <SessionExpiredNotice />
      </div>
    );
  }

  return (
    <div className="settings-subsection">
      <h3>Your subscription</h3>
      {loadError ? <p className="error">{loadError}</p> : null}
      {sub === null && !loadError ? (
        <p className="muted">Loading…</p>
      ) : null}

      {sub ? (
        <Card variant="default">
          {sub.tier === "free" ? (
            <FreePanel
              counts={counts}
              inFlight={inFlight}
              onUpgrade={handleUpgrade}
            />
          ) : sub.is_grandfathered ? (
            <GrandfatheredPanel inFlight={inFlight} onConvert={handleUpgrade} />
          ) : (
            <PaidProPanel
              sub={sub}
              inFlight={inFlight}
              onManage={handlePortal}
              onCancelClick={() => setCancelConfirmOpen(true)}
            />
          )}
          {actionError ? <p className="sub-panel__error">{actionError}</p> : null}
        </Card>
      ) : null}

      <Modal
        open={cancelConfirmOpen}
        onClose={() => setCancelConfirmOpen(false)}
        title="Cancel subscription?"
        size="sm"
      >
        <p className="sub-panel__copy">
          Your Pro access continues until the end of the current billing period.
          After that you&apos;ll move to the Free plan. Your existing projects
          and integrations are kept — you just won&apos;t be able to create new
          ones beyond the Free limits.
        </p>
        {actionError ? <p className="sub-panel__error">{actionError}</p> : null}
        <div className="sub-panel__cancel-actions">
          <Button
            variant="ghost"
            onClick={() => setCancelConfirmOpen(false)}
          >
            Keep subscription
          </Button>
          <Button
            variant="danger"
            loading={inFlight}
            onClick={handleCancel}
          >
            Cancel at period end
          </Button>
        </div>
      </Modal>
    </div>
  );
}

function FreePanel({
  counts,
  inFlight,
  onUpgrade,
}: {
  counts: { integrations: number; projects: number } | null;
  inFlight: boolean;
  onUpgrade: () => void;
}) {
  return (
    <>
      <p className="sub-panel__status">You&apos;re on the Free plan</p>
      <div className="sub-panel__usage">
        <span>
          You&apos;ve used {counts?.integrations ?? "—"} of{" "}
          {FREE_MAX_INTEGRATIONS} integrations
        </span>
        <span>
          You&apos;ve used {counts?.projects ?? "—"} of {FREE_MAX_PROJECTS}{" "}
          project
        </span>
      </div>
      <div className="sub-panel__actions">
        <Button variant="primary" loading={inFlight} onClick={onUpgrade}>
          Upgrade to Pro — $49/mo
        </Button>
      </div>
    </>
  );
}

function GrandfatheredPanel({
  inFlight,
  onConvert,
}: {
  inFlight: boolean;
  onConvert: () => void;
}) {
  return (
    <>
      <p className="sub-panel__status">You have Pro access (grandfathered)</p>
      <p className="sub-panel__copy">
        You have unlimited access as an early user. If you&apos;d like to
        support AI Connect by converting to a paid subscription, you can start
        one below.
      </p>
      <div className="sub-panel__actions">
        <Button variant="ghost" loading={inFlight} onClick={onConvert}>
          Convert to paid Pro
        </Button>
      </div>
    </>
  );
}

function PaidProPanel({
  sub,
  inFlight,
  onManage,
  onCancelClick,
}: {
  sub: Subscription;
  inFlight: boolean;
  onManage: () => void;
  onCancelClick: () => void;
}) {
  return (
    <>
      <p className="sub-panel__status">You&apos;re on the Pro plan</p>
      {sub.status === "past_due" ? (
        <div className="sub-panel__row">
          <Badge variant="warning">
            Payment failed — please update your payment method
          </Badge>
        </div>
      ) : null}
      <div className="sub-panel__row">
        {sub.cancel_at_period_end ? (
          <span>
            Cancellation scheduled for {formatPeriodEnd(sub.current_period_end)}
          </span>
        ) : (
          <span>Renews on {formatPeriodEnd(sub.current_period_end)}</span>
        )}
      </div>
      <div className="sub-panel__actions">
        <Button variant="primary" loading={inFlight} onClick={onManage}>
          Manage subscription
        </Button>
        {!sub.cancel_at_period_end ? (
          <Button variant="ghost" onClick={onCancelClick}>
            Cancel subscription
          </Button>
        ) : null}
      </div>
    </>
  );
}
