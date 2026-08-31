CREATE TABLE IF NOT EXISTS "build_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"build_run_id" uuid NOT NULL,
	"decided_by_user_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "build_approvals_decision_check" CHECK ("build_approvals"."decision" IN ('APPROVE','REJECT'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "build_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"build_run_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"summary" text NOT NULL,
	"worker" text,
	"affected_target" text,
	"severity" text DEFAULT 'info' NOT NULL,
	"action_required" boolean DEFAULT false NOT NULL,
	"observed" boolean DEFAULT true NOT NULL,
	"details" jsonb,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "build_events_severity_check" CHECK ("build_events"."severity" IN ('debug','info','warn','error','critical'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "build_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"build_run_id" uuid NOT NULL,
	"reviewer" text NOT NULL,
	"reviewer_version" text,
	"verdict" text NOT NULL,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "build_reviews_verdict_check" CHECK ("build_reviews"."verdict" IN ('PASS','REVISION_REQUIRED','STOP'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "build_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"goal" text NOT NULL,
	"acceptance_criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"out_of_scope" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"stop_and_ask" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"worker_type" text DEFAULT 'claude_code' NOT NULL,
	"worker_version" text,
	"state" text DEFAULT 'QUEUED' NOT NULL,
	"current_activity" text,
	"branch_name" text,
	"worktree_path" text,
	"files_changed" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"additions" integer,
	"deletions" integer,
	"validation_summary" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cost_usd" numeric(10, 6),
	"feature_id" text,
	"feature_work_packet" jsonb,
	"completion_gates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"release_status" text DEFAULT 'NOT_EVALUATED' NOT NULL,
	"stop_reason" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "build_runs_state_check" CHECK ("build_runs"."state" IN ('QUEUED','RUNNING','PAUSED','REVIEWING','REVISION_REQUIRED','AWAITING_APPROVAL','COMPLETED','FAILED','REJECTED','STOPPED')),
	CONSTRAINT "build_runs_worker_type_check" CHECK ("build_runs"."worker_type" IN ('claude_code')),
	CONSTRAINT "build_runs_release_status_check" CHECK ("build_runs"."release_status" IN ('NOT_EVALUATED','ELIGIBLE','BLOCKED'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "build_approvals" ADD CONSTRAINT "build_approvals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "build_approvals" ADD CONSTRAINT "build_approvals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "build_approvals" ADD CONSTRAINT "build_approvals_build_run_id_build_runs_id_fk" FOREIGN KEY ("build_run_id") REFERENCES "public"."build_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "build_approvals" ADD CONSTRAINT "build_approvals_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "build_events" ADD CONSTRAINT "build_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "build_events" ADD CONSTRAINT "build_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "build_events" ADD CONSTRAINT "build_events_build_run_id_build_runs_id_fk" FOREIGN KEY ("build_run_id") REFERENCES "public"."build_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "build_reviews" ADD CONSTRAINT "build_reviews_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "build_reviews" ADD CONSTRAINT "build_reviews_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "build_reviews" ADD CONSTRAINT "build_reviews_build_run_id_build_runs_id_fk" FOREIGN KEY ("build_run_id") REFERENCES "public"."build_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "build_runs" ADD CONSTRAINT "build_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "build_runs" ADD CONSTRAINT "build_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "build_runs" ADD CONSTRAINT "build_runs_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "build_approvals_one_per_run_idx" ON "build_approvals" USING btree ("build_run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "build_events_run_occurred_idx" ON "build_events" USING btree ("build_run_id","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "build_events_org_project_idx" ON "build_events" USING btree ("organization_id","project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "build_reviews_run_created_idx" ON "build_reviews" USING btree ("build_run_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "build_runs_org_project_idx" ON "build_runs" USING btree ("organization_id","project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "build_runs_one_active_per_project_idx" ON "build_runs" USING btree ("project_id") WHERE "build_runs"."state" IN ('QUEUED','RUNNING','PAUSED','REVIEWING','REVISION_REQUIRED','AWAITING_APPROVAL');