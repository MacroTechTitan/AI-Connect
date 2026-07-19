import { Fragment, useCallback, useEffect, useState } from "react";

import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import {
  adminFetch,
  adminMutate,
  type GetAccessToken,
} from "../shared/adminApi";
import { formatDate, truncate } from "../shared/formatters";
import { SectionError, SectionLoading } from "../shared/SectionState";

type WebhookRow = {
  id: string;
  eventType: string;
  receivedAt: string;
  processed: boolean;
  processedAt: string | null;
  processingError: string | null;
  payload: unknown;
};

type Tab = "stripe" | "github";

export function WebhooksSection({
  getAccessTokenSilently,
}: {
  getAccessTokenSilently: GetAccessToken;
}) {
  const [tab, setTab] = useState<Tab>("stripe");

  return (
    <div className="admin-section">
      <div className="admin-tabs">
        <button
          type="button"
          className={`admin-tab${tab === "stripe" ? " admin-tab--active" : ""}`}
          onClick={() => setTab("stripe")}
        >
          Stripe
        </button>
        <button
          type="button"
          className={`admin-tab${tab === "github" ? " admin-tab--active" : ""}`}
          onClick={() => setTab("github")}
        >
          GitHub
        </button>
      </div>
      {/* Remount per tab so filters/state reset cleanly. */}
      <WebhookTable
        key={tab}
        provider={tab}
        getAccessTokenSilently={getAccessTokenSilently}
      />
    </div>
  );
}

function WebhookTable({
  provider,
  getAccessTokenSilently,
}: {
  provider: Tab;
  getAccessTokenSilently: GetAccessToken;
}) {
  const [rows, setRows] = useState<WebhookRow[]>([]);
  const [eventType, setEventType] = useState("");
  const [processed, setProcessed] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [retrying, setRetrying] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "100" });
      if (eventType) params.set("event_type", eventType);
      if (processed) params.set("processed", processed);
      const data = await adminFetch<{ events: WebhookRow[] }>(
        `/api/admin/webhooks/${provider}?${params.toString()}`,
        getAccessTokenSilently,
      );
      setRows(data.events);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [provider, eventType, processed, getAccessTokenSilently]);

  useEffect(() => {
    void load();
  }, [load]);

  async function retry(id: string) {
    setRetrying(id);
    try {
      await adminMutate(
        `/api/admin/webhooks/stripe/${id}/retry`,
        "POST",
        getAccessTokenSilently,
      );
      await load();
    } catch {
      // surface via a refresh; keep it simple
    } finally {
      setRetrying(null);
    }
  }

  return (
    <>
      <div className="admin-toolbar">
        <input
          className="admin-input"
          placeholder="event_type"
          value={eventType}
          onChange={(e) => setEventType(e.target.value)}
        />
        <select value={processed} onChange={(e) => setProcessed(e.target.value)}>
          <option value="">All</option>
          <option value="true">Processed</option>
          <option value="false">Unprocessed</option>
        </select>
      </div>

      {error ? <SectionError error={error} /> : null}

      {loading && rows.length === 0 ? (
        <SectionLoading />
      ) : rows.length === 0 && !error ? (
        <p className="admin-muted">No events.</p>
      ) : rows.length > 0 ? (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Received</th>
                <th>Event</th>
                <th>Processed</th>
                <th>Error</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <Fragment key={e.id}>
                  <tr>
                    <td className="admin-muted admin-nowrap">
                      {formatDate(e.receivedAt)}
                    </td>
                    <td>
                      <Badge variant="info">{e.eventType}</Badge>
                    </td>
                    <td>
                      <Badge variant={e.processed ? "success" : "warning"}>
                        {e.processed ? "yes" : "no"}
                      </Badge>
                    </td>
                    <td className="admin-error-text">
                      {truncate(e.processingError, 60)}
                    </td>
                    <td className="admin-nowrap">
                      <button
                        type="button"
                        className="linklike"
                        onClick={() =>
                          setExpanded((p) => ({ ...p, [e.id]: !p[e.id] }))
                        }
                      >
                        {expanded[e.id] ? "Hide" : "Payload"}
                      </button>
                      {provider === "stripe" && !e.processed ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          loading={retrying === e.id}
                          onClick={() => void retry(e.id)}
                        >
                          Retry
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                  {expanded[e.id] ? (
                    <tr>
                      <td colSpan={5}>
                        <pre className="admin-json">
                          {JSON.stringify(e.payload, null, 2)}
                        </pre>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {provider === "stripe" ? (
        <p className="admin-muted">
          Retry resets the event to unprocessed. Full synchronous
          re-processing is Sprint 10.5+.
        </p>
      ) : null}
    </>
  );
}
