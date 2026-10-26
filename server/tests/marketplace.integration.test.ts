import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { count, eq, inArray } from "drizzle-orm";
import { LIMITS } from "../../shared/marketplace";
import { createAccountStore } from "../src/accounts/store";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createRuntimeAgentLoader } from "../src/agents/runtime-agents";
import { TEAMWORK } from "../src/agents/team";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  marketplaceInstalls,
  marketplaceListings,
  marketplacePublishers,
  marketplaceReports,
  pluginGrants,
  tenantMemberships,
  tenants,
  users,
} from "../src/db/schema";
import { OFFICIAL_LISTINGS } from "../src/marketplace/official";
import {
  createMarketplaceStore,
  MarketplaceError,
  type ShareInput,
} from "../src/marketplace/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * The marketplace's promises, held against a real database (decision D7):
 * Ark's own digital employees can be installed; another person's shared coworker can only be read.
 * Nothing in it can be turned into a running coworker, no secret gets in, and nobody sees a listing
 * that has not been approved.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const MANAGED = new URL("https://managed.example.test/ag-ui");
const made = { users: [] as string[], agents: [] as string[] };

const accounts = createAccountStore(database, {
  billingMode: "subscriptions",
});
const profiles = createAgentProfileStore(
  database,
  MANAGED,
  undefined,
  accounts,
);
const market = createMarketplaceStore(database, { accounts, profiles });

async function person(label: string, role: "admin" | "user" = "user") {
  const id = `mkt-${label}-${randomUUID()}`;
  await database.insert(users).values({ id, email: `${id}@example.com` });
  made.users.push(id);
  await accounts.ensureTenant(id);
  return { id, role } satisfies AgentActor;
}

async function coworker(owner: AgentActor, roleDescription = "Does analysis.") {
  const profile = await profiles.create(owner, {
    name: `Bot ${randomUUID().slice(0, 6)}`,
    title: "Analyst",
    roleDescription,
    visibility: "private",
  } as never);
  made.agents.push(profile.id);
  return profile;
}

/** Someone with a public name, ready to share. */
async function publisher(label: string) {
  const actor = await person(label);
  await market.savePublisher(actor, {
    displayName: `Pub ${randomUUID().slice(0, 8)}`,
    bio: "",
  });
  return actor;
}

function shareInput(agentId: string, overrides: Partial<ShareInput> = {}) {
  return {
    agentId,
    title: "Careful analyst",
    summary: "Reads figures and reports what changed.",
    category: "research",
    tags: ["analysis"],
    description: "How I set mine up.",
    confirmedNoPrivateData: false,
    ...overrides,
  } satisfies ShareInput;
}

async function failure(promise: Promise<unknown>): Promise<MarketplaceError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof MarketplaceError) return error;
    throw error;
  }
  throw new Error("Expected the call to be refused.");
}

beforeAll(async () => {
  await market.syncOfficial();
});

afterEach(async () => {
  for (const id of made.agents.splice(0))
    await database.delete(agents).where(eq(agents.id, id));
  for (const id of made.users.splice(0)) {
    const rows = await database
      .select({ tenantId: tenantMemberships.tenantId })
      .from(tenantMemberships)
      .where(eq(tenantMemberships.userId, id));
    await database.delete(users).where(eq(users.id, id));
    for (const row of rows)
      await database.delete(tenants).where(eq(tenants.id, row.tenantId));
  }
});

afterAll(async () => {
  await database.$client.close();
});

