CREATE TYPE "public"."cloud_charge_status" AS ENUM('pending', 'charging', 'charged', 'uncertain', 'carried', 'waived');--> statement-breakpoint
CREATE TYPE "public"."cloud_source" AS ENUM('run', 'computer', 'storage');--> statement-breakpoint
CREATE TABLE "cloud_accounts" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"monthly_cap_cents" integer,
	"consented_at" timestamp with time zone,
	"consented_rates" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cloud_charges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"period" text NOT NULL,
	"status" "cloud_charge_status" DEFAULT 'pending' NOT NULL,
	"usage" jsonb NOT NULL,
	"rates" jsonb NOT NULL,
	"cost_cents" numeric(16, 4) NOT NULL,
	"amount_cents" integer DEFAULT 0 NOT NULL,
	"provider_ref" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cloud_intervals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"bot_id" text NOT NULL,
	"source" "cloud_source" NOT NULL,
	"ref" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"bytes" bigint
);
--> statement-breakpoint
CREATE TABLE "cloud_rates" (
	"id" text PRIMARY KEY DEFAULT 'current' NOT NULL,
	"rates" jsonb NOT NULL,
	"set_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD COLUMN "run_location" text DEFAULT 'cloud' NOT NULL;--> statement-breakpoint
ALTER TABLE "cloud_accounts" ADD CONSTRAINT "cloud_accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_charges" ADD CONSTRAINT "cloud_charges_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_intervals" ADD CONSTRAINT "cloud_intervals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_rates" ADD CONSTRAINT "cloud_rates_set_by_users_id_fk" FOREIGN KEY ("set_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cloud_charges_period_idx" ON "cloud_charges" USING btree ("tenant_id","period");--> statement-breakpoint
CREATE UNIQUE INDEX "cloud_intervals_ref_idx" ON "cloud_intervals" USING btree ("source","ref");--> statement-breakpoint
CREATE INDEX "cloud_intervals_tenant_idx" ON "cloud_intervals" USING btree ("tenant_id","started_at");--> statement-breakpoint
CREATE INDEX "cloud_intervals_open_idx" ON "cloud_intervals" USING btree ("ended_at");