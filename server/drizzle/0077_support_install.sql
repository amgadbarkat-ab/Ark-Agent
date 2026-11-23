CREATE TABLE "support_install" (
	"id" text PRIMARY KEY DEFAULT 'install' NOT NULL,
	"install_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
