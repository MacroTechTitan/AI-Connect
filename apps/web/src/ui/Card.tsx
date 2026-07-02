import "./Card.css";
import type { MouseEvent, ReactNode } from "react";

export type CardVariant = "default" | "elevated" | "outlined";
export type CardPadding = "sm" | "md" | "lg" | "none";

export type CardProps = {
  variant?: CardVariant;
  padding?: CardPadding;
  interactive?: boolean;
  header?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
};

export function Card({
  variant = "default",
  padding = "md",
  interactive = false,
  header,
  footer,
  children,
  onClick,
}: CardProps) {
  const className = [
    "ai-card",
    `ai-card--${variant}`,
    `ai-card--pad-${padding}`,
    interactive ? "ai-card--interactive" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={className} onClick={onClick}>
      {header ? <div className="ai-card__header">{header}</div> : null}
      <div className="ai-card__body">{children}</div>
      {footer ? <div className="ai-card__footer">{footer}</div> : null}
    </div>
  );
}
