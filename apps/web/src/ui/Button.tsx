import "./Button.css";
import type { MouseEvent, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export type ButtonProps = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  disabled?: boolean;
  fullWidth?: boolean;
  startIcon?: ReactNode;
  endIcon?: ReactNode;
  children: ReactNode;
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
  type?: "button" | "submit" | "reset";
};

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  disabled = false,
  fullWidth = false,
  startIcon,
  endIcon,
  children,
  onClick,
  type = "button",
}: ButtonProps) {
  const className = [
    "ai-btn",
    `ai-btn--${variant}`,
    `ai-btn--${size}`,
    fullWidth ? "ai-btn--full" : "",
    loading ? "ai-btn--loading" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      type={type}
      className={className}
      onClick={onClick}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {loading ? (
        <span className="ai-btn__spinner" aria-hidden="true" />
      ) : startIcon ? (
        <span className="ai-btn__icon">{startIcon}</span>
      ) : null}
      <span className="ai-btn__label">{children}</span>
      {!loading && endIcon ? <span className="ai-btn__icon">{endIcon}</span> : null}
    </button>
  );
}
