import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { organizations, projects, users } from "./schema.js";

export const BUILD_RUN_STATES = [
  "QUEUED",
  "RUNNING",
  "PAUSED",
  "REVIEWING",
  "REVISION_REQUIRED",
  "AWAITING_APPROVAL",
  "COMPLETED",
  "FAILED",
  "REJECTED",
] as const;

export type BuildRunState = (typeof BUILD_RUN_STATES)[number];

export const buildRuns = pgTable(
  "build_runs",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    goal: text("goal").notNull(),
    acceptanceCriteria: jsonb("acceptance_criteria").notNull().default(sql`'[]'::jsonb`),
    outOfScope: jsonb("out_of_scope").notNull().default(sql`'[]'::jsonb`),
    stopAndAsk: jsonb("stop_and_ask").notNull().default(sql`'[]'::jsonb`),
    workerType: text("worker_type").notNull().default("claude_code"),
    workerVersion: text("worker_version"),
    state: text("state").notNull().default("QUEUED"),
    currentActivity: text("current_activity"),
    branchName: text("branch_name"),
    worktreePath: text("worktree_path"),
    filesChanged: jsonb("files_changed").notNull().default(sql`'[]'::jsonb`),
    additions: text("additions"),
    deletions: text("deletions"),
    validationSummary: jsonb("validation_summary").notNull().default(sql`'[]'::jsonb`),
    costUsd: text("cost_usd"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    stateCheck: check(
      "build_runs_state_check",
      sql`${table.state} IN ('QUEUED','RUNNING','PAUSED','REVIEWING','REVISION_REQUIRED','AWAITING_APPROVAL','COMPLETED','FAILED','REJECTED')`,
    ),
    workerTypeCheck: check(
      "build_runs_worker_type_check",
      sql`${table.workerType} IN ('claude_code')`,
    ),
    orgProjectIdx: index("build_runs_org_project_idx").on(
      table.organizationId,
      table.projectId,
      table.createdAt,
    ),
    activeRunPerProject: uniqueIndex("build_runs_one_active_per_project_idx")
      .on(table.projectId)
      .where(sql`${table.state} IN ('QUEUED','RUNNING','PAUSED','REVIEWING','REVISION_REQUIRED','AWAITING_APPROVAL')`),
  }),
);

export const buildEvents = pgTable(
  "build_events",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    buildRunId: uuid("build_run_id")
      .notNull()
      .references(() => buildRuns.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    summary: text("summary").notNull(),
    worker: text("worker"),
    affectedTarget: text("affected_target"),
    severity: text("severity").notNull().default("info"),
    actionRequired: boolean("action_required").notNull().default(false),
    observed: boolean("observed").notNull().default(true),
    details: jsonb("details"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    severityCheck: check(
      "build_events_severity_check",
      sql`${table.severity} IN ('debug','info','warn','error','critical')`,
    ),
    runOccurredIdx: index("build_events_run_occurred_idx").on(
      table.buildRunId,
      table.occurredAt,
    ),
    orgProjectIdx: index("build_events_org_project_idx").on(
      table.organizationId,
      table.projectId,
    ),
  }),
);

export const buildReviews = pgTable(
  "build_reviews",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    buildRunId: uuid("build_run_id")
      .notNull()
      .references(() => buildRuns.id, { onDelete: "cascade" }),
    reviewer: text("reviewer").notNull(),
    reviewerVersion: text("reviewer_version"),
    verdict: text("verdict").notNull(),
    findings: jsonb("findings").notNull().default(sql`'[]'::jsonb`),
    summary: text("summary"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    verdictCheck: check(
      "build_reviews_verdict_check",
      sql`${table.verdict} IN ('PASS','REVISION_REQUIRED','STOP')`,
    ),
    runCreatedIdx: index("build_reviews_run_created_idx").on(
      table.buildRunId,
      table.createdAt,
    ),
  }),
);

export const buildApprovals = pgTable(
  "build_approvals",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    buildRunId: uuid("build_run_id")
      .notNull()
      .references(() => buildRuns.id, { onDelete: "cascade" }),
    decidedByUserId: uuid("decided_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    decision: text("decision").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    decisionCheck: check(
      "build_approvals_decision_check",
      sql`${table.decision} IN ('APPROVE','REJECT')`,
    ),
    oneDecisionPerRun: uniqueIndex("build_approvals_one_per_run_idx").on(table.buildRunId),
  }),
);

export type BuildRunRow = typeof buildRuns.$inferSelect;
export type NewBuildRun = typeof buildRuns.$inferInsert;
export type BuildEventRow = typeof buildEvents.$inferSelect;
export type BuildReviewRow = typeof buildReviews.$inferSelect;
export type BuildApprovalRow = typeof buildApprovals.$inferSelect;
