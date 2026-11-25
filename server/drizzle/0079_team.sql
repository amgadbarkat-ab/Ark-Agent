CREATE TYPE "public"."team_member_kind" AS ENUM('admin', 'subprofile');--> statement-breakpoint
CREATE TYPE "public"."team_member_status" AS ENUM('pending_payment', 'active', 'suspended', 'removed');--> statement-breakpoint
CREATE TABLE "subprofile_agents" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"assigned_by" text,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_members" (
	"user_id" text PRIMARY KEY NOT NULL,
	"kind" "team_member_kind" NOT NULL,
	"status" "team_member_status" NOT NULL,
	"must_change_password" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "subprofile_agents" ADD CONSTRAINT "subprofile_agents_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subprofile_agents" ADD CONSTRAINT "subprofile_agents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;