import { useState } from "react";

import { Wizard, type WizardStep } from "../Wizard";

const steps: WizardStep[] = [
  { id: "one", title: "First" },
  { id: "two", title: "Second" },
  { id: "three", title: "Done", optional: true },
];

export function WizardDemo() {
  const [step, setStep] = useState("one");
  return (
    <Wizard
      steps={steps}
      currentStepId={step}
      onStepChange={setStep}
      onCancel={() => setStep("one")}
      onComplete={() => setStep("one")}
    >
      <p>
        Content for step <strong>{step}</strong>. Use Back / Continue to move
        between steps; the indicator marks completed steps with a check.
      </p>
    </Wizard>
  );
}
