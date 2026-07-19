import type { BadgeVariant } from "../../ui/Badge";

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

export function tierBadgeVariant(tier: string | null | undefined): BadgeVariant {
  if (tier === "pro") return "success";
  if (tier === "free") return "neutral";
  return "neutral";
}

export function statusBadgeVariant(
  status: string | null | undefined,
): BadgeVariant {
  switch (status) {
    case "active":
      return "success";
    case "trialing":
      return "info";
    case "past_due":
    case "incomplete":
      return "warning";
    case "canceled":
      return "error";
    default:
      return "neutral";
  }
}

export function levelBadgeVariant(level: string): BadgeVariant {
  switch (level) {
    case "info":
      return "info";
    case "warn":
      return "warning";
    case "error":
    case "critical":
      return "error";
    default:
      return "neutral";
  }
}

export function truncate(s: string | null | undefined, n = 80): string {
  if (!s) return "";
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
