import { useCallback, useEffect, useState } from "react";

import { Badge } from "../../ui/Badge";
import { Modal } from "../../ui/Modal";
import { adminFetch, type GetAccessToken } from "../shared/adminApi";
import { formatDate, statusBadgeVariant } from "../shared/formatters";
import { SectionError, SectionLoading } from "../shared/SectionState";

type IntegrationRow = {
  id: string;
  userId: string;
  email: string | null;
  integrationType: string;
  status: string;
  includeInProjects: boolean;
  config: Record<string, unknown>;
  createdAt: string;
};

const TYPES = [
  "sendgrid",
  "openai",
  "anthropic",
  "wordpress",
  "openclaw",
  "auth0",
  "stripe",
  "github",
];

export function IntegrationsSection({
  getAccessTokenSilently,
}: {
  getAccessTokenSilently: GetAccessToken;
}) {
  const [rows, setRows] = useState<IntegrationRow[]>([]);
  const [type, setType] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [configRow, setConfigRow] = useState<IntegrationRow | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "100" });
      if (type) params.set("type", type);
      if (status) params.set("status", status);
      const data = await adminFetch<{ integrations: IntegrationRow[] }>(
        `/api/admin/integrations?${params.toString()}`,
        getAccessTokenSilently,
      );
      setRows(data.integrations);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [type, status, getAccessTokenSilently]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="admin-section">
      <div className="admin-toolbar">
        <select value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">All types</option>
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          <option value="pending">pending</option>
          <option value="validated">validated</option>
          <option value="failed">failed</option>
        </select>
      </div>

      {error ? <SectionError error={error} /> : null}

      {loading && rows.length === 0 ? (
        <SectionLoading />
      ) : rows.length === 0 && !error ? (
        <p className="admin-muted">No integrations.</p>
      ) : rows.length > 0 ? (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Type</th>
                <th>Status</th>
                <th>In projects</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((i) => (
                <tr
                  key={i.id}
                  className="admin-row-clickable"
                  onClick={() => setConfigRow(i)}
                >
                  <td className="admin-mono">{i.email ?? "—"}</td>
                  <td>
                    <Badge variant="info">{i.integrationType}</Badge>
                  </td>
                  <td>
                    <Badge variant={statusBadgeVariant(i.status)}>
                      {i.status}
                    </Badge>
                  </td>
                  <td>{i.includeInProjects ? "Yes" : "No"}</td>
                  <td className="admin-muted">{formatDate(i.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {configRow ? (
        <Modal
          open
          onClose={() => setConfigRow(null)}
          size="md"
          title={`${configRow.integrationType} config`}
        >
          <p className="admin-muted">
            Read-only. Secrets are never stored here — credential-bearing types
            reference a Vault secret id, not the secret itself.
          </p>
          <pre className="admin-json">
            {JSON.stringify(configRow.config, null, 2)}
          </pre>
        </Modal>
      ) : null}
    </div>
  );
}
