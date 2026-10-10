ALTER TABLE "cloud_accounts" ADD COLUMN "agreement_history" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "cloud_charges" ADD COLUMN "parts" jsonb;