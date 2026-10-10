DROP INDEX "skills_slug_key";--> statement-breakpoint
CREATE UNIQUE INDEX "skills_deployment_slug_key" ON "skills" USING btree ("slug") WHERE "skills"."owner_user_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "skills_owner_slug_key" ON "skills" USING btree ("owner_user_id","slug") WHERE "skills"."owner_user_id" is not null;