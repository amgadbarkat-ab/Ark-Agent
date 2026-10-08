import { and, eq, exists, isNotNull, isNull, or, type SQL } from "drizzle-orm";
import type { Database } from "../db/client";
import { agentProfiles, tenantMemberships } from "../db/schema";

type Actor = { id: string; role: "admin" | "user" };

/**
 * Which coworkers one person may see, as a condition on `agent_profiles`.
 *
 * - Their own, always.
 * - The platform's own (no owner, no account) when public: these are what a deployment ships.
 * - Another person's, only when it is public AND it belongs to an account this person is a member
 *   of. This is the customer boundary. "Public" on a customer's coworker means public to the people
 *   in that customer's account, never to the deployment.
 * - A coworker that has an owner but no account is nobody's but its owner's. That cannot happen
 *   through the stores, which always give a new coworker its owner's account, and failing closed is
 *   the safe way for it to go if it ever does.
 *
 * An administrator is platform staff and sees everything.
 *
 * One definition, used by the roster, the runtime and the profile store, because three copies of a
 * rule about who can see whose work is how one of them ends up different.
 */
export function visibleAgentProfiles(
  database: Pick<Database, "select">,
  actor: Actor,
): SQL | undefined {
  if (actor.role === "admin") return undefined;
  return or(
    eq(agentProfiles.ownerUserId, actor.id),
    and(
      eq(agentProfiles.visibility, "public"),
      isNull(agentProfiles.ownerUserId),
      isNull(agentProfiles.tenantId),
    ),
    and(
      eq(agentProfiles.visibility, "public"),
      isNotNull(agentProfiles.tenantId),
      exists(
        // A correlated lookup, so one query decides it rather than a membership read per coworker.
        database
          .select({ one: tenantMemberships.userId })
          .from(tenantMemberships)
          .where(
            and(
              eq(tenantMemberships.tenantId, agentProfiles.tenantId),
              eq(tenantMemberships.userId, actor.id),
            ),
          ),
      ),
    ),
  );
}
