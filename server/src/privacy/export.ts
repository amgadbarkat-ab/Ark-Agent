import { and, asc, eq, gt } from "drizzle-orm";
import type { AccountStore } from "../accounts/store";
import type { Database } from "../db/client";
import {
  accounts,
  agentProfiles,
  agents,
  attachments,
  auditEvents,
  botModelChoices,
  channelMemberships,
  channels,
  cloudAccounts,
  cloudCharges,
  cloudIntervals,
  composioConnections,
  marketplaceInstalls,
  marketplaceListings,
  marketplacePublishers,
  marketplaceReports,
  modelConnections,
  pluginGrants,
  routines,
  skills,
  subscriptions,
  tenantMemberships,
  tenants,
  userInstructions,
  userRoles,
  users,
  voiceSessions,
} from "../db/schema";
import type { ConversationService } from "./conversations";

/**
 * Everything held about one person, as a file they can keep (GDPR Article 15 and 20).
 *
 * Built as a stream of text rather than one object, because a person's conversations can be large and
 * this must not hold all of them in memory at once: the sections that are small are written first,
 * then each conversation in turn.
 *
 * WHAT IS LEFT OUT, ON PURPOSE, AND SAID IN THE FILE. Secrets: no key, token or password of theirs is
 * in it (a model connection says it has a key, never what it is), and neither is the content of their
 * uploaded files (names and sizes are; ask us for the files). A file somebody downloads ends up in
 * mail, in chat and on shared drives, so it holds nothing that opens a door.
 */

const NOT_INCLUDED = [
  "Keys and tokens: your sign-in tokens, the keys of your model connections and of your connected apps are never in an export.",
  "The content of files you uploaded (their names and sizes are listed). Contact us if you need the files themselves.",
  "Records the payment service keeps as the seller of your plan (invoices, payment details). Ask the payment service, named in the privacy notice.",
];

type Row = Record<string, unknown>;

/** What the audit trail holds about a person, a page at a time. */
const AUDIT_PAGE = 500;

