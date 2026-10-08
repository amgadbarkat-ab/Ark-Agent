ALTER TABLE "agent_profiles" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- A coworker somebody made belongs to the account its maker belongs to. The platform's own
-- coworkers have no owner and stay without an account.
UPDATE "agent_profiles" ap
SET "tenant_id" = (
	SELECT m."tenant_id" FROM "tenant_memberships" m
	WHERE m."user_id" = ap."owner_user_id"
	ORDER BY m."created_at", m."tenant_id" LIMIT 1
)
WHERE ap."owner_user_id" IS NOT NULL AND ap."tenant_id" IS NULL;
