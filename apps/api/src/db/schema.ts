import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    email: text("email").notNull().unique(),
    role: text("role").notNull().default("user"),
    organizationId: uuid("organization_id").references(
      (): AnyPgColumn => organizations.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  },
  (table) => ({
    organizationIdIdx: index("idx_users_organization_id").on(
      table.organizationId,
    ),
  }),
);

export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references((): AnyPgColumn => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    createdByIdx: index("idx_organizations_created_by").on(
      table.createdByUserId,
    ),
  }),
);

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    provisioningState: text("provisioning_state")
      .notNull()
      .default("not_started"),
    // Which Project Genesis template the user picked at creation time.
    // Existing projects default to 'html-js' (the simplest template).
    templateChoice: text("template_choice").notNull().default("html-js"),
    // Provisioned subdomain (e.g. 'aic-smoke-test'); the full URL is built at
    // runtime by appending CLOUDFLARE_BASE_DOMAIN. NULL until DNS is wired.
    // Sprint 5.7: unused — DNS automation deferred until a dedicated short
    // domain is acquired. Kept for forward compatibility; deployedUrl is the
    // displayed URL now.
    subdomain: text("subdomain"),
    // Sprint 5.7: the project's live URL (Render's onrender.com URL). Written at
    // create_render_service time and shown in the frontend. NULL until the
    // Render service is created.
    deployedUrl: text("deployed_url"),
    // Sprint 9: the Stripe Express Connected Account ID (e.g. 'acct_1AbC...')
    // created for this project's Stripe wiring. NULL for projects without
    // Stripe wiring. Stripe IDs live in Stripe's API, so no FK here.
    stripeAccountId: text("stripe_account_id"),
    // Sprint 9: reflects the Connect account.updated webhook state. NULL until
    // a Stripe account is wired.
    stripeAccountStatus: text("stripe_account_status"),
    // References a vault.secrets entry holding the project's Supabase Postgres
    // connection string. NULL until create_supabase_project captures it.
    databaseConnectionStringVaultId: uuid("database_connection_string_vault_id"),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    provisioningStateCheck: check(
      "projects_provisioning_state_check",
      sql`${table.provisioningState} IN ('not_started', 'provisioning', 'provisioned', 'failed', 'rolled_back')`,
    ),
    templateChoiceCheck: check(
      "projects_template_choice_check",
      sql`${table.templateChoice} IN ('html-js', 'sveltekit', 'nextjs')`,
    ),
    stripeAccountStatusCheck: check(
      "projects_stripe_account_status_check",
      sql`${table.stripeAccountStatus} IS NULL OR ${table.stripeAccountStatus} IN ('pending', 'active', 'restricted')`,
    ),
    organizationIdIdx: index("idx_projects_organization_id").on(
      table.organizationId,
    ),
    createdByIdx: index("idx_projects_created_by").on(table.createdByUserId),
    orgSlugUnique: unique("projects_organization_id_slug_unique").on(
      table.organizationId,
      table.slug,
    ),
    subdomainUnique: unique("projects_subdomain_unique").on(table.subdomain),
    provisioningStateIdx: index("idx_projects_provisioning_state")
      .on(table.provisioningState)
      .where(sql`${table.provisioningState} != 'not_started'`),
    subdomainIdx: index("idx_projects_subdomain")
      .on(table.subdomain)
      .where(sql`${table.subdomain} IS NOT NULL`),
    // Sprint 9: the account.updated webhook looks up projects by their Stripe
    // Connected Account ID; index it so the sync isn't a full table scan.
    stripeAccountIdIdx: index("projects_stripe_account_id_idx")
      .on(table.stripeAccountId)
      .where(sql`${table.stripeAccountId} IS NOT NULL`),
  }),
);

