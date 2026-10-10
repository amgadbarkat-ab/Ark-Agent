CREATE TABLE "bot_model_choices" (
	"user_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bot_model_choices_user_id_bot_id_pk" PRIMARY KEY("user_id","bot_id")
);
--> statement-breakpoint
ALTER TABLE "bot_model_choices" ADD CONSTRAINT "bot_model_choices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_model_choices" ADD CONSTRAINT "bot_model_choices_bot_id_agents_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_model_choices" ADD CONSTRAINT "bot_model_choices_connection_id_model_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."model_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bot_model_choices_connection_idx" ON "bot_model_choices" USING btree ("connection_id");