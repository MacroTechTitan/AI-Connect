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
    organizationIdIdx: index("idx_projects_organization_id").on(
      table.organizationId,
    ),
    createdByIdx: index("idx_projects_created_by").on(table.createdByUserId),
    orgSlugUnique: unique("projects_organization_id_slug_unique").on(
      table.organizationId,
      table.slug,
    ),
    provisioningStateIdx: index("idx_projects_provisioning_state")
      .on(table.provisioningState)
      .where(sql`${table.provisioningState} != 'not_started'`),
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
