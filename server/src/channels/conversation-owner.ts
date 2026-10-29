import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  channelMemberships,
  channels,
  intelligenceChannelMappings,
} from "../db/schema";

/**
 * Whether this person is in the conversation a browser says it is running in.
 *
 * The browser drives a built-in employee's computer, so the conversation a held browser action
 * belongs to arrives from the browser — and that is where its outcome is later delivered, as a turn
 * of the employee's. A thread named here that the person is not in, or that shows in a deleted
 * channel, is not a conversation they may have a turn put into; the action is still held, and its
 * outcome simply goes nowhere.
 */
export function createConversationOwnership(database: Database) {
  return async (actorId: string, threadId: string): Promise<boolean> => {
    const [row] = await database
      .select({ channelId: intelligenceChannelMappings.channelId })
      .from(intelligenceChannelMappings)
      .innerJoin(
        channels,
        and(
          eq(channels.id, intelligenceChannelMappings.channelId),
          isNull(channels.deletedAt),
        ),
      )
      .innerJoin(
        channelMemberships,
        and(
          eq(
            channelMemberships.channelId,
            intelligenceChannelMappings.channelId,
          ),
          eq(channelMemberships.userId, actorId),
        ),
      )
      .where(eq(intelligenceChannelMappings.threadId, threadId))
      .limit(1);
    return Boolean(row);
  };
}
