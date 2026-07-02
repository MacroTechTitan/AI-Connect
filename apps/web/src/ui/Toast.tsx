import "./Toast.css";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type ToastVariant = "success" | "error" | "info" | "warning";

export type ToastOptions = {
  title?: string;
  description?: string;
  duration?: number; // ms; 0 = persistent. Default 4000.
  action?: { label: string; onClick: () => void };
};

export type ToastApi = {
  success: (options: ToastOptions) => string;
  error: (options: ToastOptions) => string;
  info: (options: ToastOptions) => string;
  warning: (options: ToastOptions) => string;
  dismiss: (id: string) => void;
};

type ToastItem = ToastOptions & { id: string; variant: ToastVariant };

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): { toast: ToastApi } {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within a <ToastProvider>.");
  }
  return { toast: ctx };
}

const DEFAULT_DURATION = 4000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const counter = useRef(0);
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timers.current[id];
    if (timer) {
      clearTimeout(timer);
      delete timers.current[id];
    }
  }, []);

  const push = useCallback(
    (variant: ToastVariant, options: ToastOptions): string => {
      const id = `toast-${counter.current++}`;
      setToasts((prev) => [...prev, { ...options, id, variant }]);
      const duration = options.duration ?? DEFAULT_DURATION;
      if (duration > 0) {
        timers.current[id] = setTimeout(() => dismiss(id), duration);
      }
      return id;
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (o) => push("success", o),
      error: (o) => push("error", o),
      info: (o) => push("info", o),
      warning: (o) => push("warning", o),
      dismiss,
    }),
    [push, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="ai-toast-container" role="region" aria-label="Notifications">
        {toasts.map((t) => (
          <div key={t.id} className={`ai-toast ai-toast--${t.variant}`} role="status">
            <div className="ai-toast__body">
              {t.title ? <div className="ai-toast__title">{t.title}</div> : null}
              {t.description ? (
                <div className="ai-toast__desc">{t.description}</div>
              ) : null}
            </div>
            {t.action ? (
              <button
                type="button"
                className="ai-toast__action"
                onClick={() => {
                  t.action!.onClick();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            ) : null}
            <button
              type="button"
              className="ai-toast__close"
              aria-label="Dismiss"
              onClick={() => dismiss(t.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