export const systemLogs = pgTable(
  "system_logs",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    level: text("level").notNull(),
    category: text("category").notNull(),
    message: text("message").notNull(),
    context: jsonb("context"),
    traceId: uuid("trace_id"),
    organizationId: uuid("organization_id").references(
      () => organizations.id,
      { onDelete: "set null" },
    ),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    levelCheck: check(
      "system_logs_level_check",
      sql`${table.level} IN ('debug', 'info', 'warn', 'error', 'critical')`,
    ),
    occurredAtLevelIdx: index("system_logs_occurred_at_level_idx").on(
      table.occurredAt,
      table.level,
    ),
    categoryOccurredAtIdx: index("system_logs_category_occurred_at_idx").on(
      table.category,
      table.occurredAt,
    ),
    organizationIdIdx: index("idx_system_logs_organization_id")
      .on(table.organizationId)
      .where(sql`${table.organizationId} IS NOT NULL`),
    projectIdIdx: index("idx_system_logs_project_id")
      .on(table.projectId)
      .where(sql`${table.projectId} IS NOT NULL`),
  }),
);

export const userAuditLogs = pgTable(
  "user_audit_logs",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    context: jsonb("context"),
    traceId: uuid("trace_id"),
    organizationId: uuid("organization_id").references(
      () => organizations.id,
      { onDelete: "set null" },
    ),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    userIdOccurredAtIdx: index("user_audit_logs_user_id_occurred_at_idx").on(
      table.userId,
      table.occurredAt,
    ),
    actionOccurredAtIdx: index("user_audit_logs_action_occurred_at_idx").on(
      table.action,
      table.occurredAt,
    ),
    organizationIdIdx: index("idx_user_audit_logs_organization_id").on(
      table.organizationId,
    ),
    projectIdIdx: index("idx_user_audit_logs_project_id")
      .on(table.projectId)
      .where(sql`${table.projectId} IS NOT NULL`),
  }),
);

export const devLogs = pgTable(
  "dev_logs",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    source: text("source").notNull(),
    category: text("category").notNull(),
    message: text("message").notNull(),
    context: jsonb("context"),
    traceId: uuid("trace_id"),
    organizationId: uuid("organization_id").references(
      () => organizations.id,
      { onDelete: "set null" },
    ),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    sourceOccurredAtIdx: index("dev_logs_source_occurred_at_idx").on(
      table.source,
      table.occurredAt,
    ),
    categoryOccurredAtIdx: index("dev_logs_category_occurred_at_idx").on(
      table.category,
      table.occurredAt,
    ),
    organizationIdIdx: index("idx_dev_logs_organization_id")
      .on(table.organizationId)
      .where(sql`${table.organizationId} IS NOT NULL`),
    projectIdIdx: index("idx_dev_logs_project_id")
      .on(table.projectId)
      .where(sql`${table.projectId} IS NOT NULL`),
  }),
);

export const providerKeys = pgTable(
  "provider_keys",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id").references(
      () => organizations.id,
      { onDelete: "set null" },
    ),
    provider: text("provider").notNull(),
    label: text("label").notNull(),
    vaultSecretId: uuid("vault_secret_id").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),
  },
  (table) => ({
    providerCheck: check(
      "provider_keys_provider_check",
      sql`${table.provider} IN ('anthropic', 'openai', 'ollama')`,
    ),
    userIdIdx: index("idx_provider_keys_user_id").on(table.userId),
    userProviderIdx: index("idx_provider_keys_user_provider").on(
      table.userId,
      table.provider,
    ),
    organizationIdIdx: index("idx_provider_keys_organization_id").on(
      table.organizationId,
    ),
  }),
);

