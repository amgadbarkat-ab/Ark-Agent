ALTER TABLE "office_network" ADD COLUMN "remote_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "office_network" ADD COLUMN "relay_office" text;--> statement-breakpoint
ALTER TABLE "office_network" ADD COLUMN "sealed_relay" text;--> statement-breakpoint
ALTER TABLE "office_network" ADD COLUMN "relay_registered" boolean DEFAULT false NOT NULL;