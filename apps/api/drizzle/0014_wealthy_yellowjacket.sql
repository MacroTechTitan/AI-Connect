CREATE TABLE IF NOT EXISTS "github_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" bigint NOT NULL,
	"user_id" uuid NOT NULL,
	"account_login" text NOT NULL,
	"account_type" text NOT NULL,
	"account_id" bigint NOT NULL,
	"repository_selection" text NOT NULL,
	"permissions" jsonb NOT NULL,
	"suspended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_installations_installation_id_unique" UNIQUE("installation_id"),
	CONSTRAINT "github_installations_account_type_check" CHECK ("github_installations"."account_type" IN ('User', 'Organization')),
	CONSTRAINT "github_installations_repository_selection_check" CHECK ("github_installations"."repository_selection" IN ('all', 'selected'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "github_webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed" boolean DEFAULT false NOT NULL,
	"processed_at" timestamp with time zone,
	"processing_error" text,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "integrations" DROP CONSTRAINT "integrations_integration_type_check";--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "github_installations_user_id_idx" ON "github_installations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "github_webhook_events_event_type_idx" ON "github_webhook_events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "github_webhook_events_received_at_idx" ON "github_webhook_events" USING btree ("received_at");--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_integration_type_check" CHECK ("integrations"."integration_type" IN ('sendgrid', 'openai', 'anthropic', 'wordpress', 'openclaw', 'auth0', 'stripe', 'github'));