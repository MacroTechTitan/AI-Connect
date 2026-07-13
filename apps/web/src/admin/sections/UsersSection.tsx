import { useCallback, useEffect, useState, type ReactNode } from "react";

import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { Modal } from "../../ui/Modal";
import { Pill } from "../../ui/Pill";
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

type UserRow = {
  id: string;
  email: string;
  isAdmin: boolean;
  createdAt: string;
  tier: string | null;
  status: string | null;
};

type UserDetail = {
  id: string;
  email: string;
  isAdmin: boolean;
  createdAt: string;
  subscriptionId: string | null;
  tier: string | null;
  status: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  integration_count: number;
};

const PAGE = 50;

export function UsersSection({
  getAccessTokenSilently,
}: {
  getAccessTokenSilently: GetAccessToken;
}) {
  const [rows, setRows] = useState<UserRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [adminsOnly, setAdminsOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const [detailId, setDetailId] = useState<string | null>(null);

  const load = useCallback(
    async (nextOffset: number, replace: boolean) => {
      setError(null);
      setLoading(true);
      try {
        const params = new URLSearchParams({
          limit: String(PAGE),
          offset: String(nextOffset),
        });
        if (adminsOnly) params.set("admins_only", "true");
        const data = await adminFetch<{
          users: UserRow[];
          total: number;
        }>(`/api/admin/users?${params.toString()}`, getAccessTokenSilently);
        setRows((prev) => (replace ? data.users : [...prev, ...data.users]));
        setTotal(data.total);
        setOffset(nextOffset);
      } catch (err) {
        setError(err);
      } finally {
        setLoading(false);
      }
    },
    [adminsOnly, getAccessTokenSilently],
  );

  useEffect(() => {
    void load(0, true);
  }, [load]);

  const hasMore = rows.length < total;

  return (
    <div className="admin-section">
      <div className="admin-toolbar">
        <label className="admin-check">
          <input
            type="checkbox"
            checked={adminsOnly}
            onChange={(e) => setAdminsOnly(e.target.checked)}
          />
          <span>Admins only</span>
        </label>
        <span className="admin-muted">{total} total</span>
      </div>

      {error ? <SectionError error={error} /> : null}

      {rows.length > 0 ? (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Tier</th>
                <th>Status</th>
                <th>Admin</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => (
                <tr
                  key={u.id}
                  className="admin-row-clickable"
                  onClick={() => setDetailId(u.id)}
                >
                  <td className="admin-mono">{u.email}</td>
                  <td>
                    <Badge variant={tierBadgeVariant(u.tier)}>
                      {u.tier ?? "—"}
                    </Badge>
                  </td>
                  <td>
                    {u.status ? (
                      <Badge variant={statusBadgeVariant(u.status)}>
                        {u.status}
                      </Badge>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    {u.isAdmin ? (
                      <Pill variant="info" size="sm">
                        admin
                      </Pill>
                    ) : (
                      ""
                    )}
                  </td>
                  <td className="admin-muted">{formatDate(u.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : loading ? (
        <SectionLoading />
      ) : !error ? (
        <p className="admin-muted">No users.</p>
      ) : null}

      {hasMore ? (
        <Button
          variant="ghost"
          loading={loading}
          onClick={() => void load(offset + PAGE, false)}
        >
          Show more
        </Button>
      ) : null}

      {detailId ? (
        <UserDetailModal
          userId={detailId}
          getAccessTokenSilently={getAccessTokenSilently}
          onClose={() => setDetailId(null)}
          onChanged={() => void load(0, true)}
        />
      ) : null}
    </div>
  );
}

function UserDetailModal({
  userId,
  getAccessTokenSilently,
  onClose,
  onChanged,
}: {
  userId: string;
  getAccessTokenSilently: GetAccessToken;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<UserDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [tierModalOpen, setTierModalOpen] = useState(false);
  const [cancelModalOpen, setCancelModalOpen] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const d = await adminFetch<UserDetail>(
        `/api/admin/users/${userId}`,
        getAccessTokenSilently,
      );
      setDetail(d);
    } catch (err) {
      setError(err);
    }
  }, [userId, getAccessTokenSilently]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Modal open onClose={onClose} size="md" title="User detail">
      {error ? (
        <SectionError error={error} />
      ) : !detail ? (
        <SectionLoading />
      ) : (
        <div className="admin-detail">
          <Row label="Email" value={<span className="admin-mono">{detail.email}</span>} />
          <Row
            label="Tier"
            value={
              <Badge variant={tierBadgeVariant(detail.tier)}>
                {detail.tier ?? "—"}
              </Badge>
            }
          />
          <Row
            label="Status"
            value={
              detail.status ? (
                <Badge variant={statusBadgeVariant(detail.status)}>
                  {detail.status}
                </Badge>
              ) : (
                "—"
              )
            }
          />
          <Row label="Admin" value={detail.isAdmin ? "Yes" : "No"} />
          <Row label="Integrations" value={String(detail.integration_count)} />
          <Row
            label="Stripe customer"
            value={
              <span className="admin-mono">
                {detail.stripeCustomerId ?? "—"}
              </span>
            }
          />
          <Row
            label="Stripe subscription"
            value={
              <span className="admin-mono">
                {detail.stripeSubscriptionId ?? "—"}
              </span>
            }
          />
          <Row
            label="Current period end"
            value={formatDate(detail.currentPeriodEnd)}
          />
          <Row
            label="Cancel at period end"
            value={detail.cancelAtPeriodEnd ? "Yes" : "No"}
          />
          <Row label="Created" value={formatDate(detail.createdAt)} />

          <div className="admin-actions">
            <Button variant="primary" onClick={() => setTierModalOpen(true)}>
              Change Tier
            </Button>
            {detail.stripeSubscriptionId && detail.subscriptionId ? (
              <Button
                variant="danger"
                onClick={() => setCancelModalOpen(true)}
              >
                Cancel Subscription
              </Button>
            ) : null}
          </div>
        </div>
      )}

      {tierModalOpen && detail ? (
        <ChangeTierModal
          userId={detail.id}
          currentTier={detail.tier ?? "free"}
          getAccessTokenSilently={getAccessTokenSilently}
          onClose={() => setTierModalOpen(false)}
          onDone={() => {
            setTierModalOpen(false);
            void load();
            onChanged();
          }}
        />
      ) : null}

      {cancelModalOpen && detail?.subscriptionId ? (
        <CancelSubscriptionModal
          subscriptionId={detail.subscriptionId}
          getAccessTokenSilently={getAccessTokenSilently}
          onClose={() => setCancelModalOpen(false)}
          onDone={() => {
            setCancelModalOpen(false);
            void load();
            onChanged();
          }}
        />
      ) : null}
    </Modal>
  );
}

function ChangeTierModal({
  userId,
  currentTier,
  getAccessTokenSilently,
  onClose,
  onDone,
}: {
  userId: string;
  currentTier: string;
  getAccessTokenSilently: GetAccessToken;
  onClose: () => void;
  onDone: () => void;
}) {
  const [tier, setTier] = useState(currentTier === "pro" ? "pro" : "free");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await adminMutate(
        `/api/admin/users/${userId}/tier`,
        "PATCH",
        getAccessTokenSilently,
        { tier },
      );
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't change tier.");
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} size="sm" title="Change tier">
      <div className="admin-form">
        <label className="admin-field">
          <span className="admin-field-label">Tier</span>
          <select value={tier} onChange={(e) => setTier(e.target.value)}>
            <option value="free">free</option>
            <option value="pro">pro</option>
          </select>
        </label>
        {error ? <p className="admin-error-text">{error}</p> : null}
        <div className="admin-actions">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function CancelSubscriptionModal({
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
      setError(
        err instanceof Error ? err.message : "Couldn't cancel the subscription.",
      );
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} size="sm" title="Cancel subscription?">
      <p className="admin-muted">
        This immediately cancels the subscription in Stripe and downgrades the
        user to Free. This cannot be undone.
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

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="admin-detail-row">
      <span className="admin-detail-label">{label}</span>
      <span>{value}</span>
    </div>
  );
}
