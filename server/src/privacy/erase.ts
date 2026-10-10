import { and, count, eq, inArray, isNull, notExists, or } from "drizzle-orm";
import type { AccountStore } from "../accounts/store";
import type { BillingProvider } from "../billing/provider";
import type { Database } from "../db/client";
import {
  agentProfiles,
  agents,
  billingEvents,
  channelMemberships,
  channels,
  composioConnections,
  credentials,
  mcpUserCredentials,
  runSlots,
  subscriptions,
  tenantMemberships,
  tenants,
  userRoles,
  users,
} from "../db/schema";
import type { ConversationService } from "./conversations";

/**
 * Removing a person and what is theirs (GDPR Article 17), in an order that cannot leave half of it.
 *
 * Everything that can fail on the way (stopping the subscription at the payment service, removing
 * conversations from the conversation service, asking an integration vendor to forget them) is done
 * BEFORE the database is touched, and the database part is one transaction. A refusal anywhere before
 * it leaves the person exactly as they were, and the same request can simply be made again: every step
 * tolerates having been done already.
 *
 * What is kept, and why, is written down in docs/ark/14-data-protection.md: the audit trail (a
 * security record, append-only by design and trimmed by its own retention window) and the payment
 * provider's records (the payment provider is the seller and keeps what tax law makes it keep).
 */

export type ErasureRefusalCode =
  | "not_found"
  | "administrator"
  | "last_administrator"
  | "billing"
  | "conversations";

export class ErasureRefused extends Error {
  constructor(
    readonly code: ErasureRefusalCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ErasureRefused";
  }
}

export type ErasureResult = {
  conversationsRemoved: number;
  /** The account itself went too, because this person was its only member on a hosted deployment. */
  accountRemoved: boolean;
  /** Things that could not be done and need a person: an integration vendor that would not answer. */
  followUp: string[];
};

export type ErasureDependencies = {
  database: Database;
  accounts: AccountStore;
  billing: BillingProvider;
  /** Absent means this deployment has no conversation service to ask (tests, mostly). */
  conversations?: ConversationService;
  /** Asks an integration vendor to forget a person's connected account for one app. Optional. */
  revokeIntegration?: (request: {
    userId: string;
    toolkit: string;
  }) => Promise<unknown>;
};

