import type {
  IntegrationType,
  IntegrationValidator,
  IntegrationValidationResult,
} from "./types.js";
import { sendgridValidator } from "./validators/sendgrid.js";
import { makeOpenAiValidator } from "./validators/openai.js";
import { makeAnthropicValidator } from "./validators/anthropic.js";
import { wordpressValidator } from "./validators/wordpress.js";
import { makeOpenClawValidator } from "./validators/openclaw.js";
import { makeAuth0Validator } from "./validators/auth0.js";

// Factory pattern: each entry takes a userId and returns a validator.
// Types that don't need userId (sendgrid, wordpress) ignore it; types that do
// (openai, anthropic) close over it for ownership checks.
type ValidatorFactory = (userId: string) => IntegrationValidator;

const VALIDATOR_FACTORIES: Record<IntegrationType, ValidatorFactory> = {
  sendgrid: () => sendgridValidator,
  openai: makeOpenAiValidator,
  anthropic: makeAnthropicValidator,
  wordpress: () => wordpressValidator,
  openclaw: makeOpenClawValidator,
  auth0: makeAuth0Validator,
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
