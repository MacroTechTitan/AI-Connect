import { useCallback, useEffect, useState } from "react";

import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { Modal } from "../../ui/Modal";
import {
  adminFetch,
  adminMutate,
  type GetAccessToken,
} from "../shared/adminApi";
import {
  formatDate,
  statusBadgeVariant,
  tierBadgeVariant,
} from "../shared/formatters";
import { SectionError, SectionLoading } from "../shared/SectionState";

type SubscriptionRow = {
  id: string;
  userId: string;
  email: string | null;
  tier: string;
  status: string;
  stripeSubscriptionId: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  createdAt: string;
};

export function SubscriptionsSection({
  getAccessTokenSilently,
}: {
  getAccessTokenSilently: GetAccessToken;
}) {
  const [rows, setRows] = useState<SubscriptionRow[]>([]);
  const [tier, setTier] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [cancelId, setCancelId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "100" });
      if (tier) params.set("tier", tier);
      if (status) params.set("status", status);
      const data = await adminFetch<{ subscriptions: SubscriptionRow[] }>(
        `/api/admin/subscriptions?${params.toString()}`,
        getAccessTokenSilently,
      );
      setRows(data.subscriptions);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [tier, status, getAccessTokenSilently]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="admin-section">
      <div className="admin-toolbar">
        <select value={tier} onChange={(e) => setTier(e.target.value)}>
          <option value="">All tiers</option>
          <option value="free">free</option>
          <option value="pro">pro</option>
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          <option value="active">active</option>
          <option value="past_due">past_due</option>
          <option value="canceled">canceled</option>
          <option value="incomplete">incomplete</option>
          <option value="trialing">trialing</option>
        </select>
      </div>

      {error ? <SectionError error={error} /> : null}

      {loading && rows.length === 0 ? (
        <SectionLoading />
      ) : rows.length === 0 && !error ? (
        <p className="admin-muted">No subscriptions.</p>
      ) : rows.length > 0 ? (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Tier</th>
                <th>Status</th>
                <th>Renews / ends</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id}>
                  <td className="admin-mono">{s.email ?? "—"}</td>
                  <td>
                    <Badge variant={tierBadgeVariant(s.tier)}>{s.tier}</Badge>
                  </td>
                  <td>
                    <Badge variant={statusBadgeVariant(s.status)}>
                      {s.status}
                    </Badge>
                  </td>
                  <td className="admin-muted">
                    {formatDate(s.currentPeriodEnd)}
                    {s.cancelAtPeriodEnd ? " (canceling)" : ""}
                  </td>
                  <td>
                    {s.status === "active" && s.stripeSubscriptionId ? (
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={() => setCancelId(s.id)}
                      >
                        Cancel
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {cancelId ? (
        <CancelModal
          subscriptionId={cancelId}
          getAccessTokenSilently={getAccessTokenSilently}
          onClose={() => setCancelId(null)}
          onDone={() => {
            setCancelId(null);
            void load();
          }}
        />
      ) : null}
    </div>
  );
}

function CancelModal({
  subscriptionId,
  getAccessTokenSilently,
  onClose,
  onDone,
}: {
  subscriptionId: string;
  getAccessTokenSilently: GetAccessToken;
  onClose: () => void;
  onDone: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function cancel() {
    setSaving(true);
    setError(null);
    try {
      await adminMutate(
        `/api/admin/subscriptions/${subscriptionId}/cancel`,
        "POST",
        getAccessTokenSilently,
      );
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't cancel.");
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} size="sm" title="Cancel subscription?">
      <p className="admin-muted">
        Immediately cancels in Stripe and downgrades the user to Free.
      </p>
      {error ? <p className="admin-error-text">{error}</p> : null}
      <div className="admin-actions">
        <Button variant="ghost" onClick={onClose}>
          Keep it
        </Button>
        <Button variant="danger" loading={saving} onClick={() => void cancel()}>
          Force cancel
        </Button>
      </div>
    </Modal>
  );
}
