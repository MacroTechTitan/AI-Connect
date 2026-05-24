CREATE TABLE IF NOT EXISTS "dev_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"category" text NOT NULL,
	"message" text NOT NULL,
	"context" jsonb,
	"trace_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "system_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"level" text NOT NULL,
	"category" text NOT NULL,
	"message" text NOT NULL,
	"context" jsonb,
	"trace_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "system_logs_level_check" CHECK ("system_logs"."level" IN ('debug', 'info', 'warn', 'error', 'critical'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"context" jsonb,
	"trace_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_audit_logs" ADD CONSTRAINT "user_audit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dev_logs_source_occurred_at_idx" ON "dev_logs" USING btree ("source","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dev_logs_category_occurred_at_idx" ON "dev_logs" USING btree ("category","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "system_logs_occurred_at_level_idx" ON "system_logs" USING btree ("occurred_at","level");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "system_logs_category_occurred_at_idx" ON "system_logs" USING btree ("category","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_audit_logs_user_id_occurred_at_idx" ON "user_audit_logs" USING btree ("user_id","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_audit_logs_action_occurred_at_idx" ON "user_audit_logs" USING btree ("action","occurred_at");--> statement-breakpoint
ALTER TABLE "public"."users" DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."system_logs" DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."user_audit_logs" DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."dev_logs" DISABLE ROW LEVEL SECURITY;