CREATE TABLE "price_observations" (
	"id" text PRIMARY KEY NOT NULL,
	"item" text NOT NULL,
	"shop" text NOT NULL,
	"price" text NOT NULL,
	"price_cents" integer,
	"url" text NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
