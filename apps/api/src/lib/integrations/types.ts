export type IntegrationType =
  | "sendgrid"
  | "openai"
  | "anthropic"
  | "wordpress"
  | "openclaw";

export type IntegrationStatus = "pending" | "validated" | "failed";

// Config shape per integration type. validated at the application layer.
export type SendGridConfig = Record<string, never>; // {} — credential is in vault_secret_id
export type OpenAiConfig = { provider_key_id: string };
export type AnthropicConfig = { provider_key_id: string };
export type WordPressConfig = {
  site_url: string;
  modules?: WordPressModule[];
};
export type WordPressModule = {
  slug: string;
  title: string;
  source_url: string;
  required_memberpress_tier: string | null;
};
export type OpenClawConfig = {
  /** Absolute path to maximus-bridge/index.mjs */
  bridge_path: string;
  /** Default agent to use when not specified per-call */
  default_agent: string;
};
export type IntegrationConfig =
  | SendGridConfig
  | OpenAiConfig
  | AnthropicConfig
  | WordPressConfig
  | OpenClawConfig;

/** Identity returned by the OpenClaw validator on success. Shaped to satisfy
 * IntegrationValidationResult.identity (Record<string, unknown>). */
export type OpenClawIdentity = {
  default_agent: string;
  agent_count: number;
  openclaw_version?: string;
  bridge_version?: string;
};

export type IntegrationValidationResult = {
  valid: boolean;
  errorMessage?: string;
  identity?: Record<string, unknown>;
};

export type IntegrationValidator = (input: {
  integrationType: IntegrationType;
  credential?: string;
  config: IntegrationConfig;
}) => Promise<IntegrationValidationResult>;

export function isIntegrationType(value: unknown): value is IntegrationType {
  return (
    value === "sendgrid" ||
    value === "openai" ||
    value === "anthropic" ||
    value === "wordpress" ||
    value === "openclaw"
  );
}