describe("Ark's own digital employees", () => {
  test("are all listed, and each one's instruction fits a coworker's role description", async () => {
    const page = await market.browse(await person("viewer"), {
      kind: "official",
      limit: 60,
    });
    expect(page.listings.map((l) => l.slug).sort()).toEqual(
      OFFICIAL_LISTINGS.map((l) => l.slug).sort(),
    );
    for (const listing of OFFICIAL_LISTINGS) {
      expect(listing.install.roleDescription.length).toBeLessThanOrEqual(1000);
      expect(listing.install.name.length).toBeLessThanOrEqual(80);
      expect(listing.install.title.length).toBeLessThanOrEqual(120);
    }
    expect(page.listings.every((l) => l.publisher.official)).toBe(true);
  });

  test("are written again on every start without losing their install counts", async () => {
    const buyer = await person("buyer");
    const slug = OFFICIAL_LISTINGS[0]?.slug as string;
    await market.install(buyer, slug);
    const before = await market.get(buyer, slug);
    await market.syncOfficial();
    await market.syncOfficial();
    const after = await market.get(buyer, slug);
    expect(after.installCount).toBe(before.installCount);
    const [{ total } = { total: 0 }] = await database
      .select({ total: count() })
      .from(marketplaceListings)
      .where(eq(marketplaceListings.kind, "official"));
    expect(total).toBe(OFFICIAL_LISTINGS.length);
  });

  test("one that leaves the catalogue is taken down, and comes back when it returns", async () => {
    const smaller = createMarketplaceStore(database, {
      accounts,
      profiles,
      official: OFFICIAL_LISTINGS.slice(1),
    });
    await smaller.syncOfficial();
    const viewer = await person("viewer");
    const gone = OFFICIAL_LISTINGS[0]?.slug as string;
    // Taken down: to everyone but staff it no longer exists.
    expect((await failure(market.get(viewer, gone))).code).toBe("not_found");
    await market.syncOfficial();
    expect((await market.get(viewer, gone)).title).toBe(
      OFFICIAL_LISTINGS[0]?.title as string,
    );
  });

  test("install as a private coworker of the person's own, with no tools and no skills", async () => {
    const ann = await person("ann");
    const bob = await person("bob");
    const slug = "research-analyst";
    const result = await market.install(ann, slug);
    made.agents.push(result.agentId);

    const mine = await profiles.get(ann, result.agentId);
    expect(mine?.title).toBe("Research Analyst");
    expect(mine?.visibility).toBe("private");
    expect(mine?.ownerUserId).toBe(ann.id);
    expect(mine?.roleDescription).toContain("research analyst");

    // Nothing was granted: tools are the person's decision, one at a time.
    const grants = await database
      .select()
      .from(pluginGrants)
      .where(eq(pluginGrants.agentId, result.agentId));
    expect(grants).toEqual([]);

    // And it is hers alone.
    expect(await profiles.get(bob, result.agentId)).toBeNull();
    const installs = await database
      .select()
      .from(marketplaceInstalls)
      .where(eq(marketplaceInstalls.agentId, result.agentId));
    expect(installs).toHaveLength(1);
    expect(installs[0]?.userId).toBe(ann.id);
    expect((await market.get(ann, slug)).installedByMe).toBe(true);
    expect((await market.get(bob, slug)).installedByMe).toBe(false);
  });

  test("count one install each time", async () => {
    const ann = await person("ann");
    const slug = "writing-editor";
    const before = (await market.get(ann, slug)).installCount;
    made.agents.push((await market.install(ann, slug)).agentId);
    made.agents.push((await market.install(ann, slug)).agentId);
    expect((await market.get(ann, slug)).installCount).toBe(before + 2);
  });
});

describe("a shared coworker", () => {
  test("can be read by everyone once approved, and cannot be installed by anyone", async () => {
    const author = await publisher("author");
    const reader = await person("reader");
    const staff = await person("staff", "admin");
    const original = await coworker(author, "Compares quarterly figures.");
    const listing = await market.share(author, shareInput(original.id));
    await market.approve(staff, listing.id);

    const seen = await market.get(reader, listing.slug);
    expect(seen.kind).toBe("shared");
    expect(seen.mine).toBe(false);
    expect((seen.content as { roleDescription: string }).roleDescription).toBe(
      "Compares quarterly figures.",
    );

    const before = await database.select({ total: count() }).from(agents);
    const refusal = await failure(market.install(reader, listing.slug));
    expect(refusal.code).toBe("view_only");
    // Nothing was made: no coworker, no install record.
    expect(await database.select({ total: count() }).from(agents)).toEqual(
      before,
    );
    const installs = await database
      .select()
      .from(marketplaceInstalls)
      .where(eq(marketplaceInstalls.listingId, listing.id));
    expect(installs).toEqual([]);
    // Not even the author installs their own: it is a guide, not a copy.
    expect((await failure(market.install(author, listing.slug))).code).toBe(
      "view_only",
    );
  });

  test("never becomes something that runs on another account", async () => {
    const author = await publisher("author");
    const reader = await person("reader");
    const staff = await person("staff", "admin");
    const original = await coworker(author);
    const listing = await market.share(author, shareInput(original.id));
    await market.approve(staff, listing.id);

    // The runtime builds a person's roster from coworkers they own or can see. A listing is not one.
    const loader = createRuntimeAgentLoader(database);
    const roster = (await loader(reader)).map((agent) => agent.id);
    expect(roster).not.toContain(original.id);
    const everyone = await database.select({ id: agents.id }).from(agents);
    expect(everyone.map((a) => a.id)).not.toContain(listing.id);
    expect(await profiles.get(reader, original.id)).toBeNull();
  });

  test("shows its words and the names of its tools, never an address or a key", async () => {
    const author = await publisher("author");
    const original = await coworker(author, "Answers support tickets.");
    // A coworker with its own server and a credential, and tools it may call.
    await database
      .update(agents)
      .set({
        type: "remote_ag_ui",
        configuration: {
          endpoint: "https://secret-host.internal.example/ag-ui",
          auth: { header: "Authorization", ref: "vault-secret-reference" },
        },
      })
      .where(eq(agents.id, original.id));
    await database.insert(pluginGrants).values([
      { kind: "mcp", ref: "server-7f3a/search_web", agentId: original.id },
      { kind: "mcp", ref: "server-7f3a/read_file", agentId: original.id },
      { kind: "skill", ref: "private-skill-slug", agentId: original.id },
    ]);
    const listing = await market.share(author, shareInput(original.id));
    const text = JSON.stringify(listing);
    expect(text).not.toContain("secret-host");
    expect(text).not.toContain("vault-secret-reference");
    expect(text).not.toContain("server-7f3a");
    expect(text).not.toContain("private-skill-slug");
    expect((listing.content as { tools: string[] }).tools).toEqual([
      "read_file",
      "search_web",
    ]);
  });

  test("includes the standing instruction of a coworker that runs on one", async () => {
    const author = await publisher("author");
    const original = await coworker(author);
    await database
      .update(agents)
      .set({
        type: "built_in",
        configuration: { systemPrompt: "Always answer in two sentences." },
      })
      .where(eq(agents.id, original.id));
    const listing = await market.share(author, shareInput(original.id));
    expect((listing.content as { instructions?: string }).instructions).toBe(
      "Always answer in two sentences.",
    );
  });

  test("is a copy of the moment it was shared, not a link", async () => {
    const author = await publisher("author");
    const original = await coworker(author, "Original words.");
    const listing = await market.share(author, shareInput(original.id));
    await database
      .update(agentProfiles)
      .set({ roleDescription: "Changed afterwards." })
      .where(eq(agentProfiles.agentId, original.id));
    const again = await market.get(author, listing.slug);
    expect((again.content as { roleDescription: string }).roleDescription).toBe(
      "Original words.",
    );
  });

  test("can only be made from a coworker the person owns", async () => {
    const author = await publisher("author");
    const other = await person("other");
    const theirs = await coworker(other);
    expect(
      (await failure(market.share(author, shareInput(theirs.id)))).code,
    ).toBe("not_found");
    const nothing = await failure(
      market.share(author, shareInput("agent-that-does-not-exist")),
    );
    expect(nothing.code).toBe("not_found");
  });

  test("needs a public name before anything is shared", async () => {
    const nameless = await person("nameless");
    const original = await coworker(nameless);
    const refusal = await failure(
      market.share(nameless, shareInput(original.id)),
    );
    expect(refusal.code).toBe("invalid");
    expect(refusal.message).toMatch(/name/i);
  });
});

