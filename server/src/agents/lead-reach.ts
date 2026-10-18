import { inArray } from "drizzle-orm";
import type { Database } from "../db/client";
import { agentProfiles } from "../db/schema";

/**
 * Whether one digital employee may ask another for work because it leads its owner's team.
 *
 * The other way to be allowed is a grant an administrator makes (`HANDOFF_GRANT`), which is how two
 * employees that are not on one team reach each other. A lead does not need one for its own
 * colleagues: the person who made the team made it the lead, which is that decision already.
 *
 * Both must belong to the same person and neither may be deleted. Read on every hop and never held,
 * so choosing another lead, or deleting this one, applies to the very next ask.
 */
export function createLeadReach(database: Database) {
  return async function leadMayAddress(
    fromBotId: string,
    toBotId: string,
  ): Promise<boolean> {
    const rows = await database
      .select({
        id: agentProfiles.agentId,
        owner: agentProfiles.ownerUserId,
        primary: agentProfiles.isPrimary,
        deletedAt: agentProfiles.deletedAt,
      })
      .from(agentProfiles)
      .where(inArray(agentProfiles.agentId, [fromBotId, toBotId]));
    const from = rows.find((row) => row.id === fromBotId);
    const to = rows.find((row) => row.id === toBotId);
    return (
      from !== undefined &&
      to !== undefined &&
      from.primary &&
      from.deletedAt === null &&
      to.deletedAt === null &&
      from.owner !== null &&
      from.owner === to.owner
    );
  };
}
