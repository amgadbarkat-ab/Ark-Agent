CREATE TABLE "ark_link" (
	"id" text PRIMARY KEY NOT NULL,
	"relay_url" text NOT NULL,
	"install_credential_id" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ark_link_devices" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"token_sha256" text NOT NULL,
	"paired_by" text,
	"paired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "ark_link_devices_token_sha256_unique" UNIQUE("token_sha256")
);
--> statement-breakpoint
ALTER TABLE "ark_link" ADD CONSTRAINT "ark_link_install_credential_id_credentials_id_fk" FOREIGN KEY ("install_credential_id") REFERENCES "public"."credentials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ark_link" ADD CONSTRAINT "ark_link_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ark_link_devices" ADD CONSTRAINT "ark_link_devices_paired_by_users_id_fk" FOREIGN KEY ("paired_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;