describe("what is allowed into a listing", () => {
  test("a secret is refused, and the refusal says where without repeating it", async () => {
    const author = await publisher("author");
    const original = await coworker(
      author,
      "Use the key sk-ant-api03-abcdefghijklmnopqrstuvwxyz to call the model.",
    );
    const refusal = await failure(
      market.share(author, shareInput(original.id)),
    );
    expect(refusal.code).toBe("unclean");
    expect(refusal.findings.some((f) => f.kind === "api_key")).toBe(true);
    expect(refusal.findings[0]?.field).toBe("Role description");
    expect(JSON.stringify(refusal.findings)).not.toContain("abcdefghijkl");
    expect(refusal.message).not.toContain("abcdefghijkl");
    // And confirming does not help: a secret has no safe form in a public listing.
    const stubborn = await failure(
      market.share(
        author,
        shareInput(original.id, { confirmedNoPrivateData: true }),
      ),
    );
    expect(stubborn.code).toBe("unclean");
    const saved = await database
      .select({ total: count() })
      .from(marketplaceListings)
      .where(eq(marketplaceListings.sourceAgentId, original.id));
    expect(saved[0]?.total).toBe(0);
  });

  test("a secret in the listing's own text is refused too", async () => {
    const author = await publisher("author");
    const original = await coworker(author);
    const refusal = await failure(
      market.share(
        author,
        shareInput(original.id, {
          description: "My token is ghp_abcdefghijklmnopqrstuvwxyz0123456789",
        }),
      ),
    );
    expect(refusal.findings[0]?.field).toBe("Description");
  });

  test("private details need the publisher to say they checked", async () => {
    const author = await publisher("author");
    const original = await coworker(
      author,
      "Send summaries to finance@customer-corp.example every Friday.",
    );
    const first = await failure(market.share(author, shareInput(original.id)));
    expect(first.code).toBe("unclean");
    expect(first.findings.map((f) => f.kind)).toContain("email");
    const accepted = await market.share(
      author,
      shareInput(original.id, { confirmedNoPrivateData: true }),
    );
    expect(accepted.status).toBe("pending");
  });

  test("fields are bounded and the category must be one of ours", async () => {
    const author = await publisher("author");
    const original = await coworker(author);
    for (const bad of [
      { title: "" },
      { title: "x".repeat(LIMITS.title + 1) },
      { summary: "x".repeat(LIMITS.summary + 1) },
      { description: "x".repeat(LIMITS.description + 1) },
      { category: "made-up" },
      { tags: Array.from({ length: LIMITS.tags + 1 }, (_, i) => `tag${i}`) },
      { tags: ["<script>"] },
    ]) {
      const refusal = await failure(
        market.share(author, shareInput(original.id, bad)),
      );
      expect(refusal.code).toBe("invalid");
    }
  });

  test("an account can have only so many listings waiting at once", async () => {
    const author = await publisher("author");
    const original = await coworker(author);
    for (let i = 0; i < LIMITS.pendingPerAccount; i += 1) {
      await market.share(
        author,
        shareInput(original.id, { title: `Listing ${i}` }),
      );
    }
    const refusal = await failure(
      market.share(author, shareInput(original.id)),
    );
    expect(refusal.code).toBe("limit");
  });
});

