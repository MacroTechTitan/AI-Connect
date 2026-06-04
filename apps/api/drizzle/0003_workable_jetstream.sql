CREATE TABLE IF NOT EXISTS "platform_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"organization_id" uuid,
	"platform" text NOT NULL,
	"label" text NOT NULL,
	"vault_secret_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"last_validated_at" timestamp with time zone,
	CONSTRAINT "platform_credentials_platform_check" CHECK ("platform_credentials"."platform" IN ('vercel', 'render', 'github', 'supabase'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_provisioning_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"step_name" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"details" jsonb,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_provisioning_events_status_check" CHECK ("project_provisioning_events"."status" IN ('pending', 'in_progress', 'succeeded', 'failed', 'rolled_back'))
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "provisioning_state" text DEFAULT 'not_started' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "platform_credentials" ADD CONSTRAINT "platform_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "platform_credentials" ADD CONSTRAINT "platform_credentials_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_provisioning_events" ADD CONSTRAINT "project_provisioning_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_platform_credentials_user_id" ON "platform_credentials" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_platform_credentials_user_platform" ON "platform_credentials" USING btree ("user_id","platform");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_platform_credentials_organization_id" ON "platform_credentials" USING btree ("organization_id") WHERE "platform_credentials"."organization_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_project_provisioning_events_project_id_created_at" ON "project_provisioning_events" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_project_provisioning_events_status" ON "project_provisioning_events" USING btree ("status") WHERE "project_provisioning_events"."status" IN ('pending', 'in_progress');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_projects_provisioning_state" ON "projects" USING btree ("provisioning_state") WHERE "projects"."provisioning_state" != 'not_started';--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_provisioning_state_check" CHECK ("projects"."provisioning_state" IN ('not_started', 'provisioning', 'provisioned', 'failed', 'rolled_back'));--> statement-breakpoint
ALTER TABLE "public"."platform_credentials" DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."project_provisioning_events" DISABLE ROW LEVEL SECURITY;