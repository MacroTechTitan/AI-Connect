import "./Pill.css";
import type { ReactNode } from "react";

export type PillVariant = "success" | "warning" | "error" | "info" | "neutral";
export type PillSize = "sm" | "md";

export type PillProps = {
  variant?: PillVariant;
  size?: PillSize;
  children: ReactNode;
};

export function Pill({ variant = "neutral", size = "md", children }: PillProps) {
  return (
    <span className={`ai-pill ai-pill--${variant} ai-pill--${size}`}>
      {children}
    </span>
  );
}
