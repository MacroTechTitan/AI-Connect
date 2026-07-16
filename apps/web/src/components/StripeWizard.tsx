import "./StripeWizard.css";
import { useState } from "react";

import { authedFetch, isSessionExpired, type GetAccessToken } from "../lib/api";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Input } from "../ui/Input";
import { Modal } from "../ui/Modal";
import { Wizard, type WizardStep } from "../ui/Wizard";
import { HelpLink } from "./HelpLink";
import { SessionExpiredNotice } from "./SessionExpiredNotice";

type BusinessType = "individual" | "company";

type StepId = "welcome" | "business" | "create" | "save" | "onboard";

const STEPS: WizardStep[] = [
  { id: "welcome", title: "Welcome" },
  { id: "business", title: "Business Info" },
  { id: "create", title: "Create Account" },
  { id: "save", title: "Save" },
  { id: "onboard", title: "Onboarding" },
];

// welcome + business drive Back/Continue via the default Wizard footer; the
// rest render their own contextual actions (hideFooter).
const FOOTER_STEPS = new Set<StepId>(["welcome", "business"]);

// Five-step wizard for connecting Stripe Connect. A controlled modal the parent
// gates with `{open ? <StripeWizard/> : null}`. Built on the design-system
// primitives (Sprint 8), same shape as Auth0Wizard.
export function StripeWizard({
  getAccessTokenSilently,
  onClose,
  onConnected,
  onManageAccount,
}: {
  getAccessTokenSilently: GetAccessToken;
  onClose: () => void;
  onConnected?: (integrationId: string) => void;
  onManageAccount?: (integrationId: string) => void;
}) {
  const [step, setStep] = useState<StepId>("welcome");
  const [sessionExpired, setSessionExpired] = useState(false);

  // Step "business"
  const [email, setEmail] = useState("");
  const [country, setCountry] = useState("");
  const [businessType, setBusinessType] = useState<BusinessType>("individual");

  // Step "create"
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);

  // Step "save"
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [integrationId, setIntegrationId] = useState<string | null>(null);

  // Step "onboard"
  const [loadingLink, setLoadingLink] = useState(false);
  const [onboardingUrl, setOnboardingUrl] = useState<string | null>(null);
  const [onboardError, setOnboardError] = useState<string | null>(null);

  // Runs on entering "create": creates the Express Connected Account, then
  // advances to "save".
  async function runCreate() {
    setCreateError(null);
    setCreating(true);
    try {
      const res = await authedFetch(
        "/api/integrations/stripe/create-express-account",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: email.trim(),
            country: country.trim().toUpperCase(),
            business_type: businessType,
          }),
        },
        getAccessTokenSilently,
      );
      if (!res.ok) {
        let msg = "Could not reach Stripe. Try again in a moment.";
        if (res.status < 500) {
          try {
            const body = (await res.json()) as {
              message?: string;
              error?: string;
            };
            msg = body.message ?? body.error ?? "Please check your input.";
          } catch {
            msg = "Please check your input.";
          }
        }
        setCreateError(msg);
        return;
      }
      const body = (await res.json()) as { account_id: string };
      setAccountId(body.account_id);
      goToSave(body.account_id);
    } catch (err) {
      if (isSessionExpired(err)) {
        setSessionExpired(true);
        return;
      }
      setCreateError("Could not reach Stripe. Try again in a moment.");
    } finally {
      setCreating(false);
    }
  }

  function goToSave(acctId: string) {
    setStep("save");
    void runSave(acctId);
  }

  // Runs on entering "save": persists the integration row, then advances to
  // "onboard".
  async function runSave(acctId: string) {
    setSaveError(null);
    setSaving(true);
    try {
      const res = await authedFetch(
        "/api/integrations",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            integration_type: "stripe",
            config: {
              stripe_account_id: acctId,
              business_type: businessType,
              country: country.trim().toUpperCase(),
            },
          }),
        },
        getAccessTokenSilently,
      );

      if (res.status === 409) {
        setSaveError(
          "You already have a Stripe integration. Remove it first to connect a different account.",
        );
        return;
      }
      if (!res.ok) {
        let msg = "Couldn't save the Stripe integration. Try again.";
        try {
          const body = (await res.json()) as {
            message?: string;
            reason?: string;
            error?: string;
          };
          msg = body.message ?? body.reason ?? body.error ?? msg;
        } catch {
          // keep default
        }
        setSaveError(msg);
        return;
      }

      const body = (await res.json()) as { id: string };
      setIntegrationId(body.id);
      // Signal the parent so the integrations list refreshes (matches the
      // timing of Auth0Wizard's onConnected on integration creation).
      onConnected?.(body.id);
      goToOnboard(body.id);
    } catch (err) {
      if (isSessionExpired(err)) {
        setSessionExpired(true);
        return;
      }
      setSaveError("Couldn't reach the server. Try again.");
    } finally {
      setSaving(false);
    }
  }

  function goToOnboard(intId: string) {
    setStep("onboard");
    void runOnboard(intId);
  }

  // Runs on entering "onboard": fetches the hosted onboarding URL.
  async function runOnboard(intId: string) {
    setOnboardError(null);
    setLoadingLink(true);
    try {
      const res = await authedFetch(
        `/api/integrations/${intId}/stripe/onboarding-link`,
        { method: "POST" },
        getAccessTokenSilently,
      );
      if (!res.ok) {
        let msg = "Couldn't generate the onboarding link.";
        try {
          const body = (await res.json()) as {
            message?: string;
            error?: string;
          };
          msg = body.message ?? body.error ?? msg;
        } catch {
          // keep default
        }
        setOnboardError(msg);
        return;
      }
      const body = (await res.json()) as { url: string };
      setOnboardingUrl(body.url);
    } catch (err) {
      if (isSessionExpired(err)) {
        setSessionExpired(true);
        return;
      }
      setOnboardError("Couldn't reach the server. Try again.");
    } finally {
      setLoadingLink(false);
    }
  }

  const canGoNext =
    step === "business"
      ? email.trim().length > 0 && country.trim().length === 2
      : true;

  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title="Connect Stripe"
      titleAccessory={<HelpLink articleId="stripe" label="Help — Stripe" />}
    >
      {sessionExpired ? (
        <SessionExpiredNotice />
      ) : (
        <Wizard
          steps={STEPS}
          currentStepId={step}
          // The default footer drives welcome→business→create. Entering "create"
          // kicks off account creation, which chains save → onboard itself.
          onStepChange={(id) => {
            const next = id as StepId;
            setStep(next);
            if (next === "create") void runCreate();
          }}
          onCancel={onClose}
          canGoNext={canGoNext}
          hideFooter={!FOOTER_STEPS.has(step)}
        >
          {step === "welcome" ? (
            <div className="sw-step">
              <p>
                Stripe Connect lets AI Connect create Stripe Express Connected
                Accounts for your projects, so the apps you provision can accept
                payments. Each project you provision gets its own account.
              </p>
              <Card variant="outlined" padding="sm">
                <p className="sw-muted">
                  You&apos;ll set up your business details, AI Connect will create
                  the Connected Account, and Stripe&apos;s hosted onboarding
                  handles identity verification and payout setup.
                </p>
              </Card>
            </div>
          ) : null}

          {step === "business" ? (
            <div className="sw-step">
              <p>Tell Stripe about the business that will accept payments.</p>
              <Input
                label="Business email"
                type="email"
                placeholder="you@yourcompany.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <Input
                label="Country"
                type="text"
                placeholder="US"
                helperText="Where is your business registered? Use a 2-letter ISO code (US, GB, CA, AU, etc.)"
                maxLength={2}
                value={country}
                onChange={(e) => setCountry(e.target.value.toUpperCase())}
              />
              <div className="sw-field">
                <span className="sw-field-label">Business type</span>
                <div className="sw-radios">
                  <label className="sw-radio">
                    <input
                      type="radio"
                      name="sw-business-type"
                      value="individual"
                      checked={businessType === "individual"}
                      onChange={() => setBusinessType("individual")}
                    />
                    <span>Individual</span>
                  </label>
                  <label className="sw-radio">
                    <input
                      type="radio"
                      name="sw-business-type"
                      value="company"
                      checked={businessType === "company"}
                      onChange={() => setBusinessType("company")}
                    />
                    <span>Company</span>
                  </label>
                </div>
              </div>
            </div>
          ) : null}

          {step === "create" ? (
            <div className="sw-step">
              {creating ? (
                <p>Creating your Stripe Connected Account…</p>
              ) : createError ? (
                <>
                  <p className="sw-error">{createError}</p>
                  <div className="sw-actions">
                    <Button variant="ghost" onClick={() => setStep("business")}>
                      Back
                    </Button>
                    <Button onClick={() => void runCreate()}>Retry</Button>
                  </div>
                </>
              ) : null}
            </div>
          ) : null}

          {step === "save" ? (
            <div className="sw-step">
              {saving ? (
                <p>Saving your Stripe integration…</p>
              ) : saveError ? (
                <>
                  <p className="sw-error">{saveError}</p>
                  <div className="sw-actions">
                    <Button variant="ghost" onClick={() => setStep("business")}>
                      Back
                    </Button>
                    <Button
                      onClick={() =>
                        accountId ? goToSave(accountId) : setStep("business")
                      }
                    >
                      Retry
                    </Button>
                  </div>
                </>
              ) : null}
            </div>
          ) : null}

          {step === "onboard" ? (
            <div className="sw-step">
              <Card variant="default" padding="md">
                <p>
                  <strong>Your Stripe account is created!</strong> Complete
                  Stripe&apos;s onboarding to start accepting payments.
                </p>
              </Card>

              {loadingLink ? (
                <p className="sw-muted">Preparing your onboarding link…</p>
              ) : onboardError ? (
                <>
                  <p className="sw-error">{onboardError}</p>
                  <div className="sw-actions">
                    <Button
                      onClick={() =>
                        integrationId ? void runOnboard(integrationId) : undefined
                      }
                    >
                      Retry
                    </Button>
                  </div>
                </>
              ) : onboardingUrl ? (
                <a
                  className="sw-onboard-link"
                  href={onboardingUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  <Button variant="primary">Complete Stripe Onboarding</Button>
                </a>
              ) : null}

              <div className="sw-actions">
                <Button
                  variant="ghost"
                  onClick={() => {
                    if (integrationId && onManageAccount) {
                      onManageAccount(integrationId);
                    } else {
                      onClose();
                    }
                  }}
                >
                  I&apos;ve completed onboarding
                </Button>
                <Button variant="ghost" onClick={onClose}>
                  Skip for now
                </Button>
              </div>
            </div>
          ) : null}
        </Wizard>
      )}
    </Modal>
  );
}
