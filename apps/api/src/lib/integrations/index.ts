import type {
  IntegrationType,
  IntegrationValidator,
  IntegrationValidationResult,
} from "./types.js";
import { sendgridValidator } from "./validators/sendgrid.js";

// Stub validator for integration types whose real validators haven't shipped yet.
const stubValidator: IntegrationValidator = async () => ({
  valid: true,
});

const VALIDATORS: Record<IntegrationType, IntegrationValidator> = {
  sendgrid: sendgridValidator,
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
