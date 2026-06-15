import type {
  IntegrationType,
  IntegrationValidator,
  IntegrationValidationResult,
} from "./types.js";

// Stub validator for Commit 3. Per-type validators land in Commits 4-7.
const stubValidator: IntegrationValidator = async () => ({
  valid: true,
});

const VALIDATORS: Record<IntegrationType, IntegrationValidator> = {
  sendgrid: stubValidator,
  openai: stubValidator,
  anthropic: stubValidator,
  wordpress: stubValidator,
};

export function getIntegrationValidator(
  type: IntegrationType,
): IntegrationValidator {
  return VALIDATORS[type];
}

export type {
  IntegrationType,
  IntegrationValidator,
  IntegrationValidationResult,
};
