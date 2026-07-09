import "./StripeAccountManager.css";
import { useCallback, useEffect, useState } from "react";

import { authedFetch, isSessionExpired, type GetAccessToken } from "../lib/api";
import { Badge, type BadgeVariant } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { SessionExpiredNotice } from "./SessionExpiredNotice";

type StripeAccountStatus = "pending" | "active" | "restricted";

interface StripeAccountInfo {
  account_id: string;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  details_submitted: boolean;
  status: StripeAccountStatus;
  country: string;
  business_type?: string;
  requirements: {
    currently_due: string[];
    past_due: string[];
    disabled_reason: string | null;
    current_deadline: string | null;
  } | null;
}

const STATUS_BADGE: Record<
  StripeAccountStatus,
  { variant: BadgeVariant; label: string }
> = {
  pending: { variant: "warning", label: "Pending onboarding" },
  active: { variant: "success", label: "Active" },
  restricted: { variant: "error", label: "Restricted" },
};

// Inline panel (rendered below the integrations list, like the Auth0 manager)
// for managing the single Stripe Connected Account on an integration.
export function StripeAccountManager({
  integrationId,
  getAccessTokenSilently,
  onClose,
}: {
  integrationId: string;
  getAccessTokenSilently: GetAccessToken;
  onClose: () => void;
}) {
  const [account, setAccount] = useState<StripeAccountInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [inFlight, setInFlight] = useState<"onboarding" | "dashboard" | null>(
    null,
  );
  const [sessionExpired, setSessionExpired] = useState(false);

  const base = `/api/integrations/${integrationId}`;

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await authedFetch(
        `${base}/stripe/account`,
        {},
        getAccessTokenSilently,
      );
      if (!res.ok) {
        let msg = "Couldn't load the Stripe account.";
        try {
          const body = (await res.json()) as {
            message?: string;
            error?: string;
          };
          msg = body.message ?? body.error ?? msg;
        } catch {
          // keep default
        }
        setError(msg);
        setAccount(null);
        return;
      }
      const body = (await res.json()) as StripeAccountInfo;
      setAccount(body);
    } catch (err) {
      if (isSessionExpired(err)) {
        setSessionExpired(true);
        return;
      }
      setError("Couldn't reach the server. Try again.");
      setAccount(null);
    } finally {
      setLoading(false);
    }
  }, [base, getAccessTokenSilently]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Fetches a link (onboarding or dashboard) and opens it in a new tab.
  async function openLink(kind: "onboarding" | "dashboard") {
    setInFlight(kind);
    setError(null);
    try {
      const path =
        kind === "onboarding"
          ? `${base}/stripe/onboarding-link`
          : `${base}/stripe/dashboard-link`;
      const res = await authedFetch(
        path,
        { method: "POST" },
        getAccessTokenSilently,
      );
      if (!res.ok) {
        let msg = "Couldn't open Stripe. Try again.";
        try {
          const body = (await res.json()) as {
            message?: string;
            error?: string;
          };
          msg = body.message ?? body.error ?? msg;
        } catch {
          // keep default
        }
        setError(msg);
        return;
      }
      const body = (await res.json()) as { url?: string };
      if (body.url) {
        window.open(body.url, "_blank", "noopener,noreferrer");
      } else {
        setError("Stripe returned no URL. Try again.");
      }
    } catch (err) {
      if (isSessionExpired(err)) {
        setSessionExpired(true);
        return;
      }
      setError("Couldn't reach the server. Try again.");
    } finally {
      setInFlight(null);
    }
  }

  function copyAccountId(id: string) {
    void navigator.clipboard?.writeText(id).catch(() => {});
  }

  if (sessionExpired) {
    return (
      <div className="sam">
        <SessionExpiredNotice />
      </div>
    );
  }

  return (
    <div className="sam">
      <div className="sam-head">
        <h4>Stripe Connect Account</h4>
        <button type="button" className="linklike" onClick={onClose}>
          Close
        </button>
      </div>

      {error ? <p className="sam-error">{error}</p> : null}

      {loading && !account ? (
        <p className="sam-muted">Loading account…</p>
      ) : account ? (
        <>
          <Card variant="default" padding="md">
            <div className="sam-status-head">
              <Badge variant={STATUS_BADGE[account.status].variant}>
                {STATUS_BADGE[account.status].label}
              </Badge>
            </div>

            <div className="sam-detail-row">
              <span className="sam-label">Account ID</span>
              <div className="sam-accountid">
                <code className="sam-mono">{account.account_id}</code>
                <button
                  type="button"
                  className="linklike"
                  onClick={() => copyAccountId(account.account_id)}
                >
                  Copy
                </button>
              </div>
            </div>

            <div className="sam-grid">
              <div className="sam-detail-row">
                <span className="sam-label">Country</span>
                <span>{account.country || "—"}</span>
              </div>
              <div className="sam-detail-row">
                <span className="sam-label">Business type</span>
                <span>{account.business_type ?? "—"}</span>
              </div>
            </div>

            <div className="sam-flags">
              <FlagRow label="Charges enabled" on={account.charges_enabled} />
              <FlagRow label="Payouts enabled" on={account.payouts_enabled} />
              <FlagRow
                label="Details submitted"
                on={account.details_submitted}
              />
            </div>
          </Card>

          {account.status === "restricted" ? (
            <Card variant="outlined" padding="md">
              <p className="sam-warn-title">
                Stripe has restricted this account.
              </p>
              {account.requirements?.disabled_reason ? (
                <p className="sam-muted">
                  Reason: {account.requirements.disabled_reason}
                </p>
              ) : null}
              <RequirementsList requirements={account.requirements} />
              <div className="sam-actions">
                <Button
                  variant="primary"
                  loading={inFlight === "dashboard"}
                  onClick={() => void openLink("dashboard")}
                >
                  Complete Requirements
                </Button>
              </div>
            </Card>
          ) : account.status === "pending" ? (
            <Card variant="outlined" padding="md">
              <p>Onboarding not yet complete.</p>
              <div className="sam-actions">
                <Button
                  variant="primary"
                  loading={inFlight === "onboarding"}
                  onClick={() => void openLink("onboarding")}
                >
                  Continue Onboarding
                </Button>
              </div>
              <p className="sam-muted">
                After completing Stripe&apos;s onboarding, come back here — the
                status will update automatically.
              </p>
            </Card>
          ) : (
            <Card variant="outlined" padding="md">
              <p>
                Everything&apos;s set up! Your account can accept payments and
                receive payouts.
              </p>
              <div className="sam-actions">
                <Button
                  variant="primary"
                  loading={inFlight === "dashboard"}
                  onClick={() => void openLink("dashboard")}
                >
                  Open Express Dashboard
                </Button>
              </div>
            </Card>
          )}
        </>
      ) : null}

      <div className="sam-actions">
        <Button
          variant="ghost"
          onClick={() => void refresh()}
          disabled={loading}
        >
          {loading ? "Refreshing…" : "Refresh"}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  );
}

function FlagRow({ label, on }: { label: string; on: boolean }) {
  return (
    <div className="sam-flag">
      <span
        className={on ? "sam-flag-yes" : "sam-flag-no"}
        aria-hidden="true"
      >
        {on ? "✓" : "✕"}
      </span>
      <span>
        {label}: {on ? "Yes" : "No"}
      </span>
    </div>
  );
}

function RequirementsList({
  requirements,
}: {
  requirements: StripeAccountInfo["requirements"];
}) {
  if (!requirements) return null;
  const past = requirements.past_due ?? [];
  const due = requirements.currently_due ?? [];
  if (past.length === 0 && due.length === 0) return null;
  return (
    <div className="sam-reqs">
      {past.length > 0 ? (
        <div className="sam-detail-row">
          <span className="sam-label">Past due</span>
          <ul className="sam-req-list">
            {past.map((r) => (
              <li key={r} className="sam-mono">
                {r}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {due.length > 0 ? (
        <div className="sam-detail-row">
          <span className="sam-label">Currently due</span>
          <ul className="sam-req-list">
            {due.map((r) => (
              <li key={r} className="sam-mono">
                {r}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
