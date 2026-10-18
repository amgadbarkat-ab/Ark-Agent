import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  agentProfiles,
  channelAgents,
  intelligenceChannelMappings,
} from "../db/schema";

/**
 * Whether one digital employee may ask another for work without a grant from an administrator.
 *
 * The other way to be allowed is a grant (`HANDOFF_GRANT`), which is how two employees that are not
 * on one team reach each other. Two things make a grant unnecessary, and both are the owner's own
 * decision made already:
 *
 *  - The LEAD of a person's team may ask that person's other employees. The person made it the lead.
 *  - Two employees of one person may ask each other in a conversation both are members of, which is
 *    the team channel. The person put them in the same room.
 *
 * Both employees must belong to the same person and neither may be deleted. Read on every ask and
 * never held, so choosing another lead, or taking someone out of the room, applies to the very next
 * ask. Depth and fan-out caps still apply on top: this decides who may be asked, not how much.
 */
export function createTeamReach(database: Database) {
  return async function mayAsk(
    fromBotId: string,
    toBotId: string,
    threadId?: string,
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
    if (
      !from ||
      !to ||
      from.deletedAt !== null ||
      to.deletedAt !== null ||
      from.owner === null ||
      from.owner !== to.owner
    ) {
      return false;
    }
    if (from.primary) return true;
    if (!threadId) return false;

    // Both in the room this conversation is happening in.
    const room = await database
      .select({ agentId: channelAgents.agentId })
      .from(intelligenceChannelMappings)
      .innerJoin(
        channelAgents,
        eq(channelAgents.channelId, intelligenceChannelMappings.channelId),
      )
      .where(
        and(
          eq(intelligenceChannelMappings.threadId, threadId),
          inArray(channelAgents.agentId, [fromBotId, toBotId]),
        ),
      );
    return room.length === 2;
  };
}

/** The lead-only question this started as. Kept so a caller that never had a thread still reads well. */
export const createLeadReach = createTeamReach;
