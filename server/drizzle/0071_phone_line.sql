CREATE TABLE "phone_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_id" text NOT NULL,
	"agent_id" text,
	"from_number" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"duration_seconds" integer,
	"outcome" text DEFAULT 'in_progress' NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"callback_name" text,
	"callback_number" text,
	"callback_reason" text,
	"callback_done_at" timestamp with time zone,
	CONSTRAINT "phone_calls_call_id_unique" UNIQUE("call_id")
);
--> statement-breakpoint
CREATE TABLE "phone_line" (
	"id" text PRIMARY KEY NOT NULL,
	"relay_url" text NOT NULL,
	"agent_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"line_credential_id" uuid NOT NULL,
	"speech_credential_id" uuid NOT NULL,
	"speech_model" text NOT NULL,
	"voice" text NOT NULL,
	"greeting" text NOT NULL,
	"hours" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "phone_calls" ADD CONSTRAINT "phone_calls_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_line" ADD CONSTRAINT "phone_line_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_line" ADD CONSTRAINT "phone_line_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_line" ADD CONSTRAINT "phone_line_line_credential_id_credentials_id_fk" FOREIGN KEY ("line_credential_id") REFERENCES "public"."credentials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_line" ADD CONSTRAINT "phone_line_speech_credential_id_credentials_id_fk" FOREIGN KEY ("speech_credential_id") REFERENCES "public"."credentials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "phone_calls_started_idx" ON "phone_calls" USING btree ("started_at");