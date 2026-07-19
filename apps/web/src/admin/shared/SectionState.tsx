import { Card } from "../../ui/Card";
import { isAdminForbidden } from "./adminApi";

export function SectionError({ error }: { error: unknown }) {
  if (isAdminForbidden(error)) {
    return (
      <Card variant="outlined" padding="md">
        <p className="admin-muted">
          You don&apos;t have admin access. Ask an existing admin to grant it.
        </p>
      </Card>
    );
  }
  const msg =
    error instanceof Error ? error.message : "Something went wrong.";
  return (
    <Card variant="outlined" padding="md">
      <p className="admin-error-text">{msg}</p>
    </Card>
  );
}

export function SectionLoading() {
  return <p className="admin-muted">Loading…</p>;
}
