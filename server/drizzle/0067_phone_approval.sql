CREATE TABLE "phone_approval_settings" (
	"user_id" text PRIMARY KEY NOT NULL,
	"phone" text NOT NULL,
	"pin_hash" text NOT NULL,
	"agent_ids" text[] DEFAULT '{}' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "phone_approval_settings" ADD CONSTRAINT "phone_approval_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;