export async function erasePerson(
  dependencies: ErasureDependencies,
  userId: string,
  options: {
    requestedBy: "self" | "staff";
  },
): Promise<ErasureResult> {
  const { database, accounts, billing, conversations } = dependencies;

  const [person] = await database
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!person) throw new ErasureRefused("not_found", "No such person.");

  // An administrator is removed by another one, and never the last: the role has no way back in.
  const [admin] = await database
    .select({ role: userRoles.role })
    .from(userRoles)
    .where(and(eq(userRoles.userId, userId), eq(userRoles.role, "admin")))
    .limit(1);
  if (admin) {
    if (options.requestedBy === "self") {
      throw new ErasureRefused(
        "administrator",
        "An administrator's account is removed by another administrator.",
      );
    }
    const [{ total } = { total: 0 }] = await database
      .select({ total: count() })
      .from(userRoles)
      .where(eq(userRoles.role, "admin"));
    if (total <= 1) {
      throw new ErasureRefused(
        "last_administrator",
        "This is the only administrator. Make another one first.",
      );
    }
  }

  /*
   * Whether the account goes with the person. Only on a hosted deployment, and only when they are the
   * whole of it. A company's one shared account is not theirs to take with them, and an account with
   * other people in it outlives any one of them.
   */
  const tenantId = await accounts.tenantIdForUser(userId);
  let accountGoes = false;
  if (tenantId && accounts.billingMode === "subscriptions") {
    const [{ members } = { members: 0 }] = await database
      .select({ members: count() })
      .from(tenantMemberships)
      .where(eq(tenantMemberships.tenantId, tenantId));
    accountGoes = members === 1;
  }

  // 1. Stop the money first. Nothing is deleted while somebody is still being charged for it.
  let stopped = false;
  if (accountGoes && tenantId) {
    const [subscription] = await database
      .select({
        status: subscriptions.status,
        provider: subscriptions.provider,
      })
      .from(subscriptions)
      .where(eq(subscriptions.tenantId, tenantId))
      .limit(1);
    const subscriptionId = await accounts.providerSubscriptionIdFor(
      tenantId,
      billing.id,
    );
    if (
      subscriptionId &&
      subscription?.status !== "canceled" &&
      billing.cancel
    ) {
      try {
        await billing.cancel(subscriptionId, { atPeriodEnd: false });
        stopped = true;
      } catch (error) {
        throw new ErasureRefused(
          "billing",
          "The subscription could not be stopped with the payment service, so nothing was removed. Try again in a minute, or contact us.",
          { cause: error },
        );
      }
    }
  }

  // 2. Conversations, which are not in this database.
  let conversationsRemoved = 0;
  if (conversations) {
    try {
      for (const thread of await conversations.threads(userId)) {
        await conversations.remove(thread.id, userId);
        conversationsRemoved += 1;
      }
    } catch (error) {
      throw new ErasureRefused(
        "conversations",
        stopped
          ? "Their conversations could not be removed, so the account was kept. The subscription has already been stopped. Try again in a minute, or contact us."
          : "Their conversations could not be removed, so nothing was removed. Try again in a minute, or contact us.",
        { cause: error },
      );
    }
  }

  // 3. Connected apps held by an integration vendor. A vendor that will not answer must not hold the
  //    person's erasure hostage, so it is reported for a person to follow up, not refused.
  const followUp: string[] = [];
  const connected = await database
    .select({ toolkit: composioConnections.toolkit })
    .from(composioConnections)
    .where(eq(composioConnections.userId, userId));
  if (dependencies.revokeIntegration) {
    for (const { toolkit } of connected) {
      try {
        await dependencies.revokeIntegration({ userId, toolkit });
      } catch {
        followUp.push(
          `Ask the integration vendor to forget ${toolkit} for this person.`,
        );
      }
    }
  } else if (connected.length > 0) {
    followUp.push(
      `Ask the integration vendor to forget ${connected.map((row) => row.toolkit).join(", ")} for this person.`,
    );
  }

  // 4. Everything in this database, or nothing.
  await database.transaction(async (transaction) => {
    // Their own connected-account tokens: the link to them goes with the person, the token behind it
    // would not, so it is removed first.
    const tokens = await transaction
      .select({ id: mcpUserCredentials.credentialId })
      .from(mcpUserCredentials)
      .where(eq(mcpUserCredentials.userId, userId));
    const tokenIds = tokens
      .map((row) => row.id)
      .filter((id): id is string => id !== null);

    // Coworkers: what they made, and (when the account goes) anything else in it. `agents` rows are
    // not removed by their profile's account going, so they are removed here, with their prompts.
    const made = await transaction
      .select({ id: agentProfiles.agentId })
      .from(agentProfiles)
      .where(
        accountGoes && tenantId
          ? or(
              eq(agentProfiles.ownerUserId, userId),
              eq(agentProfiles.tenantId, tenantId),
            )
          : eq(agentProfiles.ownerUserId, userId),
      );

    // Conversations they were in, to tidy the ones nobody is left in.
    const memberOf = await transaction
      .select({ channelId: channelMemberships.channelId })
      .from(channelMemberships)
      .where(eq(channelMemberships.userId, userId));

    if (made.length > 0) {
      await transaction.delete(agents).where(
        and(
          inArray(
            agents.id,
            made.map((row) => row.id),
          ),
          // Never one the deployment ships.
          isNull(agents.packageId),
        ),
      );
    }
    if (tokenIds.length > 0) {
      // The link first: it points at the token, and the database will not let the token go while
      // something does. Then the token itself, which is the part that is theirs.
      await transaction
        .delete(mcpUserCredentials)
        .where(eq(mcpUserCredentials.userId, userId));
      await transaction
        .delete(credentials)
        .where(inArray(credentials.id, tokenIds));
    }
    await transaction
      .delete(composioConnections)
      .where(eq(composioConnections.userId, userId));
    await transaction.delete(runSlots).where(eq(runSlots.userId, userId));
    if (accountGoes && tenantId) {
      await transaction
        .delete(billingEvents)
        .where(eq(billingEvents.tenantId, tenantId));
    }

    // The person. This is what removes their sign-in methods and sessions, preferences, model
    // connections and keys, instructions, skills, routines, notification devices, voice recordings, attachments, installs,
    // memberships and roles: each is tied to them and goes with them.
    await transaction.delete(users).where(eq(users.id, userId));

    if (accountGoes && tenantId) {
      // Its plan, its marketplace listings and its publisher face go with it.
      await transaction.delete(tenants).where(eq(tenants.id, tenantId));
    }

    // A conversation nobody is in any more, that the deployment did not ship, is not kept.
    if (memberOf.length > 0) {
      await transaction.delete(channels).where(
        and(
          inArray(
            channels.id,
            memberOf.map((row) => row.channelId),
          ),
          isNull(channels.packageId),
          notExists(
            transaction
              .select({ one: channelMemberships.channelId })
              .from(channelMemberships)
              .where(eq(channelMemberships.channelId, channels.id)),
          ),
        ),
      );
    }
  });

  return { conversationsRemoved, accountRemoved: accountGoes, followUp };
}
