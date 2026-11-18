ALTER TABLE "ark_link_devices" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "ark_link_devices" ADD COLUMN "accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ark_link_devices" ADD CONSTRAINT "ark_link_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;