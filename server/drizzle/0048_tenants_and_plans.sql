CREATE TYPE "public"."subscription_status" AS ENUM('incomplete', 'trialing', 'active', 'past_due', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."tenant_role" AS ENUM('owner', 'admin', 'member');--> statement-breakpoint
CREATE TYPE "public"."tenant_status" AS ENUM('active', 'suspended');--> statement-breakpoint
CREATE TABLE "billing_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"type" text NOT NULL,
	"tenant_id" uuid,
	"payload" jsonb NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"bot_id" text NOT NULL,
	"run_id" text NOT NULL,
	"user_id" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"plan_id" text NOT NULL,
	"status" "subscription_status" NOT NULL,
	"provider" text DEFAULT 'manual' NOT NULL,
	"provider_customer_id" text,
	"provider_subscription_id" text,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_memberships" (
	"tenant_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" "tenant_role" DEFAULT 'owner' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_memberships_tenant_id_user_id_pk" PRIMARY KEY("tenant_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"status" "tenant_status" DEFAULT 'active' NOT NULL,
	"suspended_reason" text,
	"suspended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing_events" ADD CONSTRAINT "billing_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_slots" ADD CONSTRAINT "run_slots_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_events_provider_event_key" ON "billing_events" USING btree ("provider","event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "run_slots_run_key" ON "run_slots" USING btree ("tenant_id","run_id");--> statement-breakpoint
CREATE INDEX "run_slots_live_idx" ON "run_slots" USING btree ("tenant_id","expires_at");--> statement-breakpoint
CREATE INDEX "tenant_memberships_user_idx" ON "tenant_memberships" USING btree ("user_id");
--> statement-breakpoint
-- A deployment that existed before accounts was one company: everybody in it shared its coworkers.
-- They all become members of one internal account on the unlimited internal plan, so that keeps
-- working exactly as it did. (A hosted service with customers starts empty and gives each customer
-- an account of their own as they arrive.)
WITH company AS (
	INSERT INTO "tenants" ("name")
	SELECT 'Internal'
	WHERE EXISTS (SELECT 1 FROM "users") AND NOT EXISTS (SELECT 1 FROM "tenant_memberships")
	RETURNING "id"
), plan AS (
	INSERT INTO "subscriptions" ("tenant_id", "plan_id", "status", "provider")
	SELECT "id", 'internal', 'active', 'manual' FROM company
	RETURNING "tenant_id"
)
INSERT INTO "tenant_memberships" ("tenant_id", "user_id", "role")
SELECT company."id", u."id",
	CASE WHEN u."id" = (SELECT "id" FROM "users" ORDER BY "created_at", "id" LIMIT 1) THEN 'owner'::"tenant_role" ELSE 'member'::"tenant_role" END
FROM company CROSS JOIN "users" u;
