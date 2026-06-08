ALTER TABLE "projects" ADD COLUMN "template_choice" text DEFAULT 'html-js' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "subdomain" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "database_connection_string_vault_id" uuid;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_projects_subdomain" ON "projects" USING btree ("subdomain") WHERE "projects"."subdomain" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_subdomain_unique" UNIQUE("subdomain");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_template_choice_check" CHECK ("projects"."template_choice" IN ('html-js', 'sveltekit', 'nextjs'));