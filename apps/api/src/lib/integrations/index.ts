import type {
  IntegrationType,
  IntegrationValidator,
  IntegrationValidationResult,
} from "./types.js";
import { sendgridValidator } from "./validators/sendgrid.js";
import { makeOpenAiValidator } from "./validators/openai.js";
import { makeAnthropicValidator } from "./validators/anthropic.js";

// Stub validator for integration types whose real validators haven't shipped yet.
const stubValidator: IntegrationValidator = async () => ({
  valid: true,
});

// Factory pattern: each entry takes a userId and returns a validator.
// Types that don't need userId (sendgrid, stubs) ignore it; types that do
// (openai, anthropic) close over it for ownership checks.
type ValidatorFactory = (userId: string) => IntegrationValidator;

const VALIDATOR_FACTORIES: Record<IntegrationType, ValidatorFactory> = {
  sendgrid: () => sendgridValidator,
  openai: makeOpenAiValidator,
  anthropic: makeAnthropicValidator,
  wordpress: () => stubValidator, // real one lands in Commit 8/9
};

export function getIntegrationValidator(
  type: IntegrationType,
  userId: string,
): IntegrationValidator {
  return VALIDATOR_FACTORIES[type](userId);
}

export type {
  IntegrationType,
  IntegrationValidator,
  IntegrationValidationResult,
};
