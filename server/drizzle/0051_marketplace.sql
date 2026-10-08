CREATE TYPE "public"."listing_kind" AS ENUM('official', 'shared');--> statement-breakpoint
CREATE TYPE "public"."listing_status" AS ENUM('pending', 'published', 'rejected', 'removed');--> statement-breakpoint
CREATE TYPE "public"."report_status" AS ENUM('open', 'dismissed', 'actioned');--> statement-breakpoint
CREATE TABLE "marketplace_installs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" text,
	"version" integer NOT NULL,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "marketplace_listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "listing_kind" NOT NULL,
	"slug" text NOT NULL,
	"publisher_id" uuid NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"category" text NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"content" jsonb NOT NULL,
	"status" "listing_status" DEFAULT 'pending' NOT NULL,
	"review_note" text,
	"version" integer DEFAULT 1 NOT NULL,
	"source_agent_id" text,
	"install_count" integer DEFAULT 0 NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "marketplace_publishers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"display_name" text NOT NULL,
	"bio" text DEFAULT '' NOT NULL,
	"official" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "marketplace_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid NOT NULL,
	"reporter_user_id" text,
	"reason" text NOT NULL,
	"details" text DEFAULT '' NOT NULL,
	"status" "report_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "marketplace_installs" ADD CONSTRAINT "marketplace_installs_listing_id_marketplace_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."marketplace_listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_installs" ADD CONSTRAINT "marketplace_installs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_installs" ADD CONSTRAINT "marketplace_installs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_installs" ADD CONSTRAINT "marketplace_installs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_listings" ADD CONSTRAINT "marketplace_listings_publisher_id_marketplace_publishers_id_fk" FOREIGN KEY ("publisher_id") REFERENCES "public"."marketplace_publishers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_listings" ADD CONSTRAINT "marketplace_listings_source_agent_id_agents_id_fk" FOREIGN KEY ("source_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_publishers" ADD CONSTRAINT "marketplace_publishers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_reports" ADD CONSTRAINT "marketplace_reports_listing_id_marketplace_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."marketplace_listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_reports" ADD CONSTRAINT "marketplace_reports_reporter_user_id_users_id_fk" FOREIGN KEY ("reporter_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "marketplace_installs_listing_idx" ON "marketplace_installs" USING btree ("listing_id");--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_listings_slug_key" ON "marketplace_listings" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "marketplace_listings_browse_idx" ON "marketplace_listings" USING btree ("status","kind","category");--> statement-breakpoint
CREATE INDEX "marketplace_listings_publisher_idx" ON "marketplace_listings" USING btree ("publisher_id");--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_publishers_tenant_key" ON "marketplace_publishers" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_publishers_name_key" ON "marketplace_publishers" USING btree (lower("display_name"));--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_reports_once_key" ON "marketplace_reports" USING btree ("listing_id","reporter_user_id");--> statement-breakpoint
CREATE INDEX "marketplace_reports_open_idx" ON "marketplace_reports" USING btree ("status","created_at");