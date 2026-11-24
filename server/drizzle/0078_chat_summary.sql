CREATE TABLE "agent_chat_summaries" (
	"user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"enabled" boolean,
	"summary" text DEFAULT '' NOT NULL,
	"summary_tokens" integer DEFAULT 0 NOT NULL,
	"timezone" text,
	"summarised_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"last_error" text,
	"pending_threads" text[] DEFAULT '{}' NOT NULL,
	"pending_channels" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_chat_summaries_user_id_agent_id_pk" PRIMARY KEY("user_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "chat_summary_epoch" (
	"id" text PRIMARY KEY DEFAULT 'epoch' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_chat_summaries" ADD CONSTRAINT "agent_chat_summaries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_chat_summaries" ADD CONSTRAINT "agent_chat_summaries_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- When this install first ran with the weekly cleanup: employees made after it have it on.
INSERT INTO "chat_summary_epoch" ("id") VALUES ('epoch') ON CONFLICT DO NOTHING;
