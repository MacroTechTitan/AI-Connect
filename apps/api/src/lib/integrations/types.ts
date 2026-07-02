export type IntegrationType =
  | "sendgrid"
  | "openai"
  | "anthropic"
  | "wordpress"
  | "openclaw"
  | "auth0";

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
/**
 * Auth0 integration configuration.
 *
 * domain — the Auth0 tenant domain (e.g. "yourtenant.us.auth0.com"). No
 *   protocol prefix; the validator/client adds https://.
 * m2m_client_id — the Machine-to-Machine application's client ID. Created in
 *   Auth0 Dashboard > Applications > Machine to Machine.
 * default_application_id — optional Auth0 app (client_id) to use as the default
 *   for new projects (set after wizard step 4).
 *
 * The M2M client_secret is NOT stored in config: like sendgrid/wordpress it is
 * passed as the `credential` at validation time and persisted via the
 * integration row's vault_secret_id (the validate-before-vault flow). Routes
 * read it back from the row's vault secret, never from config.
 */
export type Auth0Config = {
  domain: string;
  m2m_client_id: string;
  default_application_id?: string;
};
export type IntegrationConfig =
  | SendGridConfig
  | OpenAiConfig
  | AnthropicConfig
  | WordPressConfig
  | OpenClawConfig
  | Auth0Config;

/** Identity returned by the OpenClaw validator on success. Shaped to satisfy
 * IntegrationValidationResult.identity (Record<string, unknown>). */
export type OpenClawIdentity = {
  default_agent: string;
  agent_count: number;
  openclaw_version?: string;
  bridge_version?: string;
};

/** Identity returned by the Auth0 validator on success. */
export type Auth0Identity = {
  tenant_name: string; // e.g. "yourtenant"
  tenant_domain: string; // full domain
  application_count: number;
  default_application_id?: string;
  default_application_name?: string;
  m2m_scopes_verified: string[]; // scopes the M2M cred actually has
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
    value === "openclaw" ||
    value === "auth0"
  );
}