export const providerPricing = pgTable(
  "provider_pricing",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    displayName: text("display_name").notNull(),
    inputPer1mTokensUsd: numeric("input_per_1m_tokens_usd", {
      precision: 10,
      scale: 4,
    }).notNull(),
    outputPer1mTokensUsd: numeric("output_per_1m_tokens_usd", {
      precision: 10,
      scale: 4,
    }).notNull(),
    contextWindowTokens: integer("context_window_tokens"),
    isDefault: boolean("is_default").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    effectiveFrom: timestamp("effective_from", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    providerCheck: check(
      "provider_pricing_provider_check",
      sql`${table.provider} IN ('anthropic', 'openai', 'ollama')`,
    ),
    providerModelEffectiveFromUnique: unique(
      "provider_pricing_provider_model_effective_from_unique",
    ).on(table.provider, table.model, table.effectiveFrom),
    providerActiveIdx: index("idx_provider_pricing_provider_active")
      .on(table.provider, table.isActive)
      .where(sql`${table.isActive} = true`),
  }),
);

export const prompts = pgTable(
  "prompts",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    providerKeyId: uuid("provider_key_id").references(() => providerKeys.id, {
      onDelete: "set null",
    }),
    organizationId: uuid("organization_id").references(
      () => organizations.id,
      { onDelete: "set null" },
    ),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    promptTextFingerprint: text("prompt_text_fingerprint").notNull(),
    promptTextLength: integer("prompt_text_length").notNull(),
    responseTextFingerprint: text("response_text_fingerprint"),
    responseTextLength: integer("response_text_length"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    estimatedCostUsd: numeric("estimated_cost_usd", {
      precision: 10,
      scale: 6,
    }),
    latencyMs: integer("latency_ms").notNull(),
    status: text("status").notNull(),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    statusCheck: check(
      "prompts_status_check",
      sql`${table.status} IN ('success', 'error', 'timeout')`,
    ),
    userIdCreatedAtIdx: index("idx_prompts_user_id_created_at").on(
      table.userId,
      table.createdAt.desc(),
    ),
    providerCreatedAtIdx: index("idx_prompts_provider_created_at").on(
      table.provider,
      table.createdAt.desc(),
    ),
    userStatusIdx: index("idx_prompts_user_status").on(
      table.userId,
      table.status,
    ),
    organizationIdIdx: index("idx_prompts_organization_id").on(
      table.organizationId,
    ),
    projectIdIdx: index("idx_prompts_project_id")
      .on(table.projectId)
      .where(sql`${table.projectId} IS NOT NULL`),
  }),
);

export const platformCredentials = pgTable(
  "platform_credentials",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id").references(
      () => organizations.id,
      { onDelete: "set null" },
    ),
    platform: text("platform").notNull(),
    label: text("label").notNull(),
    vaultSecretId: uuid("vault_secret_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),
  },
  (table) => ({
    platformCheck: check(
      "platform_credentials_platform_check",
      sql`${table.platform} IN ('vercel', 'render', 'github', 'supabase')`,
    ),
    userIdIdx: index("idx_platform_credentials_user_id").on(table.userId),
    userPlatformIdx: index("idx_platform_credentials_user_platform").on(
      table.userId,
      table.platform,
    ),
    organizationIdIdx: index("idx_platform_credentials_organization_id")
      .on(table.organizationId)
      .where(sql`${table.organizationId} IS NOT NULL`),
  }),
);

