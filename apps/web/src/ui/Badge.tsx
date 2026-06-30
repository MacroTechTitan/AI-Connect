import "./Badge.css";
import type { ReactNode } from "react";

export type BadgeVariant = "success" | "warning" | "error" | "info" | "neutral";

export type BadgeProps = {
  variant?: BadgeVariant;
  children: ReactNode;
};

export function Badge({ variant = "neutral", children }: BadgeProps) {
  return <span className={`ai-badge ai-badge--${variant}`}>{children}</span>;
}
