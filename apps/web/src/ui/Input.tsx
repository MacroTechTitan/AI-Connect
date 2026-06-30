import "./Input.css";
import { useId, type ChangeEvent, type FocusEvent, type ReactNode } from "react";

export type InputProps = {
  id?: string;
  label?: string;
  helperText?: string;
  errorText?: string;
  prefix?: ReactNode;
  suffix?: ReactNode;
  type?: "text" | "email" | "password" | "number" | "url";
  placeholder?: string;
  value?: string;
  onChange?: (e: ChangeEvent<HTMLInputElement>) => void;
  onBlur?: (e: FocusEvent<HTMLInputElement>) => void;
  disabled?: boolean;
  required?: boolean;
  autoComplete?: string;
  maxLength?: number;
};

export function Input({
  id,
  label,
  helperText,
  errorText,
  prefix,
  suffix,
  type = "text",
  placeholder,
  value,
  onChange,
  onBlur,
  disabled,
  required,
  autoComplete,
  maxLength,
}: InputProps) {
  const reactId = useId();
  const inputId = id ?? reactId;
  const hasError = Boolean(errorText);
  const describedBy = hasError
    ? `${inputId}-error`
    : helperText
      ? `${inputId}-help`
      : undefined;

  return (
    <div
      className={[
        "ai-input",
        disabled ? "ai-input--disabled" : "",
        hasError ? "ai-input--error" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {label ? (
        <label className="ai-input__label" htmlFor={inputId}>
          {label}
          {required ? (
            <span className="ai-input__req" aria-hidden="true">
              {" "}
              *
            </span>
          ) : null}
        </label>
      ) : null}
      <div className="ai-input__wrap">
        {prefix ? (
          <span className="ai-input__affix ai-input__prefix">{prefix}</span>
        ) : null}
        <input
          id={inputId}
          className="ai-input__field"
          type={type}
          placeholder={placeholder}
          value={value}
          onChange={onChange}
          onBlur={onBlur}
          disabled={disabled}
          required={required}
          autoComplete={autoComplete}
          maxLength={maxLength}
          aria-invalid={hasError || undefined}
          aria-describedby={describedBy}
        />
        {suffix ? (
          <span className="ai-input__affix ai-input__suffix">{suffix}</span>
        ) : null}
      </div>
      {hasError ? (
        <p id={`${inputId}-error`} className="ai-input__error">
          {errorText}
        </p>
      ) : helperText ? (
        <p id={`${inputId}-help`} className="ai-input__help">
          {helperText}
        </p>
      ) : null}
    </div>
  );
}
