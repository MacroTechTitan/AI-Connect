import "./Modal.css";
import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

export type ModalSize = "sm" | "md" | "lg" | "xl";

export type ModalProps = {
  open: boolean;
  onClose: () => void;
  title?: string;
  size?: ModalSize;
  closeOnBackdrop?: boolean;
  closeOnEscape?: boolean;
  showCloseButton?: boolean;
  children: ReactNode;
};

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input:not([disabled]), select, [tabindex]:not([tabindex="-1"])';

export function Modal({
  open,
  onClose,
  title,
  size = "md",
  closeOnBackdrop = true,
  closeOnEscape = true,
  showCloseButton = true,
  children,
}: ModalProps) {
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const content = contentRef.current;

    // Move focus into the modal on open — first focusable, else the dialog.
    const initial = content?.querySelectorAll<HTMLElement>(FOCUSABLE);
    (initial && initial.length > 0 ? initial[0] : content)?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && closeOnEscape) {
        onClose();
        return;
      }
      if (e.key !== "Tab" || !content) return;
      const items = content.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, closeOnEscape, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="ai-modal__backdrop"
      onClick={() => {
        if (closeOnBackdrop) onClose();
      }}
    >
      <div
        ref={contentRef}
        className={`ai-modal ai-modal--${size}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        {title || showCloseButton ? (
          <div className="ai-modal__head">
            {title ? <h3 className="ai-modal__title">{title}</h3> : <span />}
            {showCloseButton ? (
              <button
                type="button"
                className="ai-modal__close"
                aria-label="Close"
                onClick={onClose}
              >
                ×
              </button>
            ) : null}
          </div>
        ) : null}
        <div className="ai-modal__body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
