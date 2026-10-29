CREATE TABLE "tool_call_rules" (
	"server_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"outcome" text NOT NULL,
	"set_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tool_call_rules_server_id_tool_name_pk" PRIMARY KEY("server_id","tool_name")
);
--> statement-breakpoint
ALTER TABLE "action_policy" ADD COLUMN "approve" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "thread_id" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "run_id" text;--> statement-breakpoint
ALTER TABLE "tool_call_rules" ADD CONSTRAINT "tool_call_rules_server_id_mcp_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;