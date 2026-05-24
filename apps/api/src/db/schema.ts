import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
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
