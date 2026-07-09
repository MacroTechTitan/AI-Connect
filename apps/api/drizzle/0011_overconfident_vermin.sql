CREATE TABLE IF NOT EXISTS "stripe_webhook_events" (
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
ALTER TABLE "projects" ADD COLUMN "stripe_account_id" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "stripe_account_status" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stripe_webhook_events_event_type_idx" ON "stripe_webhook_events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stripe_webhook_events_received_at_idx" ON "stripe_webhook_events" USING btree ("received_at");--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_integration_type_check" CHECK ("integrations"."integration_type" IN ('sendgrid', 'openai', 'anthropic', 'wordpress', 'openclaw', 'auth0', 'stripe'));--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_stripe_account_status_check" CHECK ("projects"."stripe_account_status" IS NULL OR "projects"."stripe_account_status" IN ('pending', 'active', 'restricted'));