describe("publisher names", () => {
  test("cannot pretend to be Ark, however they are written", async () => {
    const actor = await person("faker");
    for (const name of [
      "Ark",
      "ark",
      "A.r.k",
      "ArkAgent",
      "ARK Official",
      "Ark Team",
      "Ark-Support",
      "Ârk",
      "Staff",
    ]) {
      const refusal = await failure(
        market.savePublisher(actor, { displayName: name, bio: "" }),
      );
      expect(refusal.code).toBe("invalid");
    }
    // A name that merely starts with the same letters is fine.
    const ok = await market.savePublisher(actor, {
      displayName: `Arkwright ${randomUUID().slice(0, 6)}`,
      bio: "",
    });
    expect(ok.official).toBe(false);
  });

  test("are unique whatever the capital letters, and cannot be an email address", async () => {
    const first = await person("first");
    const second = await person("second");
    const name = `Unique ${randomUUID().slice(0, 8)}`;
    await market.savePublisher(first, { displayName: name, bio: "" });
    const clash = await failure(
      market.savePublisher(second, {
        displayName: name.toUpperCase(),
        bio: "",
      }),
    );
    expect(clash.code).toBe("conflict");
    const email = await failure(
      market.savePublisher(second, {
        displayName: "me@private.example",
        bio: "",
      }),
    );
    expect(email.code).toBe("invalid");
    // The same account can rename itself, including to a different spelling of its own name.
    const renamed = await market.savePublisher(first, {
      displayName: name.toUpperCase(),
      bio: "Hello.",
    });
    expect(renamed.bio).toBe("Hello.");
  });
});

