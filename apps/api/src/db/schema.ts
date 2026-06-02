import { sql } from "drizzle-orm";
import {
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

export const users = pgTable("users", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  email: text("email").notNull().unique(),
  role: text("role").notNull().default("user"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
});

export const systemLogs = pgTable(
  "system_logs",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    level: text("level").notNull(),
    category: text("category").notNull(),
    message: text("message").notNull(),
    context: jsonb("context"),
    traceId: uuid("trace_id"),
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
  }),
);

export const providerKeys = pgTable(
  "provider_keys",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
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
  }),
);
