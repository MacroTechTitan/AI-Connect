import { useState } from "react";

import { Button } from "../Button";
import { Wizard, type WizardStep } from "../Wizard";

const steps: WizardStep[] = [
  { id: "one", title: "First" },
  { id: "two", title: "Second" },
  { id: "three", title: "Done", optional: true },
];

export function WizardDemo() {
  const [step, setStep] = useState("one");
  // The last step renders its own action instead of the default footer.
  const customActionStep = "three";
  return (
    <Wizard
      steps={steps}
      currentStepId={step}
      onStepChange={setStep}
      onCancel={() => setStep("one")}
      onComplete={() => setStep("one")}
      hideFooter={step === customActionStep}
    >
      {step === customActionStep ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <p>
            This step uses <code>hideFooter</code> — it renders its own action
            below instead of the default Back/Continue footer.
          </p>
          <div style={{ display: "flex", gap: 12 }}>
            <Button variant="ghost" onClick={() => setStep("two")}>
              Back
            </Button>
            <Button onClick={() => setStep("one")}>Finish</Button>
          </div>
        </div>
      ) : (
        <p>
          Content for step <strong>{step}</strong>. Use Back / Continue to move
          between steps; the indicator marks completed steps with a check.
        </p>
      )}
    </Wizard>
  );
}
