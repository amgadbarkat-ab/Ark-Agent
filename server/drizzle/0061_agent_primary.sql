ALTER TABLE "agent_profiles" ADD COLUMN "is_primary" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- The first digital employee each person made leads their team. Done before the index exists, and only
-- for employees that have an owner and are not deleted, so the index below can never be refused.
UPDATE "agent_profiles" SET "is_primary" = true WHERE "agent_id" IN (
  SELECT DISTINCT ON ("owner_user_id") "agent_id" FROM "agent_profiles"
  WHERE "owner_user_id" IS NOT NULL AND "deleted_at" IS NULL
  ORDER BY "owner_user_id", "created_at" ASC, "agent_id" ASC
);--> statement-breakpoint
CREATE UNIQUE INDEX "agent_profiles_one_primary_per_owner" ON "agent_profiles" USING btree ("owner_user_id") WHERE "agent_profiles"."is_primary" and "agent_profiles"."deleted_at" is null;