describe("review", () => {
  test("a listing is invisible to everyone but its owner and staff until it is approved", async () => {
    const author = await publisher("author");
    const stranger = await person("stranger");
    const staff = await person("staff", "admin");
    const original = await coworker(author);
    const listing = await market.share(
      author,
      shareInput(original.id, { title: "Hidden until approved" }),
    );
    expect(listing.status).toBe("pending");

    expect((await failure(market.get(stranger, listing.slug))).code).toBe(
      "not_found",
    );
    expect((await market.get(author, listing.slug)).mine).toBe(true);
    expect((await market.get(staff, listing.slug)).status).toBe("pending");
    const found = await market.browse(stranger, {
      q: "Hidden until approved",
      limit: 60,
    });
    expect(found.listings).toEqual([]);
    expect((await market.publisherPage(listing.publisher.id)).listings).toEqual(
      [],
    );

    await market.approve(staff, listing.id);
    expect((await market.get(stranger, listing.slug)).title).toBe(
      "Hidden until approved",
    );
    // Others never see its state or the reviewer's note.
    expect((await market.get(stranger, listing.slug)).status).toBeUndefined();
  });

  test("only staff review, and a rejection has to say why", async () => {
    const author = await publisher("author");
    const original = await coworker(author);
    const staff = await person("staff", "admin");
    const listing = await market.share(author, shareInput(original.id));

    for (const attempt of [
      () => market.approve(author, listing.id),
      () => market.reject(author, listing.id, "no"),
      () => market.remove(author, listing.id, "no"),
      () => market.pending(author),
      () => market.reports(author),
    ]) {
      expect((await failure(attempt())).code).toBe("forbidden");
    }
    expect((await failure(market.reject(staff, listing.id, "  "))).code).toBe(
      "invalid",
    );
    await market.reject(staff, listing.id, "Please describe what it is for.");
    const seen = await market.get(author, listing.slug);
    expect(seen.status).toBe("rejected");
    expect(seen.reviewNote).toBe("Please describe what it is for.");
    // It cannot be approved from there; the publisher has to fix it and send it again.
    expect((await failure(market.approve(staff, listing.id))).code).toBe(
      "conflict",
    );
  });

  test("an edit goes back for review, so an approved listing cannot be swapped for another", async () => {
    const author = await publisher("author");
    const staff = await person("staff", "admin");
    const stranger = await person("stranger");
    const original = await coworker(author);
    const listing = await market.share(author, shareInput(original.id));
    await market.approve(staff, listing.id);
    expect((await market.get(stranger, listing.slug)).version).toBe(1);

    const edited = await market.update(author, listing.id, {
      ...shareInput(original.id),
      title: "A better title",
    });
    expect(edited.status).toBe("pending");
    expect(edited.version).toBe(2);
    expect((await failure(market.get(stranger, listing.slug))).code).toBe(
      "not_found",
    );
    await market.approve(staff, listing.id);
    expect((await market.get(stranger, listing.slug)).title).toBe(
      "A better title",
    );
  });

  test("an edit is checked as strictly as the first time", async () => {
    const author = await publisher("author");
    const original = await coworker(author);
    const listing = await market.share(author, shareInput(original.id));
    const refusal = await failure(
      market.update(author, listing.id, {
        ...shareInput(original.id),
        description: "password: hunter2hunter2",
      }),
    );
    expect(refusal.code).toBe("unclean");
  });

  test("staff can take a listing down; it cannot be edited back, and the reason is shown to its owner", async () => {
    const author = await publisher("author");
    const staff = await person("staff", "admin");
    const original = await coworker(author);
    const listing = await market.share(author, shareInput(original.id));
    await market.approve(staff, listing.id);
    await market.remove(staff, listing.id, "Copied from another publisher.");

    const seen = await market.get(author, listing.slug);
    expect(seen.status).toBe("removed");
    expect(seen.reviewNote).toBe("Copied from another publisher.");
    expect(
      (
        await failure(
          market.update(author, listing.id, shareInput(original.id)),
        )
      ).code,
    ).toBe("forbidden");
    expect((await failure(market.withdraw(author, listing.id))).code).toBe(
      "forbidden",
    );
    expect(
      (await failure(market.get(await person("stranger"), listing.slug))).code,
    ).toBe("not_found");
  });

  test("approval refuses text that has since become recognisable as a secret", async () => {
    const author = await publisher("author");
    const staff = await person("staff", "admin");
    const original = await coworker(author);
    const listing = await market.share(author, shareInput(original.id));
    // Simulates a pattern we learned about after the listing was accepted.
    await database
      .update(marketplaceListings)
      .set({ description: "key: AKIAABCDEFGHIJKLMNOP" })
      .where(eq(marketplaceListings.id, listing.id));
    const refusal = await failure(market.approve(staff, listing.id));
    expect(refusal.code).toBe("unclean");
  });

  test("the review queue lists what waits, oldest first, and pages", async () => {
    const author = await publisher("author");
    const staff = await person("staff", "admin");
    const original = await coworker(author);
    const made3 = [];
    for (let i = 0; i < 3; i += 1) {
      made3.push(
        await market.share(
          author,
          shareInput(original.id, { title: `Queue ${i}` }),
        ),
      );
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await market.pending(staff, {
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...page.listings.map((l) => l.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    for (const listing of made3) expect(seen).toContain(listing.id);
    expect(new Set(seen).size).toBe(seen.length);
  });
});

describe("ownership", () => {
  test("only the account that shared a listing can change or withdraw it", async () => {
    const author = await publisher("author");
    const intruder = await publisher("intruder");
    const original = await coworker(author);
    const own = await coworker(intruder);
    const listing = await market.share(author, shareInput(original.id));
    expect(
      (await failure(market.update(intruder, listing.id, shareInput(own.id))))
        .code,
    ).toBe("not_found");
    expect((await failure(market.withdraw(intruder, listing.id))).code).toBe(
      "not_found",
    );
    await market.withdraw(author, listing.id);
    expect((await failure(market.get(author, listing.slug))).code).toBe(
      "not_found",
    );
  });

  test("an official listing cannot be edited or withdrawn through the sharing calls", async () => {
    const author = await publisher("author");
    const original = await coworker(author);
    const official = await market.get(author, "research-analyst");
    expect(
      (
        await failure(
          market.update(author, official.id, shareInput(original.id)),
        )
      ).code,
    ).toBe("not_found");
    expect((await failure(market.withdraw(author, official.id))).code).toBe(
      "not_found",
    );
  });

  test("a person's listings are theirs alone", async () => {
    const author = await publisher("author");
    const other = await publisher("other");
    const original = await coworker(author);
    await market.share(author, shareInput(original.id));
    expect((await market.mine(author)).listings).toHaveLength(1);
    expect((await market.mine(other)).listings).toHaveLength(0);
    expect((await market.mine(await person("none"))).publisher).toBeNull();
  });
});

describe("reports", () => {
  async function published() {
    const author = await publisher("author");
    const staff = await person("staff", "admin");
    const original = await coworker(author);
    const listing = await market.share(author, shareInput(original.id));
    await market.approve(staff, listing.id);
    return { author, staff, listing };
  }

  test("one person can report a listing once", async () => {
    const { listing } = await published();
    const reporter = await person("reporter");
    await market.report(reporter, listing.slug, {
      reason: "spam",
      details: "Looks like an advert.",
    });
    const again = await failure(
      market.report(reporter, listing.slug, { reason: "harmful", details: "" }),
    );
    expect(again.code).toBe("conflict");
    const reports = await database
      .select()
      .from(marketplaceReports)
      .where(eq(marketplaceReports.listingId, listing.id));
    expect(reports).toHaveLength(1);
  });

  test("a report needs a reason from the list and cannot be filed against yourself", async () => {
    const { listing, author } = await published();
    const reporter = await person("reporter");
    expect(
      (
        await failure(
          market.report(reporter, listing.slug, {
            reason: "boring",
            details: "",
          }),
        )
      ).code,
    ).toBe("invalid");
    expect(
      (
        await failure(
          market.report(author, listing.slug, { reason: "spam", details: "" }),
        )
      ).code,
    ).toBe("forbidden");
    expect(
      (
        await failure(
          market.report(reporter, listing.slug, {
            reason: "spam",
            details: "x".repeat(LIMITS.reportDetails + 1),
          }),
        )
      ).code,
    ).toBe("invalid");
  });

  test("only a published shared listing can be reported", async () => {
    const reporter = await person("reporter");
    const author = await publisher("author");
    const original = await coworker(author);
    const pending = await market.share(author, shareInput(original.id));
    expect(
      (
        await failure(
          market.report(reporter, pending.slug, {
            reason: "spam",
            details: "",
          }),
        )
      ).code,
    ).toBe("not_found");
    expect(
      (
        await failure(
          market.report(reporter, "research-analyst", {
            reason: "spam",
            details: "",
          }),
        )
      ).code,
    ).toBe("not_found");
  });

  test("staff see open reports, can dismiss one, and taking a listing down settles the rest", async () => {
    const { listing, staff } = await published();
    const a = await person("a");
    const b = await person("b");
    await market.report(a, listing.slug, { reason: "spam", details: "one" });
    await market.report(b, listing.slug, { reason: "copied", details: "two" });

    const open = await market.reports(staff, { limit: 60 });
    const ours = open.reports.filter((r) => r.listing.id === listing.id);
    expect(ours.map((r) => r.reason).sort()).toEqual(["copied", "spam"]);
    expect(ours[0]?.listing.title).toBe("Careful analyst");

    await market.dismissReport(staff, ours[0]?.id as string);
    expect(
      (await failure(market.dismissReport(staff, ours[0]?.id as string))).code,
    ).toBe("not_found");

    await market.remove(staff, listing.id, "Reported and confirmed.");
    const after = await market.reports(staff, { limit: 60 });
    expect(after.reports.filter((r) => r.listing.id === listing.id)).toEqual(
      [],
    );
    const settled = await database
      .select({ status: marketplaceReports.status })
      .from(marketplaceReports)
      .where(eq(marketplaceReports.listingId, listing.id));
    expect(settled.map((r) => r.status).sort()).toEqual([
      "actioned",
      "dismissed",
    ]);
  });
});

describe("browsing", () => {
  test("filters by kind, category and words, treats % and _ as plain characters", async () => {
    const author = await publisher("author");
    const staff = await person("staff", "admin");
    const viewer = await person("viewer");
    const original = await coworker(author);
    const tag = randomUUID().slice(0, 8);
    const listing = await market.share(
      author,
      shareInput(original.id, {
        title: `Ledger ${tag}`,
        summary: "Counts 100% of the invoices.",
        category: "finance",
        tags: [`tag-${tag}`],
      }),
    );
    await market.approve(staff, listing.id);

    const byWord = await market.browse(viewer, { q: `ledger ${tag}` });
    expect(byWord.listings.map((l) => l.id)).toEqual([listing.id]);
    const byTag = await market.browse(viewer, { q: `tag-${tag}` });
    expect(byTag.listings.map((l) => l.id)).toEqual([listing.id]);
    // A typed % or _ means itself: "100%" is found, and "1_0%" (which would match it as a wildcard)
    // is not.
    const byPercent = await market.browse(viewer, { q: `100% ${tag}` });
    expect(byPercent.listings.map((l) => l.id)).toEqual([listing.id]);
    const byUnderscore = await market.browse(viewer, { q: `1_0% ${tag}` });
    expect(byUnderscore.listings).toEqual([]);
    const wildcard = await market.browse(viewer, { q: "%" });
    expect(
      wildcard.listings.every((l) =>
        /%/.test(l.title + l.summary + l.tags.join(" ")),
      ),
    ).toBe(true);
    expect(
      (await market.browse(viewer, { q: tag, category: "finance" })).listings,
    ).toHaveLength(1);
    expect(
      (await market.browse(viewer, { q: tag, category: "writing" })).listings,
    ).toHaveLength(0);
    expect(
      (await market.browse(viewer, { q: tag, kind: "official" })).listings,
    ).toHaveLength(0);
    expect(
      (await market.browse(viewer, { q: tag, kind: "shared" })).listings,
    ).toHaveLength(1);
  });

  test("pages without repeating or dropping a listing", async () => {
    const viewer = await person("viewer");
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await market.browse(viewer, {
        kind: "official",
        limit: 3,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...page.listings.map((l) => l.slug));
      cursor = page.nextCursor ?? undefined;
      pages += 1;
    } while (cursor && pages < 10);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.sort()).toEqual(OFFICIAL_LISTINGS.map((l) => l.slug).sort());
    expect(pages).toBe(Math.ceil(OFFICIAL_LISTINGS.length / 3));
  });

  test("a bad cursor is a refusal, not a crash", async () => {
    const viewer = await person("viewer");
    const refusal = await failure(market.browse(viewer, { cursor: "garbage" }));
    expect(refusal.code).toBe("invalid");
  });

  test("the publisher page lists what that publisher has published, and nothing else", async () => {
    const author = await publisher("author");
    const staff = await person("staff", "admin");
    const original = await coworker(author);
    const approved = await market.share(
      author,
      shareInput(original.id, { title: "Approved one" }),
    );
    await market.approve(staff, approved.id);
    await market.share(
      author,
      shareInput(original.id, { title: "Still waiting" }),
    );
    const page = await market.publisherPage(approved.publisher.id);
    expect(page.listings.map((l) => l.title)).toEqual(["Approved one"]);
    expect(page.publisher.official).toBe(false);
    expect((await failure(market.publisherPage(randomUUID()))).code).toBe(
      "not_found",
    );
  });
});

describe("accounts", () => {
  test("a listing goes when its account is deleted", async () => {
    const author = await publisher("author");
    const original = await coworker(author);
    const listing = await market.share(author, shareInput(original.id));
    const tenantId = await accounts.tenantIdForUser(author.id);
    await database.delete(tenants).where(eq(tenants.id, tenantId as string));
    const left = await database
      .select({ id: marketplaceListings.id })
      .from(marketplaceListings)
      .where(inArray(marketplaceListings.id, [listing.id]));
    expect(left).toEqual([]);
    const publishers = await database
      .select({ id: marketplacePublishers.id })
      .from(marketplacePublishers)
      .where(eq(marketplacePublishers.id, listing.publisher.id));
    expect(publishers).toEqual([]);
  });
});

describe("a digital employee installed from a role", () => {
  function storeWithSkills() {
    const calls = { installed: [] as string[], granted: [] as string[] };
    const store = createMarketplaceStore(database, {
      accounts,
      profiles,
      skills: {
        install: async (input) => {
          calls.installed.push(input.slug);
          return { id: `skill-${input.slug}` };
        },
        grant: async (_kind, ref) => {
          calls.granted.push(ref);
        },
      },
    });
    return { store, calls };
  }

  async function instructionOf(agentId: string) {
    const [row] = await database
      .select({ persona: agentProfiles.persona })
      .from(agentProfiles)
      .where(eq(agentProfiles.agentId, agentId));
    return row?.persona ?? null;
  }

  /** What the employee is told, whichever kind it runs as: a built-in's prompt, or a Bot's standing role. */
  function instructionLoaded(
    loaded: Awaited<ReturnType<ReturnType<typeof createRuntimeAgentLoader>>>,
    id: string,
  ): string {
    const agent = loaded.find((candidate) => candidate.id === id);
    if (!agent) return "";
    if ("standingMessage" in agent)
      return String(agent.standingMessage.content);
    return "systemPrompt" in agent ? String(agent.systemPrompt) : "";
  }

  test("knows who it is, names the company and brings its skills", async () => {
    const { store, calls } = storeWithSkills();
    const ann = await person("role-company");
    const tenantId = await accounts.ensureTenant(ann.id);
    await database
      .update(tenants)
      .set({ name: "Acme Ltd" })
      .where(eq(tenants.id, tenantId));

    const result = await store.install(ann, "marketing");
    made.agents.push(result.agentId);
    const prompt = await instructionOf(result.agentId);
    expect(prompt).toContain("You are Marketing at Acme Ltd");
    expect(prompt).toContain("marketing manager");
    expect(prompt).toContain("/marketing-plan");
    expect(prompt).toContain("never pretend I used it");
    expect(prompt.toLowerCase()).not.toMatch(/\bbots?\b/);

    const role = OFFICIAL_LISTINGS.find((l) => l.slug === "marketing")?.role;
    expect(calls.installed).toEqual(role?.skills.map((skill) => skill.slug));
    expect(calls.granted).toEqual(
      calls.installed.map((slug) => `skill-${slug}`),
    );
  });

  /*
   * The DT Lab (v0.1.14) hired Chief of Operations and Research Analyst and asked the lead to have its
   * colleague list some risks. It said it had no colleagues it could call. Its own instruction told it
   * to ask the person to bring a colleague in, ahead of the team paragraph that gives it team_ask.
   */
  test("hired as a team, the lead's instruction sends a colleague's part to the colleague", async () => {
    const { store } = storeWithSkills();
    const ann = await person("role-team");
    const lead = await store.install(ann, "operations-coordinator");
    const analyst = await store.install(ann, "research-analyst");
    made.agents.push(lead.agentId, analyst.agentId);

    const loaded = await createRuntimeAgentLoader(database)(ann);
    const prompt = (id: string) => instructionLoaded(loaded, id);
    const said = prompt(lead.agentId);
    expect(said).toContain("Your colleagues are Research Analyst");
    expect(said).toContain("you CAN reach your colleagues");
    expect(said).toContain("team_ask");
    expect(said).toContain(TEAMWORK);
    expect(said).not.toContain("I cannot do every task alone");
    expect(prompt(analyst.agentId)).toContain(TEAMWORK);
  });

  test("installed before the teamwork line changed, it is read with the current one", async () => {
    const { store } = storeWithSkills();
    const ann = await person("role-team-legacy");
    const lead = await store.install(ann, "operations-coordinator");
    const analyst = await store.install(ann, "research-analyst");
    made.agents.push(lead.agentId, analyst.agentId);
    // What every install wrote from v0.1.10 to v0.1.14, still stored in those employees.
    const retired =
      "Teamwork: I am one digital employee among others and I cannot do every task alone. When a task needs someone else, such as a colleague, a manager, an expert or a reference, I say who and what I would ask them, and I ask you to bring them in. I never claim to have contacted anyone unless a tool shows that I did.";
    // Whichever kind it was installed as, the instruction is stored as its persona.
    const stored = (await instructionOf(lead.agentId)) ?? "";
    await database
      .update(agentProfiles)
      .set({
        persona: `${stored.replace(TEAMWORK, retired)}\n\nAlways copy in the finance lead.`,
      })
      .where(eq(agentProfiles.agentId, lead.agentId));

    const loaded = await createRuntimeAgentLoader(database)(ann);
    const said = instructionLoaded(loaded, lead.agentId);
    expect(said).not.toContain("I cannot do every task alone");
    expect(said).toContain(TEAMWORK);
    // What the person added to it is theirs, and stays.
    expect(said).toContain("Always copy in the finance lead.");
  });

  test("hired with the language line the approved rule replaced, it is read without it", async () => {
    const { store } = storeWithSkills();
    const ann = await person("role-language-legacy");
    const sales = await store.install(ann, "sales");
    made.agents.push(sales.agentId);
    // What every install wrote from v0.1.11 to v0.1.15, still stored in those employees.
    const retired =
      "Language: reply in the language the person writes to you in. You work in Greek, English and Arabic; when you translate or write in one of them, keep names, numbers, dates and legal terms exact. If you cannot tell which language to use, ask in one short line.";
    const stored = (await instructionOf(sales.agentId)) ?? "";
    await database
      .update(agentProfiles)
      .set({
        persona: `${stored}\n\n${retired}\n\nAlways copy in the finance lead.`,
      })
      .where(eq(agentProfiles.agentId, sales.agentId));

    const loaded = await createRuntimeAgentLoader(database)(ann);
    const said = instructionLoaded(loaded, sales.agentId);
    expect(said).not.toContain("ask in one short line");
    expect(said).toContain("Always copy in the finance lead.");
  });

  test("does not call an email address a company", async () => {
    const { store } = storeWithSkills();
    const ann = await person("role-email");
    const tenantId = await accounts.ensureTenant(ann.id);
    await database
      .update(tenants)
      .set({ name: "ann@example.com" })
      .where(eq(tenants.id, tenantId));
    const result = await store.install(ann, "sales");
    made.agents.push(result.agentId);
    const prompt = await instructionOf(result.agentId);
    expect(prompt).toContain("You are Sales, the sales lead");
    expect(prompt).not.toContain("ann@example.com");
  });

  test("keeps its instruction when only its name is edited", async () => {
    const { store } = storeWithSkills();
    const ann = await person("role-edit");
    const result = await store.install(ann, "accounting");
    made.agents.push(result.agentId);
    const before = await instructionOf(result.agentId);
    const profile = await profiles.get(ann, result.agentId);
    await profiles.update(ann, result.agentId, {
      name: "Renamed",
      title: profile?.title ?? "",
      roleDescription: profile?.roleDescription ?? "",
      visibility: "private",
    });
    expect(await instructionOf(result.agentId)).toBe(before);
    // Changing the role description itself replaces it: the person's own words are what runs.
    await profiles.update(ann, result.agentId, {
      name: "Renamed",
      title: profile?.title ?? "",
      roleDescription: "Something else entirely.",
      visibility: "private",
    });
    expect(await instructionOf(result.agentId)).toBeNull();
  });
});
