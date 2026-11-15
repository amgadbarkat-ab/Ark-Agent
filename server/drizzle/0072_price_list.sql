CREATE TABLE "price_list" (
	"id" text PRIMARY KEY NOT NULL,
	"file_name" text NOT NULL,
	"header" text NOT NULL,
	"rows" text[] NOT NULL,
	"uploaded_by" text,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "price_list" ADD CONSTRAINT "price_list_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;