export function exportPerson(
  dependencies: {
    database: Database;
    accounts: AccountStore;
    conversations?: ConversationService;
  },
  userId: string,
  options: { auditPageSize?: number } = {},
): AsyncGenerator<string, void, undefined> {
  const { database, conversations } = dependencies;
  const auditPage = options.auditPageSize ?? AUDIT_PAGE;

  async function* chunks(): AsyncGenerator<string, void, undefined> {
    const [person] = await database
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        image: users.image,
        emailVerified: users.emailVerified,
        createdAt: users.createdAt,
        lastSignedInAt: users.lastSignedInAt,
        preferences: users.preferences,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!person) throw new Error("No such person.");

    const tenantId = await dependencies.accounts.tenantIdForUser(userId);

    const sections: Record<string, unknown> = {
      exportedAt: new Date().toISOString(),
      about:
        "Everything Ark holds about you, as of the date above. See the privacy notice for what each part is used for.",
      notIncluded: NOT_INCLUDED,
      person,
      roles: (
        await database
          .select({ role: userRoles.role })
          .from(userRoles)
          .where(eq(userRoles.userId, userId))
      ).map((row) => row.role),
      // The ways they sign in, never the tokens.
      signInMethods: await database
        .select({
          provider: accounts.providerId,
          createdAt: accounts.createdAt,
        })
        .from(accounts)
        .where(eq(accounts.userId, userId)),
      instructions:
        (
          await database
            .select({ instructions: userInstructions.instructions })
            .from(userInstructions)
            .where(eq(userInstructions.userId, userId))
            .limit(1)
        )[0]?.instructions ?? null,
    };

    if (tenantId) {
      const [account] = await database
        .select({
          name: tenants.name,
          status: tenants.status,
          createdAt: tenants.createdAt,
          plan: subscriptions.planId,
          subscriptionStatus: subscriptions.status,
          currentPeriodEnd: subscriptions.currentPeriodEnd,
          cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
          paymentProvider: subscriptions.provider,
        })
        .from(tenants)
        .innerJoin(subscriptions, eq(subscriptions.tenantId, tenants.id))
        .where(eq(tenants.id, tenantId))
        .limit(1);
      sections.account = account ?? null;
      // What they agreed to for running in Ark's cloud, and the months charged for it.
      const [agreement] = await database
        .select({
          enabled: cloudAccounts.enabled,
          monthlyLimitCents: cloudAccounts.monthlyCapCents,
          agreedAt: cloudAccounts.consentedAt,
          agreedToPrices: cloudAccounts.consentedRates,
        })
        .from(cloudAccounts)
        .where(eq(cloudAccounts.tenantId, tenantId))
        .limit(1);
      sections.cloudRunning = {
        agreement: agreement ?? null,
        // Not the payment service's reference or our notes to ourselves about a charge.
        months: await database
          .select({
            month: cloudCharges.period,
            status: cloudCharges.status,
            chargedCents: cloudCharges.amountCents,
            usage: cloudCharges.usage,
            prices: cloudCharges.rates,
          })
          .from(cloudCharges)
          .where(eq(cloudCharges.tenantId, tenantId))
          .orderBy(asc(cloudCharges.period)),
      };
      sections.membership = await database
        .select({
          role: tenantMemberships.role,
          createdAt: tenantMemberships.createdAt,
        })
        .from(tenantMemberships)
        .where(eq(tenantMemberships.userId, userId));
    }

    // Their coworkers, with the instruction each runs on. Not the key behind an endpoint.
    const owned = await database
      .select({
        id: agentProfiles.agentId,
        name: agents.name,
        type: agents.type,
        configuration: agents.configuration,
        title: agentProfiles.title,
        roleDescription: agentProfiles.roleDescription,
        visibility: agentProfiles.visibility,
        createdAt: agentProfiles.createdAt,
      })
      .from(agentProfiles)
      .innerJoin(agents, eq(agents.id, agentProfiles.agentId))
      .where(eq(agentProfiles.ownerUserId, userId));
    sections.coworkers = await Promise.all(
      owned.map(async (coworker) => {
        const configuration = (coworker.configuration ?? {}) as Row;
        return {
          id: coworker.id,
          name: coworker.name,
          title: coworker.title,
          roleDescription: coworker.roleDescription,
          visibility: coworker.visibility,
          createdAt: coworker.createdAt,
          // The instruction a coworker runs on, and the address it is at. Never the key in front of it.
          instruction:
            typeof configuration.systemPrompt === "string"
              ? configuration.systemPrompt
              : null,
          endpoint:
            typeof configuration.endpoint === "string"
              ? configuration.endpoint
              : null,
          grants: await database
            .select({ kind: pluginGrants.kind, ref: pluginGrants.ref })
            .from(pluginGrants)
            .where(eq(pluginGrants.agentId, coworker.id)),
        };
      }),
    );

    sections.skills = await database
      .select({
        slug: skills.slug,
        title: skills.title,
        summary: skills.summary,
        instructions: skills.instructions,
      })
      .from(skills)
      .where(eq(skills.ownerUserId, userId));
    sections.routines = await database
      .select({
        agentId: routines.agentId,
        instruction: routines.instruction,
        cron: routines.cron,
        timezone: routines.timezone,
        enabled: routines.enabled,
        lastRunAt: routines.lastRunAt,
      })
      .from(routines)
      .where(eq(routines.ownerUserId, userId));
    // The model connections say what they are and that a key exists, never the key.
    sections.modelConnections = (
      await database
        .select({
          provider: modelConnections.providerId,
          label: modelConnections.label,
          address: modelConnections.baseUrl,
          model: modelConnections.model,
          isDefault: modelConnections.isDefault,
          hasKey: modelConnections.encryptedKey,
          createdAt: modelConnections.createdAt,
        })
        .from(modelConnections)
        .where(eq(modelConnections.userId, userId))
    ).map(({ hasKey, ...rest }) => ({ ...rest, hasKey: hasKey !== null }));
    sections.modelChoices = await database
      .select({ coworkerId: botModelChoices.botId })
      .from(botModelChoices)
      .where(eq(botModelChoices.userId, userId));
    sections.connectedApps = await database
      .select({
        app: composioConnections.toolkit,
        connectedAt: composioConnections.connectedAt,
      })
      .from(composioConnections)
      .where(eq(composioConnections.userId, userId));

    sections.channels = await database
      .select({
        name: channels.name,
        description: channels.description,
        pinnedAt: channelMemberships.pinnedAt,
        lastReadAt: channelMemberships.lastReadAt,
      })
      .from(channelMemberships)
      .innerJoin(channels, eq(channels.id, channelMemberships.channelId))
      .where(eq(channelMemberships.userId, userId));
    sections.voiceSessions = await database
      .select({
        startedAt: voiceSessions.startedAt,
        endedAt: voiceSessions.endedAt,
        durationSeconds: voiceSessions.durationSeconds,
        summary: voiceSessions.summary,
        transcript: voiceSessions.transcript,
      })
      .from(voiceSessions)
      .where(eq(voiceSessions.userId, userId));
    sections.uploadedFiles = await database
      .select({
        name: attachments.name,
        type: attachments.mimeType,
        sizeBytes: attachments.sizeBytes,
      })
      .from(attachments)
      .where(eq(attachments.uploadedBy, userId));

    if (tenantId) {
      sections.marketplace = {
        publisher: await database
          .select({
            displayName: marketplacePublishers.displayName,
            bio: marketplacePublishers.bio,
          })
          .from(marketplacePublishers)
          .where(eq(marketplacePublishers.tenantId, tenantId)),
        listings: await database
          .select({
            title: marketplaceListings.title,
            summary: marketplaceListings.summary,
            description: marketplaceListings.description,
            status: marketplaceListings.status,
            content: marketplaceListings.content,
          })
          .from(marketplaceListings)
          .innerJoin(
            marketplacePublishers,
            eq(marketplacePublishers.id, marketplaceListings.publisherId),
          )
          .where(eq(marketplacePublishers.tenantId, tenantId)),
        installs: await database
          .select({
            installedAt: marketplaceInstalls.installedAt,
            version: marketplaceInstalls.version,
          })
          .from(marketplaceInstalls)
          .where(eq(marketplaceInstalls.userId, userId)),
        reportsFiled: await database
          .select({
            reason: marketplaceReports.reason,
            details: marketplaceReports.details,
            createdAt: marketplaceReports.createdAt,
          })
          .from(marketplaceReports)
          .where(eq(marketplaceReports.reporterUserId, userId)),
      };
    }

    // The head of the file: every small section, as the start of one JSON object.
    const head = JSON.stringify(sections);
    // Without its closing brace, so the larger sections can be appended.
    yield head.slice(0, -1);

    // What the security trail recorded as done by them. A page at a time.
    yield ',"securityRecord":[';
    let first = true;
    let after: string | undefined;
    for (;;) {
      const page = await database
        .select({
          id: auditEvents.id,
          at: auditEvents.createdAt,
          event: auditEvents.eventType,
          target: auditEvents.targetType,
          payload: auditEvents.payload,
        })
        .from(auditEvents)
        .where(
          after
            ? // Keyset, by id, so a very long record is read without ever holding it all.
              and(
                eq(auditEvents.actorUserId, userId),
                gt(auditEvents.id, after),
              )
            : eq(auditEvents.actorUserId, userId),
        )
        .orderBy(asc(auditEvents.id))
        .limit(auditPage);
      for (const row of page) {
        yield `${first ? "" : ","}${JSON.stringify(row)}`;
        first = false;
      }
      if (page.length < auditPage) break;
      after = page.at(-1)?.id;
    }
    yield "]";

    // When their coworkers used Ark's computers: the record the monthly charge is worked out from.
    yield ',"cloudUsage":[';
    if (tenantId) {
      let firstUse = true;
      let afterUse: string | undefined;
      for (;;) {
        const page = await database
          .select({
            id: cloudIntervals.id,
            coworkerId: cloudIntervals.botId,
            kind: cloudIntervals.source,
            from: cloudIntervals.startedAt,
            lastSeen: cloudIntervals.lastSeenAt,
            until: cloudIntervals.endedAt,
            bytes: cloudIntervals.bytes,
          })
          .from(cloudIntervals)
          .where(
            afterUse
              ? and(
                  eq(cloudIntervals.tenantId, tenantId),
                  gt(cloudIntervals.id, afterUse),
                )
              : eq(cloudIntervals.tenantId, tenantId),
          )
          .orderBy(asc(cloudIntervals.id))
          .limit(auditPage);
        for (const { id: _id, ...row } of page) {
          yield `${firstUse ? "" : ","}${JSON.stringify(row)}`;
          firstUse = false;
        }
        if (page.length < auditPage) break;
        afterUse = page.at(-1)?.id;
      }
    }
    yield "]";

    // Their conversations, one at a time.
    yield ',"conversations":[';
    if (conversations) {
      let firstConversation = true;
      for (const thread of await conversations.threads(userId)) {
        const messages = await conversations.messages(thread.id, userId);
        yield `${firstConversation ? "" : ","}${JSON.stringify({ thread, messages })}`;
        firstConversation = false;
      }
    }
    yield "]}";
  }

  return chunks();
}
