import "./Wizard.css";
import type { ReactNode } from "react";

import { Button } from "./Button";

export type WizardStep = {
  id: string;
  title: string;
  optional?: boolean;
};

export type WizardProps = {
  steps: WizardStep[];
  currentStepId: string;
  onStepChange: (stepId: string) => void;
  onCancel?: () => void;
  onComplete?: () => void;
  children: ReactNode;
  canGoBack?: boolean;
  canGoNext?: boolean;
  nextLabel?: string;
  backLabel?: string;
  cancelLabel?: string;
  hideStepIndicator?: boolean;
  /**
   * If true, hides the default Back/Continue/Cancel footer. The step content
   * is expected to render its own primary actions (and drive onStepChange /
   * onCancel / onComplete itself). Useful for steps where the action is part
   * of the content (e.g. a "Test Connection" button). The step indicator is
   * still shown above the content.
   */
  hideFooter?: boolean;
};

export function Wizard({
  steps,
  currentStepId,
  onStepChange,
  onCancel,
  onComplete,
  children,
  canGoBack = true,
  canGoNext = true,
  nextLabel = "Continue",
  backLabel = "Back",
  cancelLabel = "Cancel",
  hideStepIndicator = false,
  hideFooter = false,
}: WizardProps) {
  const foundIndex = steps.findIndex((s) => s.id === currentStepId);
  const currentIndex = foundIndex < 0 ? 0 : foundIndex;
  const current = steps[currentIndex];
  const isFirst = currentIndex === 0;
  const isLast = currentIndex === steps.length - 1;

  function goBack() {
    const prev = steps[currentIndex - 1];
    if (prev) onStepChange(prev.id);
  }
  function goNext() {
    if (isLast) {
      onComplete?.();
      return;
    }
    const next = steps[currentIndex + 1];
    if (next) onStepChange(next.id);
  }

  return (
    <div className="ai-wizard">
      {!hideStepIndicator ? (
        <ol className="ai-wizard__steps">
          {steps.map((s, i) => {
            const state =
              i < currentIndex ? "done" : i === currentIndex ? "current" : "future";
            return (
              <li key={s.id} className={`ai-wizard__step ai-wizard__step--${state}`}>
                <span className="ai-wizard__dot" aria-hidden="true">
                  {i < currentIndex ? "✓" : i + 1}
                </span>
                <span className="ai-wizard__step-title">
                  {s.title}
                  {s.optional ? (
                    <span className="ai-wizard__optional"> (optional)</span>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ol>
      ) : null}

      {current ? <h3 className="ai-wizard__title">{current.title}</h3> : null}

      <div className="ai-wizard__content">{children}</div>

      {!hideFooter ? (
        <div className="ai-wizard__footer">
          <div className="ai-wizard__footer-left">
            {onCancel ? (
              <Button variant="ghost" onClick={onCancel}>
                {cancelLabel}
              </Button>
            ) : null}
          </div>
          <div className="ai-wizard__footer-right">
            {canGoBack && !isFirst ? (
              <Button variant="secondary" onClick={goBack}>
                {backLabel}
              </Button>
            ) : null}
            <Button variant="primary" onClick={goNext} disabled={!canGoNext}>
              {isLast ? "Complete" : nextLabel}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
