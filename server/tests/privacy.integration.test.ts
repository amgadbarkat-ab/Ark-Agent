import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { count, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { createAccountStore } from "../src/accounts/store";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { BillingProvider } from "../src/billing/provider";
import { createDatabase } from "../src/db/client";
import {
  accounts,
  agentProfiles,
  agents,
  attachments,
  auditEvents,
  billingEvents,
  channelMemberships,
  channels,
  cloudAccounts,
  cloudCharges,
  cloudIntervals,
  composioConnections,
  credentials,
  marketplaceListings,
  marketplacePublishers,
  mcpServers,
  mcpUserCredentials,
  modelConnections,
  pluginGrants,
  routines,
  runSlots,
  sessions,
  skills,
  subscriptions,
  tenantMemberships,
  tenants,
  userInstructions,
  userRoles,
  users,
  voiceSessions,
  termsAcceptances,
} from "../src/db/schema";
import {
  type ConversationService,
  ConversationServiceError,
} from "../src/privacy/conversations";
import {
  type ErasureDependencies,
  ErasureRefused,
  erasePerson,
} from "../src/privacy/erase";
import { exportPerson } from "../src/privacy/export";
import {
  adminPrivacyRoutes,
  type PrivacyAuditEvent,
  privacyRoutes,
} from "../src/privacy/routes";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * A person's rights over their data (GDPR Articles 15, 17 and 20), against a real database.
 *
 * The thing under test is completeness and restraint at once: everything that is theirs is gone and
 * nothing that is somebody else's is touched, and an export holds everything of theirs and nothing
 * that opens a door (no key, no token).
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const hosted = createAccountStore(database, { billingMode: "subscriptions" });
const company = createAccountStore(database, { billingMode: "internal" });
const hostedProfiles = createAgentProfileStore(
  database,
  undefined,
  undefined,
  hosted,
);
const companyProfiles = createAgentProfileStore(
  database,
  undefined,
  undefined,
  company,
);

const madeTokens: string[] = [];
const made = {
  users: [] as string[],
  tenants: [] as string[],
  channels: [] as string[],
  agents: [] as string[],
};

/** Conversations, in memory, per person, remembering what was asked of them. */
function fakeConversations(initial: Record<string, number> = {}) {
  const threads = new Map<string, string[]>();
  for (const [user, howMany] of Object.entries(initial)) {
    threads.set(
      user,
      Array.from({ length: howMany }, (_, i) => `thread-${user}-${i}`),
    );
  }
  const state = { failOnRemove: false, removed: [] as string[] };
  const service: ConversationService = {
    threads: async (userId) =>
      (threads.get(userId) ?? []).map((id) => ({ id, title: `Chat ${id}` })),
    messages: async (threadId) => [
      { role: "user", content: `hello from ${threadId}` },
    ],
    remove: async (threadId, userId) => {
      if (state.failOnRemove) throw new ConversationServiceError("down");
      threads.set(
        userId,
        (threads.get(userId) ?? []).filter((id) => id !== threadId),
      );
      state.removed.push(threadId);
    },
  };
  return { service, state, threads };
}

function fakeBilling(options: { failCancel?: boolean } = {}) {
  const cancelled: Array<{ id: string; atPeriodEnd: boolean }> = [];
  const billing: BillingProvider = {
    id: "paddle",
    createCheckout: async () => ({ url: "https://x.test" }),
    cancel: async (id, cancelOptions) => {
      if (options.failCancel) throw new Error("Paddle is down");
      cancelled.push({ id, atPeriodEnd: cancelOptions.atPeriodEnd });
    },
    parseWebhook: () => [],
  };
  return { billing, cancelled };
}

type Person = { id: string; email: string; tenantId: string | undefined };

async function person(
  label: string,
  options: { store?: typeof hosted; admin?: boolean } = {},
): Promise<Person> {
  const store = options.store ?? hosted;
  const id = `priv-${label}-${randomUUID()}`;
  const email = `${id}@example.com`;
  await database.insert(users).values({ id, email, name: label });
  await database
    .insert(userRoles)
    .values({ userId: id, role: options.admin ? "admin" : "user" });
  made.users.push(id);
  const tenantId = await store.ensureTenant(id);
  if (!made.tenants.includes(tenantId)) made.tenants.push(tenantId);
  return { id, email, tenantId };
}

/** One person with something in every place a person's data lives. */
async function furnished(
  label: string,
  options: { store?: typeof hosted; profiles?: typeof hostedProfiles } = {},
) {
  const store = options.store ?? hosted;
  const profiles = options.profiles ?? hostedProfiles;
  const who = await person(label, { store });
  const tenantId = who.tenantId as string;

  const coworker = await profiles.create({ id: who.id, role: "user" }, {
    name: `Bot ${label}`,
    title: "Analyst",
    roleDescription: `Private role of ${label}.`,
    visibility: "private",
    systemPrompt: `SECRET PROMPT OF ${label}`,
  } as never);
  made.agents.push(coworker.id);
  await database
    .insert(pluginGrants)
    .values({ kind: "mcp", ref: "srv-1/search", agentId: coworker.id });

  await database.insert(skills).values({
    id: `skill-${randomUUID()}`,
    ownerUserId: who.id,
    slug: `skill-${randomUUID().slice(0, 8)}`,
    title: "My skill",
    summary: "Does a thing",
    instructions: "Private instructions",
  });
  const channelId = `chan-${randomUUID()}`;
  made.channels.push(channelId);
  await database.insert(channels).values({
    id: channelId,
    name: `Chat of ${label}`,
    description: "private",
  });
  await database
    .insert(channelMemberships)
    .values({ channelId, userId: who.id });
  await database.insert(routines).values({
    id: `routine-${randomUUID()}`,
    ownerUserId: who.id,
    agentId: coworker.id,
    channelId,
    instruction: "Every morning",
    cron: "0 8 * * *",
    nextRunAt: new Date(Date.now() + 3600_000),
  });
  await database.insert(modelConnections).values({
    userId: who.id,
    providerId: "anthropic",
    label: "Mine",
    baseUrl: "https://api.anthropic.com",
    encryptedKey: "ENCRYPTED-KEY-MATERIAL",
    model: "claude",
    isDefault: true,
  });
  await database
    .insert(userInstructions)
    .values({ userId: who.id, instructions: "Always be brief." });
  await database
    .insert(composioConnections)
    .values({ toolkit: "gmail", userId: who.id });
  await database.insert(voiceSessions).values({
    id: `voice-${randomUUID()}`,
    channelId,
    userId: who.id,
    startedAt: new Date(),
    endedAt: new Date(),
    durationSeconds: 5,
    transcript: { entries: [] },
  });
  await database.insert(attachments).values({
    channelId,
    uploadedBy: who.id,
    name: "plan.pdf",
    mimeType: "application/pdf",
    sizeBytes: 12,
    bytes: Buffer.from("FILE-CONTENT"),
  });
  await database.insert(accounts).values({
    id: `acc-${randomUUID()}`,
    accountId: `ext-${randomUUID()}`,
    providerId: "google",
    userId: who.id,
    accessToken: "SECRET-ACCESS-TOKEN",
    refreshToken: "SECRET-REFRESH-TOKEN",
  });
  await database.insert(sessions).values({
    id: `sess-${randomUUID()}`,
    userId: who.id,
    token: `tok-${randomUUID()}`,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  // A connected app: a server, the person's link to it, and the token behind it.
  const server = `mcp-${randomUUID()}`;
  await database.insert(mcpServers).values({
    id: server,
    title: "App",
    vendor: "Acme",
    url: "https://mcp.example.test",
  });
  const [token] = await database
    .insert(credentials)
    .values({
      kind: "mcp",
      provider: server,
      encryptedValue: "ENCRYPTED-TOKEN",
      keyId: `key-${randomUUID()}`,
      metadata: {},
    })
    .returning({ id: credentials.id });
  madeTokens.push(token?.id as string);
  await database.insert(mcpUserCredentials).values({
    serverId: server,
    userId: who.id,
    credentialId: token?.id as string,
    scope: "read",
  });
  // The marketplace.
  const [publisher] = await database
    .insert(marketplacePublishers)
    .values({
      tenantId,
      displayName: `Pub ${randomUUID().slice(0, 8)}`,
      bio: "About me",
    })
    .returning({ id: marketplacePublishers.id });
  await database.insert(marketplaceListings).values({
    kind: "shared",
    slug: `listing-${randomUUID()}`,
    publisherId: publisher?.id as string,
    title: "Shared",
    summary: "s",
    category: "other",
    description: "d",
    content: { title: "t", roleDescription: "r", tools: [] },
    status: "published",
  });
  await database.insert(runSlots).values({
    tenantId,
    botId: coworker.id,
    runId: `run-${randomUUID()}`,
    userId: who.id,
    expiresAt: new Date(Date.now() + 60_000),
  });
  // The terms of service they accepted.
  await database.insert(termsAcceptances).values({
    userId: who.id,
    version: "2026-11-01-test",
    acceptedAt: new Date("2026-11-02T10:00:00Z"),
  });
  // Running in Ark's cloud: the agreement, a month charged, and the time the coworker ran.
  const rates = {
    computeCentsPerHour: 60,
    storageCentsPerGbMonth: 0,
    egressCentsPerGb: 0,
    paymentFeePercent: 5,
    paymentFeeFixedCents: 50,
    marginPercent: 0,
    minimumChargeCents: 500,
  };
  await database.insert(cloudAccounts).values({
    tenantId,
    enabled: true,
    monthlyCapCents: 3000,
    consentedAt: new Date("2026-09-01T00:00:00Z"),
    consentedRates: rates,
  });
  await database.insert(cloudCharges).values({
    tenantId,
    period: "2026-09",
    status: "charged",
    usage: { computeSeconds: 7200, storageByteSeconds: 0, egressBytes: 0 },
    rates,
    costCents: "120",
    amountCents: 190,
    providerRef: "paddle:PAYMENT-SERVICE-REFERENCE",
    note: "A NOTE TO OURSELVES",
  });
  await database.insert(cloudIntervals).values({
    tenantId,
    botId: coworker.id,
    source: "run",
    ref: `run-${randomUUID()}`,
    startedAt: new Date("2026-09-10T08:00:00Z"),
    lastSeenAt: new Date("2026-09-10T10:00:00Z"),
    endedAt: new Date("2026-09-10T10:00:00Z"),
  });
  await database.insert(billingEvents).values({
    provider: "paddle",
    eventId: `evt-${randomUUID()}`,
    type: "subscription.created",
    tenantId,
    payload: {},
  });
  // A paid subscription, only where accounts are the customer's own: a company's shared account is
  // not a customer's and must stay what it is.
  if (store.billingMode === "subscriptions")
    await database
      .update(subscriptions)
      .set({
        planId: "team",
        status: "active",
        provider: "paddle",
        providerCustomerId: "ctm_01x",
        providerSubscriptionId: `sub_${randomUUID().replaceAll("-", "").slice(0, 20)}`,
      })
      .where(eq(subscriptions.tenantId, tenantId));
  await database.insert(auditEvents).values({
    actorUserId: who.id,
    eventType: "session.signed_in",
    targetType: "person",
    targetId: who.id,
    payload: { email: who.email },
  });
  return {
    ...who,
    tokenId: token?.id as string,
    coworkerId: coworker.id,
    channelId,
    listingPublisherId: publisher?.id as string,
  };
}

async function rowsFor(
  userId: string,
  tenantId: string | undefined,
  coworkerId: string,
) {
  const n = async (query: Promise<Array<{ n: number }>>) =>
    (await query)[0]?.n ?? 0;
  return {
    users: await n(
      database.select({ n: count() }).from(users).where(eq(users.id, userId)),
    ),
    sessions: await n(
      database
        .select({ n: count() })
        .from(sessions)
        .where(eq(sessions.userId, userId)),
    ),
    accounts: await n(
      database
        .select({ n: count() })
        .from(accounts)
        .where(eq(accounts.userId, userId)),
    ),
    agents: await n(
      database
        .select({ n: count() })
        .from(agents)
        .where(eq(agents.id, coworkerId)),
    ),
    profiles: await n(
      database
        .select({ n: count() })
        .from(agentProfiles)
        .where(eq(agentProfiles.agentId, coworkerId)),
    ),
    grants: await n(
      database
        .select({ n: count() })
        .from(pluginGrants)
        .where(eq(pluginGrants.agentId, coworkerId)),
    ),
    skills: await n(
      database
        .select({ n: count() })
        .from(skills)
        .where(eq(skills.ownerUserId, userId)),
    ),
    routines: await n(
      database
        .select({ n: count() })
        .from(routines)
        .where(eq(routines.ownerUserId, userId)),
    ),
    models: await n(
      database
        .select({ n: count() })
        .from(modelConnections)
        .where(eq(modelConnections.userId, userId)),
    ),
    instructions: await n(
      database
        .select({ n: count() })
        .from(userInstructions)
        .where(eq(userInstructions.userId, userId)),
    ),
    composio: await n(
      database
        .select({ n: count() })
        .from(composioConnections)
        .where(eq(composioConnections.userId, userId)),
    ),
    voice: await n(
      database
        .select({ n: count() })
        .from(voiceSessions)
        .where(eq(voiceSessions.userId, userId)),
    ),
    files: await n(
      database
        .select({ n: count() })
        .from(attachments)
        .where(eq(attachments.uploadedBy, userId)),
    ),
    appLinks: await n(
      database
        .select({ n: count() })
        .from(mcpUserCredentials)
        .where(eq(mcpUserCredentials.userId, userId)),
    ),
    runSlots: await n(
      database
        .select({ n: count() })
        .from(runSlots)
        .where(eq(runSlots.userId, userId)),
    ),
    memberships: await n(
      database
        .select({ n: count() })
        .from(tenantMemberships)
        .where(eq(tenantMemberships.userId, userId)),
    ),
    tenant: tenantId
      ? await n(
          database
            .select({ n: count() })
            .from(tenants)
            .where(eq(tenants.id, tenantId)),
        )
      : 0,
    subscription: tenantId
      ? await n(
          database
            .select({ n: count() })
            .from(subscriptions)
            .where(eq(subscriptions.tenantId, tenantId)),
        )
      : 0,
    publishers: tenantId
      ? await n(
          database
            .select({ n: count() })
            .from(marketplacePublishers)
            .where(eq(marketplacePublishers.tenantId, tenantId)),
        )
      : 0,
    billingEvents: tenantId
      ? await n(
          database
            .select({ n: count() })
            .from(billingEvents)
            .where(eq(billingEvents.tenantId, tenantId)),
        )
      : 0,
    cloudAgreement: tenantId
      ? await n(
          database
            .select({ n: count() })
            .from(cloudAccounts)
            .where(eq(cloudAccounts.tenantId, tenantId)),
        )
      : 0,
    cloudCharges: tenantId
      ? await n(
          database
            .select({ n: count() })
            .from(cloudCharges)
            .where(eq(cloudCharges.tenantId, tenantId)),
        )
      : 0,
    termsAccepted: await n(
      database
        .select({ n: count() })
        .from(termsAcceptances)
        .where(eq(termsAcceptances.userId, userId)),
    ),
    cloudUsage: tenantId
      ? await n(
          database
            .select({ n: count() })
            .from(cloudIntervals)
            .where(eq(cloudIntervals.tenantId, tenantId)),
        )
      : 0,
  };
}

afterEach(async () => {
  for (const id of made.agents.splice(0))
    await database.delete(agents).where(eq(agents.id, id));
  for (const id of made.channels.splice(0))
    await database.delete(channels).where(eq(channels.id, id));
  const ids = made.users.splice(0);
  if (ids.length > 0) {
    await database
      .delete(mcpUserCredentials)
      .where(inArray(mcpUserCredentials.userId, ids));
    // No foreign key holds these to a person, so they outlive one, and a later test file
    // reads the whole table.
    await database
      .delete(composioConnections)
      .where(inArray(composioConnections.userId, ids));
    await database.delete(users).where(inArray(users.id, ids));
  }
  for (const id of madeTokens.splice(0)) {
    await database.delete(credentials).where(eq(credentials.id, id));
  }
  for (const id of made.tenants.splice(0)) {
    await database.delete(billingEvents).where(eq(billingEvents.tenantId, id));
    await database.delete(tenants).where(eq(tenants.id, id));
  }
});
afterAll(async () => {
  await database.$client.close();
});

function dependencies(overrides: Partial<ErasureDependencies> = {}) {
  const conversations = fakeConversations();
  const billing = fakeBilling();
  return {
    conversations,
    billing,
    deps: {
      database,
      accounts: hosted,
      billing: billing.billing,
      conversations: conversations.service,
      ...overrides,
    } satisfies ErasureDependencies,
  };
}

describe("removing a person", () => {
  test("takes everything that is theirs, and the account with them when they were all of it", async () => {
    const ann = await furnished("ann");
    const before = await rowsFor(ann.id, ann.tenantId, ann.coworkerId);
    for (const [name, total] of Object.entries(before)) {
      expect({ name, total: total > 0 }).toEqual({ name, total: true });
    }
    const conversations = fakeConversations({ [ann.id]: 3 });
    const billing = fakeBilling();
    const revoked: string[] = [];
    const result = await erasePerson(
      {
        database,
        accounts: hosted,
        billing: billing.billing,
        conversations: conversations.service,
        revokeIntegration: async ({ toolkit }) => {
          revoked.push(toolkit);
        },
      },
      ann.id,
      { requestedBy: "self" },
    );

    expect(result).toEqual({
      conversationsRemoved: 3,
      accountRemoved: true,
      followUp: [],
    });
    const after = await rowsFor(ann.id, ann.tenantId, ann.coworkerId);
    for (const [name, total] of Object.entries(after)) {
      expect({ name, total }).toEqual({ name, total: 0 });
    }
    // The tokens behind her connected apps are gone too, not only the link to them.
    const leftoverTokens = await database
      .select({ n: count() })
      .from(credentials)
      .where(eq(credentials.id, ann.tokenId));
    expect(leftoverTokens[0]?.n).toBe(0);
    expect(conversations.threads.get(ann.id)).toEqual([]);
    expect(revoked).toEqual(["gmail"]);
    // The channel only she was in is gone, with what it said.
    const gone = await database
      .select({ n: count() })
      .from(channels)
      .where(eq(channels.id, ann.channelId));
    expect(gone[0]?.n).toBe(0);
    // And the subscription was stopped at once, not at the end of the period.
    expect(billing.cancelled).toHaveLength(1);
    expect(billing.cancelled[0]?.atPeriodEnd).toBe(false);
  });

  test("touches nothing that is anybody else's", async () => {
    const ann = await furnished("ann");
    const bob = await furnished("bob");
    const bobBefore = await rowsFor(bob.id, bob.tenantId, bob.coworkerId);
    const { deps, conversations } = dependencies();
    conversations.threads.set(bob.id, ["bob-thread-1"]);
    conversations.threads.set(ann.id, ["ann-thread-1"]);
    await erasePerson(deps, ann.id, { requestedBy: "self" });
    expect(await rowsFor(bob.id, bob.tenantId, bob.coworkerId)).toEqual(
      bobBefore,
    );
    expect(conversations.threads.get(bob.id)).toEqual(["bob-thread-1"]);
    expect(conversations.state.removed).toEqual(["ann-thread-1"]);
  });

  test("on a company's one shared account, the person goes and the account does not", async () => {
    const ann = await furnished("ann", {
      store: company,
      profiles: companyProfiles,
    });
    const colleague = await person("colleague", { store: company });
    const sharedTenant = ann.tenantId as string;
    expect(colleague.tenantId).toBe(sharedTenant);
    const billing = fakeBilling();
    const result = await erasePerson(
      { database, accounts: company, billing: billing.billing },
      ann.id,
      { requestedBy: "staff" },
    );
    expect(result.accountRemoved).toBe(false);
    expect(billing.cancelled).toEqual([]);
    expect((await rowsFor(ann.id, sharedTenant, ann.coworkerId)).users).toBe(0);
    expect((await rowsFor(ann.id, sharedTenant, ann.coworkerId)).agents).toBe(
      0,
    );
    // The company's account, and the colleague's place in it, are still there.
    expect((await rowsFor(colleague.id, sharedTenant, "none")).tenant).toBe(1);
    expect(
      (await rowsFor(colleague.id, sharedTenant, "none")).memberships,
    ).toBe(1);
  });

  test("an account with other people in it outlives any one of them", async () => {
    const ann = await furnished("ann");
    const teammate = await person("teammate");
    await database
      .delete(tenantMemberships)
      .where(eq(tenantMemberships.userId, teammate.id));
    await database.insert(tenantMemberships).values({
      tenantId: ann.tenantId as string,
      userId: teammate.id,
      role: "member",
    });
    const { deps, billing } = dependencies();
    const result = await erasePerson(deps, ann.id, { requestedBy: "self" });
    expect(result.accountRemoved).toBe(false);
    expect(billing.cancelled).toEqual([]);
    expect((await rowsFor(teammate.id, ann.tenantId, "none")).tenant).toBe(1);
  });

  test("a subscription that already ended is not cancelled again", async () => {
    const ann = await furnished("ann");
    await database
      .update(subscriptions)
      .set({ status: "canceled" })
      .where(eq(subscriptions.tenantId, ann.tenantId as string));
    const { deps, billing } = dependencies();
    await erasePerson(deps, ann.id, { requestedBy: "self" });
    expect(billing.cancelled).toEqual([]);
  });

  test("can be asked again after it has been done", async () => {
    const ann = await furnished("ann");
    const { deps } = dependencies();
    await erasePerson(deps, ann.id, { requestedBy: "self" });
    await expect(
      erasePerson(deps, ann.id, { requestedBy: "self" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  test("an integration vendor that will not answer is reported, not allowed to block the erasure", async () => {
    const ann = await furnished("ann");
    const { deps } = dependencies({
      revokeIntegration: async () => {
        throw new Error("vendor down");
      },
    });
    const result = await erasePerson(deps, ann.id, { requestedBy: "self" });
    expect(result.followUp).toHaveLength(1);
    expect(result.followUp[0]).toContain("gmail");
    expect((await rowsFor(ann.id, ann.tenantId, ann.coworkerId)).users).toBe(0);
  });
});

describe("when something cannot be done first", () => {
  test("the payment service refusing to stop the subscription leaves everything as it was", async () => {
    const ann = await furnished("ann");
    const before = await rowsFor(ann.id, ann.tenantId, ann.coworkerId);
    const conversations = fakeConversations({ [ann.id]: 2 });
    const failing = fakeBilling({ failCancel: true });
    const refusal = await erasePerson(
      {
        database,
        accounts: hosted,
        billing: failing.billing,
        conversations: conversations.service,
      },
      ann.id,
      { requestedBy: "self" },
    ).catch((error) => error);
    expect(refusal).toBeInstanceOf(ErasureRefused);
    expect(refusal.code).toBe("billing");
    expect(refusal.message).toMatch(/nothing was removed/);
    expect(refusal.message).not.toMatch(/Paddle is down/);
    expect(await rowsFor(ann.id, ann.tenantId, ann.coworkerId)).toEqual(before);
    expect(conversations.state.removed).toEqual([]);
  });

  test("conversations that cannot be removed keep the account, and say the subscription was already stopped", async () => {
    const ann = await furnished("ann");
    const before = await rowsFor(ann.id, ann.tenantId, ann.coworkerId);
    const conversations = fakeConversations({ [ann.id]: 2 });
    conversations.state.failOnRemove = true;
    const billing = fakeBilling();
    const refusal = await erasePerson(
      {
        database,
        accounts: hosted,
        billing: billing.billing,
        conversations: conversations.service,
      },
      ann.id,
      { requestedBy: "self" },
    ).catch((error) => error);
    expect(refusal.code).toBe("conversations");
    expect(refusal.message).toMatch(/already been stopped/);
    expect(await rowsFor(ann.id, ann.tenantId, ann.coworkerId)).toEqual(before);
    // Asked again once the service is back, it finishes.
    conversations.state.failOnRemove = false;
    const result = await erasePerson(
      {
        database,
        accounts: hosted,
        billing: billing.billing,
        conversations: conversations.service,
      },
      ann.id,
      { requestedBy: "self" },
    );
    expect(result.conversationsRemoved).toBe(2);
    expect((await rowsFor(ann.id, ann.tenantId, ann.coworkerId)).users).toBe(0);
  });

  test("an administrator cannot remove themselves, and the last one cannot be removed by anybody", async () => {
    const boss = await person("boss", { admin: true });
    const { deps } = dependencies();
    await expect(
      erasePerson(deps, boss.id, { requestedBy: "self" }),
    ).rejects.toMatchObject({ code: "administrator" });
    // Staff can remove an administrator, unless it is the only one. The test database may hold others
    // from other tests, so what is asserted is the rule on a deployment with exactly this one.
    const admins = await database
      .select({ n: count() })
      .from(userRoles)
      .where(eq(userRoles.role, "admin"));
    if ((admins[0]?.n ?? 0) === 1) {
      await expect(
        erasePerson(deps, boss.id, { requestedBy: "staff" }),
      ).rejects.toMatchObject({ code: "last_administrator" });
    }
    const second = await person("second", { admin: true });
    await expect(
      erasePerson(deps, second.id, { requestedBy: "staff" }),
    ).resolves.toMatchObject({ accountRemoved: true });
  });
});

describe("what a person is sent", () => {
  async function exported(
    userId: string,
    conversations = fakeConversations(),
    pageSize?: number,
  ) {
    const parts: string[] = [];
    for await (const chunk of exportPerson(
      { database, accounts: hosted, conversations: conversations.service },
      userId,
      pageSize ? { auditPageSize: pageSize } : {},
    )) {
      parts.push(chunk);
    }
    return parts.join("");
  }

  test("is one valid file holding everything of theirs", async () => {
    const ann = await furnished("ann");
    const text = await exported(ann.id, fakeConversations({ [ann.id]: 2 }));
    const file = JSON.parse(text);
    expect(file.person).toMatchObject({ email: ann.email, name: "ann" });
    expect(file.roles).toEqual(["user"]);
    expect(file.account).toMatchObject({
      plan: "team",
      subscriptionStatus: "active",
    });
    expect(file.coworkers).toHaveLength(1);
    expect(file.coworkers[0]).toMatchObject({
      title: "Analyst",
      roleDescription: "Private role of ann.",
      instruction: "SECRET PROMPT OF ann",
    });
    expect(file.coworkers[0].grants).toEqual([
      { kind: "mcp", ref: "srv-1/search" },
    ]);
    expect(file.skills[0].instructions).toBe("Private instructions");
    expect(file.routines[0].instruction).toBe("Every morning");
    expect(file.instructions).toBe("Always be brief.");
    expect(file.connectedApps[0].app).toBe("gmail");
    expect(file.uploadedFiles).toEqual([
      { name: "plan.pdf", type: "application/pdf", sizeBytes: 12 },
    ]);
    expect(file.channels[0].name).toBe("Chat of ann");
    expect(file.marketplace.listings).toHaveLength(1);
    expect(file.securityRecord).toHaveLength(1);
    expect(file.conversations).toHaveLength(2);
    expect(file.conversations[0].messages[0].content).toContain("hello from");
    expect(file.notIncluded.length).toBeGreaterThan(0);
  });

  test("includes which version of the terms they accepted, and when", async () => {
    const ann = await furnished("ann");
    const file = JSON.parse(await exported(ann.id));
    expect(file.termsAccepted).toEqual([
      { version: "2026-11-01-test", acceptedAt: "2026-11-02T10:00:00.000Z" },
    ]);
  });

  test("includes what they agreed to for cloud running, the months charged and the time their coworkers ran", async () => {
    const ann = await furnished("ann");
    const file = JSON.parse(await exported(ann.id));
    expect(file.cloudRunning.agreement).toMatchObject({
      enabled: true,
      monthlyLimitCents: 3000,
    });
    expect(file.cloudRunning.agreement.agreedToPrices.computeCentsPerHour).toBe(
      60,
    );
    expect(file.cloudRunning.agreement.earlierAgreements).toEqual([]);
    expect(file.cloudRunning.months).toEqual([
      expect.objectContaining({
        month: "2026-09",
        status: "charged",
        chargedCents: 190,
      }),
    ]);
    expect(file.cloudUsage).toHaveLength(1);
    expect(file.cloudUsage[0]).toMatchObject({ kind: "run" });
    // Their record, not the payment service's reference or a note we wrote to ourselves.
    const text = JSON.stringify(file);
    expect(text).not.toContain("PAYMENT-SERVICE-REFERENCE");
    expect(text).not.toContain("A NOTE TO OURSELVES");
  });

  test("reads a long record of cloud use a page at a time and loses none of it", async () => {
    const ann = await furnished("ann");
    for (let i = 0; i < 7; i++) {
      await database.insert(cloudIntervals).values({
        tenantId: ann.tenantId as string,
        botId: ann.coworkerId,
        source: "run",
        ref: `bulk-${randomUUID()}`,
        startedAt: new Date("2026-09-11T08:00:00Z"),
        lastSeenAt: new Date("2026-09-11T08:30:00Z"),
        endedAt: new Date("2026-09-11T08:30:00Z"),
      });
    }
    const file = JSON.parse(await exported(ann.id, fakeConversations(), 3));
    expect(file.cloudUsage).toHaveLength(8);
  });

  test("holds nothing that opens a door", async () => {
    const ann = await furnished("ann");
    const text = await exported(ann.id);
    for (const secret of [
      "SECRET-ACCESS-TOKEN",
      "SECRET-REFRESH-TOKEN",
      "ENCRYPTED-KEY-MATERIAL",
      "ENCRYPTED-TOKEN",
      "FILE-CONTENT",
    ]) {
      expect(text).not.toContain(secret);
    }
    const file = JSON.parse(text);
    // A model connection says it has a key, never what it is.
    expect(file.modelConnections).toEqual([
      expect.objectContaining({ provider: "anthropic", hasKey: true }),
    ]);
    expect(file.signInMethods).toEqual([
      expect.objectContaining({ provider: "google" }),
    ]);
    expect(Object.keys(file.signInMethods[0])).not.toContain("accessToken");
  });

  test("is only about the person asked for", async () => {
    const ann = await furnished("ann");
    const bob = await furnished("bob");
    const text = await exported(ann.id);
    expect(text).not.toContain(bob.email);
    expect(text).not.toContain("SECRET PROMPT OF bob");
  });

  test("reads a long security record a page at a time and loses none of it", async () => {
    const ann = await furnished("ann");
    await database.insert(auditEvents).values(
      Array.from({ length: 6 }, (_, i) => ({
        actorUserId: ann.id,
        eventType: "agent.created",
        targetType: "agent",
        targetId: `a-${i}`,
        payload: { n: i },
      })),
    );
    const file = JSON.parse(await exported(ann.id, fakeConversations(), 2));
    expect(file.securityRecord).toHaveLength(7);
    expect(
      new Set(file.securityRecord.map((row: { id: string }) => row.id)).size,
    ).toBe(7);
  });

  test("is valid even when there is nothing in it: no coworkers, no conversations", async () => {
    const empty = await person("empty");
    const file = JSON.parse(await exported(empty.id));
    expect(file.coworkers).toEqual([]);
    expect(file.conversations).toEqual([]);
    expect(file.securityRecord).toEqual([]);
  });
});

describe("through the routes", () => {
  const events: PrivacyAuditEvent[] = [];

  function appFor(
    who: { id: string; email: string; role?: "admin" | "user" },
    deps: ErasureDependencies,
  ) {
    const requireUser: Parameters<typeof privacyRoutes>[0]["requireUser"] =
      async (context, next) => {
        context.set("actor", {
          id: who.id,
          email: who.email,
          role: who.role ?? "user",
        });
        await next();
      };
    const audit = async (event: PrivacyAuditEvent) => {
      events.push(event);
    };
    return new Hono()
      .route(
        "/api/account",
        privacyRoutes({ requireUser, dependencies: deps, audit }),
      )
      .route(
        "/api/admin/people",
        adminPrivacyRoutes({ requireUser, dependencies: deps, audit }),
      );
  }

  afterEach(() => {
    events.length = 0;
  });

  test("a download carries the file, as an attachment that is not cached", async () => {
    const ann = await furnished("ann");
    const { deps } = dependencies();
    const response = await appFor(ann, deps).request("/api/account/export");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toMatch(
      /^attachment; filename="ark-data-\d{4}-\d{2}-\d{2}\.json"$/,
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.parse(await response.text()).person.email).toBe(ann.email);
    expect(events.map((e) => e.eventType)).toEqual(["person.exported"]);
  });

  test("deleting needs the person to type their address, and then does it", async () => {
    const ann = await furnished("ann");
    const { deps } = dependencies();
    const app = appFor(ann, deps);
    const post = (body: unknown) =>
      app.request("/api/account/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    for (const body of [
      {},
      { confirmEmail: "someone@else.com" },
      { confirmEmail: ann.email, extra: 1 },
    ]) {
      expect((await post(body)).status).toBe(400);
    }
    expect((await rowsFor(ann.id, ann.tenantId, ann.coworkerId)).users).toBe(1);

    const done = await post({ confirmEmail: ann.email.toUpperCase() });
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual({ ok: true, accountRemoved: true });
    expect((await rowsFor(ann.id, ann.tenantId, ann.coworkerId)).users).toBe(0);
    // The receipt says who asked and what went, and not who the person was.
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("person.erased");
    expect(JSON.stringify(events[0])).not.toContain(ann.email);
  });

  test("a failure is a sentence and a status, not a crash", async () => {
    const ann = await furnished("ann");
    const failing = fakeBilling({ failCancel: true });
    const { deps } = dependencies({ billing: failing.billing });
    const response = await appFor(ann, deps).request("/api/account/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmEmail: ann.email }),
    });
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toMatch(
      /subscription could not be stopped/,
    );
  });

  test("staff act on a request for somebody else, and ordinary people cannot", async () => {
    const target = await furnished("target");
    const staff = await person("staff", { admin: true });
    const ordinary = await person("ordinary");
    const { deps } = dependencies();

    const refused = await appFor(ordinary, deps).request(
      `/api/admin/people/${target.id}/export`,
    );
    expect(refused.status).toBe(403);
    const forbiddenErase = await appFor(ordinary, deps).request(
      `/api/admin/people/${target.id}/erase`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmEmail: target.email }),
      },
    );
    expect(forbiddenErase.status).toBe(403);

    const asStaff = appFor({ ...staff, role: "admin" }, deps);
    expect(
      (await asStaff.request(`/api/admin/people/${target.id}/export`)).status,
    ).toBe(200);
    // The address typed must be the target's, not the staff member's.
    const wrong = await asStaff.request(
      `/api/admin/people/${target.id}/erase`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmEmail: staff.email }),
      },
    );
    expect(wrong.status).toBe(400);
    const done = await asStaff.request(`/api/admin/people/${target.id}/erase`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmEmail: target.email }),
    });
    expect(done.status).toBe(200);
    expect(
      (await rowsFor(target.id, target.tenantId, target.coworkerId)).users,
    ).toBe(0);
    const erased = events.find((e) => e.eventType === "person.erased");
    expect(erased).toMatchObject({
      actorUserId: staff.id,
      targetId: target.id,
    });
    expect(
      (await asStaff.request(`/api/admin/people/${randomUUID()}/export`))
        .status,
    ).toBe(404);
  });
});
