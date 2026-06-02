CREATE TABLE IF NOT EXISTS "prompts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider_key_id" uuid,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"prompt_text_fingerprint" text NOT NULL,
	"prompt_text_length" integer NOT NULL,
	"response_text_fingerprint" text,
	"response_text_length" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"estimated_cost_usd" numeric(10, 6),
	"latency_ms" integer NOT NULL,
	"status" text NOT NULL,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prompts_status_check" CHECK ("prompts"."status" IN ('success', 'error', 'timeout'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"label" text NOT NULL,
	"vault_secret_id" uuid NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"last_validated_at" timestamp with time zone,
	CONSTRAINT "provider_keys_provider_check" CHECK ("provider_keys"."provider" IN ('anthropic', 'openai', 'ollama'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_pricing" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"display_name" text NOT NULL,
	"input_per_1m_tokens_usd" numeric(10, 4) NOT NULL,
	"output_per_1m_tokens_usd" numeric(10, 4) NOT NULL,
	"context_window_tokens" integer,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_pricing_provider_model_effective_from_unique" UNIQUE("provider","model","effective_from"),
	CONSTRAINT "provider_pricing_provider_check" CHECK ("provider_pricing"."provider" IN ('anthropic', 'openai', 'ollama'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "prompts" ADD CONSTRAINT "prompts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "prompts" ADD CONSTRAINT "prompts_provider_key_id_provider_keys_id_fk" FOREIGN KEY ("provider_key_id") REFERENCES "public"."provider_keys"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "provider_keys" ADD CONSTRAINT "provider_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_prompts_user_id_created_at" ON "prompts" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_prompts_provider_created_at" ON "prompts" USING btree ("provider","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_prompts_user_status" ON "prompts" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_provider_keys_user_id" ON "provider_keys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_provider_keys_user_provider" ON "provider_keys" USING btree ("user_id","provider");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_provider_pricing_provider_active" ON "provider_pricing" USING btree ("provider","is_active") WHERE "provider_pricing"."is_active" = true;--> statement-breakpoint
ALTER TABLE "public"."provider_keys" DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."provider_pricing" DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."prompts" DISABLE ROW LEVEL SECURITY;