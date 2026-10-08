CREATE TABLE "model_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"label" text NOT NULL,
	"base_url" text NOT NULL,
	"encrypted_key" text,
	"model" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "model_connections" ADD CONSTRAINT "model_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "model_connections_user_idx" ON "model_connections" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "model_connections_one_default_idx" ON "model_connections" USING btree ("user_id") WHERE "model_connections"."is_default";