export const integrations = pgTable(
  "integrations",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id").references(
      () => organizations.id,
      { onDelete: "set null" },
    ),
    integrationType: text("integration_type").notNull(),
    // For sendgrid/wordpress: a vault.secrets.id UUID. For openai/anthropic:
    // null (provider_key_id in config jsonb references provider_keys instead).
    vaultSecretId: uuid("vault_secret_id"),
    // Integration-specific config. Shapes per type:
    // - sendgrid: {} (just the credential)
    // - openai/anthropic: { provider_key_id: uuid } (links to provider_keys)
    // - wordpress: { site_url: text, modules: [{slug,title,source_url,required_memberpress_tier}] }
    config: jsonb("config").notNull().default(sql`'{}'::jsonb`),
    includeInProjects: boolean("include_in_projects").notNull().default(true),
    status: text("status").notNull().default("pending"),
    lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),
    validationError: text("validation_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    integrationTypeCheck: check(
      "integrations_integration_type_check",
      sql`${table.integrationType} IN ('sendgrid', 'openai', 'anthropic', 'wordpress', 'openclaw', 'auth0', 'stripe')`,
    ),
    statusCheck: check(
      "integrations_status_check",
      sql`${table.status} IN ('pending', 'validated', 'failed')`,
    ),
    userIdIdx: index("idx_integrations_user_id").on(table.userId),
    userTypeIdx: index("idx_integrations_user_type").on(
      table.userId,
      table.integrationType,
    ),
    organizationIdIdx: index("idx_integrations_organization_id")
      .on(table.organizationId)
      .where(sql`${table.organizationId} IS NOT NULL`),
    userTypeUnique: unique("integrations_user_type_unique").on(
      table.userId,
      table.integrationType,
    ),
  }),
);

export const projectProvisioningEvents = pgTable(
  "project_provisioning_events",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    stepName: text("step_name").notNull(),
    status: text("status").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    details: jsonb("details"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    statusCheck: check(
      "project_provisioning_events_status_check",
      sql`${table.status} IN ('pending', 'in_progress', 'succeeded', 'failed', 'rolled_back', 'failed_to_rollback')`,
    ),
    projectIdCreatedAtIdx: index(
      "idx_project_provisioning_events_project_id_created_at",
    ).on(table.projectId, table.createdAt),
    statusIdx: index("idx_project_provisioning_events_status")
      .on(table.status)
      .where(sql`${table.status} IN ('pending', 'in_progress')`),
  }),
);

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id").references(
      () => organizations.id,
      { onDelete: "set null" },
    ),
    // Nullable: grandfathered users have neither stripe ID; Free users may have
    // a customer record but no subscription yet.
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    tier: text("tier").notNull().default("free"),
    status: text("status").notNull().default("active"),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    cancelAtPeriodEnd: boolean("cancel_at_period_end")
      .notNull()
      .default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    // One subscription per user in v1.
    userIdUnique: unique("subscriptions_user_id_unique").on(table.userId),
    stripeCustomerIdUnique: unique(
      "subscriptions_stripe_customer_id_unique",
    ).on(table.stripeCustomerId),
    stripeSubscriptionIdUnique: unique(
      "subscriptions_stripe_subscription_id_unique",
    ).on(table.stripeSubscriptionId),
    tierCheck: check(
      "subscriptions_tier_check",
      sql`${table.tier} IN ('free', 'pro')`,
    ),
    statusCheck: check(
      "subscriptions_status_check",
      sql`${table.status} IN ('active', 'past_due', 'canceled', 'incomplete', 'trialing')`,
    ),
  }),
);

export type SubscriptionRow = typeof subscriptions.$inferSelect;
export type NewSubscription = typeof subscriptions.$inferInsert;

export const stripeWebhookEvents = pgTable(
  "stripe_webhook_events",
  {
    // Stripe's event.id (e.g. 'evt_1AbCdE...'). Natural key: PK conflict on
    // INSERT means a duplicate delivery, safe to skip.
    id: text("id").primaryKey(),
    eventType: text("event_type").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // false = received but handler failed (allows retry); true = processed OK.
    processed: boolean("processed").notNull().default(false),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    // Last handler error message, for observability.
    processingError: text("processing_error"),
    // Full event payload for audit/replay if needed.
    payload: jsonb("payload").notNull(),
  },
  (table) => ({
    eventTypeIdx: index("stripe_webhook_events_event_type_idx").on(
      table.eventType,
    ),
    receivedAtIdx: index("stripe_webhook_events_received_at_idx").on(
      table.receivedAt,
    ),
  }),
);

export type StripeWebhookEventRow = typeof stripeWebhookEvents.$inferSelect;
export type NewStripeWebhookEvent = typeof stripeWebhookEvents.$inferInsert;
