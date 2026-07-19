import { useEffect, useState } from "react";

import { Card } from "../../ui/Card";
import { adminFetch, type GetAccessToken } from "../shared/adminApi";
import { SectionError, SectionLoading } from "../shared/SectionState";

type DashboardData = {
  users: { total: number; pro: number; free: number };
  integrations: { total: number };
  projects: { total: number };
};

export function DashboardSection({
  getAccessTokenSilently,
}: {
  getAccessTokenSilently: GetAccessToken;
}) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    adminFetch<DashboardData>("/api/admin/dashboard", getAccessTokenSilently)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err) => {
        if (!cancelled) setError(err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [getAccessTokenSilently]);

  if (loading) return <SectionLoading />;
  if (error) return <SectionError error={error} />;
  if (!data) return null;

  return (
    <div className="admin-stat-grid">
      <Card variant="default" padding="md">
        <h3 className="admin-stat-label">Users</h3>
        <p className="admin-stat">{data.users.total}</p>
        <p className="admin-muted">
          Pro: {data.users.pro} · Free: {data.users.free}
        </p>
      </Card>
      <Card variant="default" padding="md">
        <h3 className="admin-stat-label">Integrations</h3>
        <p className="admin-stat">{data.integrations.total}</p>
      </Card>
      <Card variant="default" padding="md">
        <h3 className="admin-stat-label">Projects</h3>
        <p className="admin-stat">{data.projects.total}</p>
      </Card>
    </div>
  );
}
