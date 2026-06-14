CREATE TABLE IF NOT EXISTS "integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"organization_id" uuid,
	"integration_type" text NOT NULL,
	"vault_secret_id" uuid,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"include_in_projects" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"last_validated_at" timestamp with time zone,
	"validation_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integrations_user_type_unique" UNIQUE("user_id","integration_type"),
	CONSTRAINT "integrations_integration_type_check" CHECK ("integrations"."integration_type" IN ('sendgrid', 'openai', 'anthropic', 'wordpress')),
	CONSTRAINT "integrations_status_check" CHECK ("integrations"."status" IN ('pending', 'validated', 'failed'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "integrations" ADD CONSTRAINT "integrations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "integrations" ADD CONSTRAINT "integrations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_integrations_user_id" ON "integrations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_integrations_user_type" ON "integrations" USING btree ("user_id","integration_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_integrations_organization_id" ON "integrations" USING btree ("organization_id") WHERE "integrations"."organization_id" IS NOT NULL;