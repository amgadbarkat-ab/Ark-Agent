import { and, asc, eq, inArray } from "drizzle-orm";
import type { Database } from "../db/client";
import { pushSubscriptions } from "../db/schema";

/** What a browser gives when it subscribes: where to send, and the keys to encrypt with. */
export type PushSubscriptionInput = {
  endpoint: string;
  p256dh: string;
  auth: string;
};

export type StoredSubscription = PushSubscriptionInput & { id: string };

/** The most devices one person has registered. A new one beyond it replaces the oldest. */
export const MOST_DEVICES_PER_PERSON = 10;

export type PushStore = {
  /**
   * Register a device for a person. The same endpoint saved again is the same device, moved to
   * whoever is signed in on it now.
   */
  save: (userId: string, input: PushSubscriptionInput) => Promise<void>;
  /** Forget one of the person's own devices. Somebody else's is not theirs to forget. */
  remove: (userId: string, endpoint: string) => Promise<boolean>;
  /** Forget a device whatever its owner: the push service said it is gone. */
  removeEverywhere: (endpoint: string) => Promise<void>;
  forUser: (userId: string) => Promise<StoredSubscription[]>;
  count: (userId: string) => Promise<number>;
};

export function createPushStore(database: Database): PushStore {
  return {
    async save(userId, input) {
      await database
        .insert(pushSubscriptions)
        .values({ userId, ...input })
        .onConflictDoUpdate({
          target: pushSubscriptions.endpoint,
          set: {
            userId,
            p256dh: input.p256dh,
            auth: input.auth,
            createdAt: new Date(),
          },
        });
      // Newest first is kept; what is past the limit is the oldest.
      const mine = await database
        .select({ id: pushSubscriptions.id })
        .from(pushSubscriptions)
        .where(eq(pushSubscriptions.userId, userId))
        .orderBy(asc(pushSubscriptions.createdAt));
      const surplus = mine.slice(
        0,
        Math.max(0, mine.length - MOST_DEVICES_PER_PERSON),
      );
      if (surplus.length > 0) {
        await database.delete(pushSubscriptions).where(
          inArray(
            pushSubscriptions.id,
            surplus.map((row) => row.id),
          ),
        );
      }
    },
    async remove(userId, endpoint) {
      const removed = await database
        .delete(pushSubscriptions)
        .where(
          and(
            eq(pushSubscriptions.userId, userId),
            eq(pushSubscriptions.endpoint, endpoint),
          ),
        )
        .returning({ id: pushSubscriptions.id });
      return removed.length > 0;
    },
    async removeEverywhere(endpoint) {
      await database
        .delete(pushSubscriptions)
        .where(eq(pushSubscriptions.endpoint, endpoint));
    },
    async forUser(userId) {
      return database
        .select({
          id: pushSubscriptions.id,
          endpoint: pushSubscriptions.endpoint,
          p256dh: pushSubscriptions.p256dh,
          auth: pushSubscriptions.auth,
        })
        .from(pushSubscriptions)
        .where(eq(pushSubscriptions.userId, userId));
    },
    async count(userId) {
      const rows = await database
        .select({ id: pushSubscriptions.id })
        .from(pushSubscriptions)
        .where(eq(pushSubscriptions.userId, userId));
      return rows.length;
    },
  };
}
