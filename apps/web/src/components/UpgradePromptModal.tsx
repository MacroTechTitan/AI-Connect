import "./UpgradePromptModal.css";

import { useState } from "react";

import { isSessionExpired, type GetAccessToken } from "../lib/api";
import { startCheckout } from "../lib/subscription";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Modal } from "../ui/Modal";

type UpgradePromptModalProps = {
  open: boolean;
  onClose: () => void;
  reason: string;
  limitHit: string;
  getAccessTokenSilently: GetAccessToken;
};

const PRO_BENEFITS = [
  "Unlimited integrations",
  "Unlimited projects",
  "All connectors (OpenClaw, Auth0, Stripe)",
];

// Context-aware copy per limit code, falling back to the API's own message.
function explain(limitHit: string, reason: string): string {
  switch (limitHit) {
    case "max_integrations":
      return "The Free plan is limited to 2 integrations. You have 2 already. Upgrade to Pro for unlimited integrations.";
    case "max_projects":
      return "The Free plan is limited to 1 project. Upgrade to Pro to create more.";
    case "integration_type_not_allowed":
      return "This integration type is Pro-only. Upgrade to Pro to use it.";
    default:
      return reason;
  }
}

export function UpgradePromptModal({
  open,
  onClose,
  reason,
  limitHit,
  getAccessTokenSilently,
}: UpgradePromptModalProps) {
  const [inFlight, setInFlight] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleUpgrade() {
    setError(null);
    setInFlight(true);
    try {
      await startCheckout(getAccessTokenSilently);
      // On success the browser navigates to Stripe.
    } catch (err) {
      if (isSessionExpired(err)) {
        setError("Your session expired. Please sign in again.");
        setInFlight(false);
        return;
      }
      setError(err instanceof Error ? err.message : "Couldn't start checkout.");
      setInFlight(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Upgrade to Pro" size="md">
      <p className="upgrade-modal__copy">{explain(limitHit, reason)}</p>

      <Card variant="outlined" padding="sm">
        <p className="upgrade-modal__benefits-title">Pro includes</p>
        <ul className="upgrade-modal__benefits">
          {PRO_BENEFITS.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      </Card>

      {error ? <p className="upgrade-modal__error">{error}</p> : null}

      <div className="upgrade-modal__actions">
        <Button variant="ghost" onClick={onClose}>
          Maybe later
        </Button>
        <Button
          variant="primary"
          loading={inFlight}
          onClick={() => void handleUpgrade()}
        >
          Upgrade to Pro — $49/mo
        </Button>
      </div>
    </Modal>
  );
}
