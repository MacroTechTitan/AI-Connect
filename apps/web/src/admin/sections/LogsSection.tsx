import { Fragment, useCallback, useEffect, useState } from "react";

import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { Pill } from "../../ui/Pill";
import { adminFetch, type GetAccessToken } from "../shared/adminApi";
import { formatDate, levelBadgeVariant, truncate } from "../shared/formatters";
import { SectionError, SectionLoading } from "../shared/SectionState";

type LogRow = {
  id: string;
  level: string;
  category: string;
  message: string;
  context: unknown;
  createdAt: string;
};

const PAGE = 50;
const LEVELS = ["debug", "info", "warn", "error", "critical"];

export function LogsSection({
  getAccessTokenSilently,
}: {
  getAccessTokenSilently: GetAccessToken;
}) {
  const [rows, setRows] = useState<LogRow[]>([]);
  const [offset, setOffset] = useState(0);
  const [category, setCategory] = useState("");
  const [level, setLevel] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [hasMore, setHasMore] = useState(false);

  const load = useCallback(
    async (nextOffset: number, replace: boolean) => {
      setError(null);
      setLoading(true);
      try {
        const params = new URLSearchParams({
          limit: String(PAGE),
          offset: String(nextOffset),
        });
        if (category) params.set("category", category);
        if (level) params.set("level", level);
        if (from) params.set("from", new Date(from).toISOString());
        if (to) params.set("to", new Date(to).toISOString());
        const data = await adminFetch<{ logs: LogRow[] }>(
          `/api/admin/logs?${params.toString()}`,
          getAccessTokenSilently,
        );
        setRows((prev) => (replace ? data.logs : [...prev, ...data.logs]));
        setHasMore(data.logs.length === PAGE);
        setOffset(nextOffset);
      } catch (err) {
        setError(err);
      } finally {
        setLoading(false);
      }
    },
    [category, level, from, to, getAccessTokenSilently],
  );

  useEffect(() => {
    void load(0, true);
  }, [load]);

  return (
    <div className="admin-section">
      <div className="admin-toolbar admin-toolbar--wrap">
        <input
          className="admin-input"
          placeholder="category (e.g. genesis)"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        />
        <select value={level} onChange={(e) => setLevel(e.target.value)}>
          <option value="">All levels</option>
          {LEVELS.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
        <label className="admin-datefield">
          <span>From</span>
          <input
            type="datetime-local"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label className="admin-datefield">
          <span>To</span>
          <input
            type="datetime-local"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
      </div>

      {error ? <SectionError error={error} /> : null}

      {loading && rows.length === 0 ? (
        <SectionLoading />
      ) : rows.length === 0 && !error ? (
        <p className="admin-muted">No logs.</p>
      ) : rows.length > 0 ? (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Level</th>
                <th>Category</th>
                <th>Message</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((l) => (
                <Fragment key={l.id}>
                  <tr>
                    <td className="admin-muted admin-nowrap">
                      {formatDate(l.createdAt)}
                    </td>
                    <td>
                      <Badge variant={levelBadgeVariant(l.level)}>
                        {l.level}
                      </Badge>
                    </td>
                    <td>
                      <Pill variant="neutral" size="sm">
                        {l.category}
                      </Pill>
                    </td>
                    <td>{truncate(l.message, 100)}</td>
                    <td>
                      {l.context != null ? (
                        <button
                          type="button"
                          className="linklike"
                          onClick={() =>
                            setExpanded((p) => ({ ...p, [l.id]: !p[l.id] }))
                          }
                        >
                          {expanded[l.id] ? "Hide" : "Context"}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                  {expanded[l.id] && l.context != null ? (
                    <tr>
                      <td colSpan={5}>
                        <pre className="admin-json">
                          {JSON.stringify(l.context, null, 2)}
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

      {hasMore ? (
        <Button
          variant="ghost"
          loading={loading}
          onClick={() => void load(offset + PAGE, false)}
        >
          Show older
        </Button>
      ) : null}
    </div>
  );
}
