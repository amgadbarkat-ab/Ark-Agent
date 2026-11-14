CREATE TABLE "trial_check_ins" (
	"install_id" uuid PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"version" text NOT NULL,
	"status" text NOT NULL,
	"days_left" integer NOT NULL,
	"ends_at" timestamp with time zone,
	"employees" integer,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trial_codes" (
	"nonce" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"action" text NOT NULL,
	"until" timestamp with time zone,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trial_roster" (
	"key" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"seeded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trial_state" (
	"id" text PRIMARY KEY DEFAULT 'install' NOT NULL,
	"customer_id" text NOT NULL,
	"customer_name" text NOT NULL,
	"profile" text NOT NULL,
	"signature" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"ends_override_at" timestamp with time zone,
	"plan_id" text NOT NULL,
	"create_blocked" boolean NOT NULL,
	"check_in_url" text,
	"status" text DEFAULT 'trial' NOT NULL,
	"latest_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"install_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"last_check_in_at" timestamp with time zone,
	"last_check_in_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
