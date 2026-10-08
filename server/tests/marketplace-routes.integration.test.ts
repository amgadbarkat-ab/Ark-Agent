import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { count, eq } from "drizzle-orm";
import { Hono } from "hono";
import { createAccountStore } from "../src/accounts/store";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { createDatabase } from "../src/db/client";
import {
  agents,
  marketplaceInstalls,
  tenantMemberships,
  tenants,
  users,
} from "../src/db/schema";
import {
  adminMarketplaceRoutes,
  type MarketplaceAuditEvent,
  marketplaceRoutes,
} from "../src/marketplace/routes";
import { createMarketplaceStore } from "../src/marketplace/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const MANAGED = new URL("https://managed.example.test/ag-ui");
const accounts = createAccountStore(database, { billingMode: "subscriptions" });
const profiles = createAgentProfileStore(
  database,
  MANAGED,
  undefined,
  accounts,
);
const market = createMarketplaceStore(database, { accounts, profiles });
const made = { users: [] as string[], agents: [] as string[] };
const events: MarketplaceAuditEvent[] = [];

/** Who is calling is named in a header, so one app can be several people. */
const requireUser: Parameters<typeof marketplaceRoutes>[0]["requireUser"] =
  async (context, next) => {
    const as = context.req.header("x-as");
    if (!as) return context.json({ error: "Sign in" }, 401);
    const [id, role] = as.split(":");
    context.set("actor", {
      id: id as string,
      email: `${id}@example.com`,
      role: role === "admin" ? "admin" : "user",
    });
    await next();
  };
const audit = async (event: MarketplaceAuditEvent) => {
  events.push(event);
};
const app = new Hono()
  .route("/api/marketplace", marketplaceRoutes({ requireUser, market, audit }))
  .route(
    "/api/admin/marketplace",
    adminMarketplaceRoutes({ requireUser, market, audit }),
  );

async function person(role: "admin" | "user" = "user") {
  const id = `mkr-${randomUUID()}`;
  await database.insert(users).values({ id, email: `${id}@example.com` });
  made.users.push(id);
  await accounts.ensureTenant(id);
  return { id, as: `${id}:${role}` };
}

type Who = { as: string };
const call = (who: Who | null, method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(who ? { "x-as": who.as } : {}),
    },
    ...(body === undefined
      ? {}
      : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });

async function coworkerOf(
  who: { id: string },
  roleDescription = "Does analysis.",
) {
  const profile = await profiles.create({ id: who.id, role: "user" }, {
    name: `Bot ${randomUUID().slice(0, 6)}`,
    title: "Analyst",
    roleDescription,
    visibility: "private",
  } as never);
  made.agents.push(profile.id);
  return profile;
}

const listingBody = (
  agentId: string,
  overrides: Record<string, unknown> = {},
) => ({
  agentId,
  title: "Careful analyst",
  summary: "Reads figures and reports what changed.",
  category: "research",
  tags: ["analysis"],
  description: "How I set mine up.",
  confirmedNoPrivateData: false,
  ...overrides,
});

async function sharedAndApproved() {
  const author = await person();
  const staff = await person("admin");
  await call(author, "PUT", "/api/marketplace/mine/publisher", {
    displayName: `Pub ${randomUUID().slice(0, 8)}`,
  });
  const original = await coworkerOf(author);
  const created = await call(
    author,
    "POST",
    "/api/marketplace/mine/listings",
    listingBody(original.id),
  );
  const { listing } = (await created.json()) as {
    listing: { id: string; slug: string };
  };
  const approved = await call(
    staff,
    "POST",
    `/api/admin/marketplace/listings/${listing.id}/approve`,
  );
  expect(approved.status).toBe(200);
  return { author, staff, original, listing };
}

beforeAll(async () => {
  await market.syncOfficial();
});

afterEach(async () => {
  events.length = 0;
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

describe("who may ask", () => {
  test("nobody who is not signed in", async () => {
    for (const [method, path] of [
      ["GET", "/api/marketplace"],
      ["GET", "/api/marketplace/listings/research-analyst"],
      ["POST", "/api/marketplace/listings/research-analyst/install"],
      ["GET", "/api/marketplace/mine"],
      ["GET", "/api/admin/marketplace/pending"],
    ] as const) {
      expect((await call(null, method, path)).status).toBe(401);
    }
  });

  test("only staff reach the review routes", async () => {
    const ann = await person();
    for (const [method, path, body] of [
      ["GET", "/api/admin/marketplace/pending"],
      ["GET", "/api/admin/marketplace/reports"],
      ["POST", `/api/admin/marketplace/listings/${randomUUID()}/approve`],
      [
        "POST",
        `/api/admin/marketplace/listings/${randomUUID()}/reject`,
        { note: "x" },
      ],
      [
        "POST",
        `/api/admin/marketplace/listings/${randomUUID()}/remove`,
        { note: "x" },
      ],
      ["POST", `/api/admin/marketplace/reports/${randomUUID()}/dismiss`],
    ] as const) {
      expect((await call(ann, method, path, body)).status).toBe(403);
    }
  });
});

describe("there is no way to turn a shared coworker into a running one", () => {
  test("no route copies, clones, imports, exports or installs anything but an official listing", () => {
    const routes = app.routes
      .filter((route) => route.method !== "ALL")
      .map((route) => `${route.method} ${route.path}`)
      .sort();
    expect(routes).toEqual(
      [
        "GET /api/marketplace",
        "GET /api/marketplace/listings/:slug",
        "POST /api/marketplace/listings/:slug/install",
        "POST /api/marketplace/listings/:slug/report",
        "GET /api/marketplace/publishers/:id",
        "GET /api/marketplace/mine",
        "PUT /api/marketplace/mine/publisher",
        "POST /api/marketplace/mine/listings",
        "PUT /api/marketplace/mine/listings/:id",
        "DELETE /api/marketplace/mine/listings/:id",
        "GET /api/admin/marketplace/pending",
        "GET /api/admin/marketplace/reports",
        "POST /api/admin/marketplace/listings/:id/approve",
        "POST /api/admin/marketplace/listings/:id/reject",
        "POST /api/admin/marketplace/listings/:id/remove",
        "POST /api/admin/marketplace/reports/:id/dismiss",
      ].sort(),
    );
    // A new route that could produce a coworker from a listing has to be argued for here.
    expect(routes.join("\n")).not.toMatch(
      /clone|copy|import|export|duplicate|fork/i,
    );
  });

  test("installing a shared listing is refused, and nothing is created", async () => {
    const { listing } = await sharedAndApproved();
    const reader = await person();
    const before = await database.select({ total: count() }).from(agents);
    const response = await call(
      reader,
      "POST",
      `/api/marketplace/listings/${listing.slug}/install`,
    );
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: string }).error).toMatch(
      /for reading/,
    );
    expect(await database.select({ total: count() }).from(agents)).toEqual(
      before,
    );
    expect(
      await database
        .select({ total: count() })
        .from(marketplaceInstalls)
        .where(eq(marketplaceInstalls.userId, reader.id)),
    ).toEqual([{ total: 0 }]);
  });
});

describe("browsing and reading", () => {
  test("lists Ark's digital employees and filters them", async () => {
    const ann = await person();
    const all = (await (
      await call(ann, "GET", "/api/marketplace?kind=official&limit=60")
    ).json()) as { listings: Array<{ slug: string; category: string }> };
    expect(all.listings.map((l) => l.slug)).toContain("research-analyst");
    const finance = (await (
      await call(ann, "GET", "/api/marketplace?kind=official&category=finance")
    ).json()) as { listings: Array<{ slug: string }> };
    expect(finance.listings.map((l) => l.slug)).toEqual(["finance-assistant"]);
  });

  test("refuses a search it cannot understand instead of guessing", async () => {
    const ann = await person();
    for (const query of [
      "category=nonsense",
      "kind=other",
      "limit=abc",
      `q=${"x".repeat(201)}`,
      "cursor=garbage",
    ]) {
      expect((await call(ann, "GET", `/api/marketplace?${query}`)).status).toBe(
        400,
      );
    }
  });

  test("a listing page shows the instruction Ark's employee will start with", async () => {
    const ann = await person();
    const response = await call(
      ann,
      "GET",
      "/api/marketplace/listings/support-agent",
    );
    expect(response.status).toBe(200);
    const { listing } = (await response.json()) as {
      listing: {
        content: { install: { roleDescription: string } };
        mine: boolean;
      };
    };
    expect(listing.content.install.roleDescription).toContain("customers");
    expect(listing.mine).toBe(false);
  });

  test("an address that is not a listing is a plain not-found", async () => {
    const ann = await person();
    for (const slug of ["nothing-here", "UPPER", "a b", "x".repeat(200)]) {
      expect(
        (
          await call(
            ann,
            "GET",
            `/api/marketplace/listings/${encodeURIComponent(slug)}`,
          )
        ).status,
      ).toBe(404);
    }
  });
});

describe("installing", () => {
  test("puts an official digital employee in the person's account and records it", async () => {
    const ann = await person();
    const response = await call(
      ann,
      "POST",
      "/api/marketplace/listings/code-reviewer/install",
    );
    expect(response.status).toBe(201);
    const installed = (await response.json()) as {
      agentId: string;
      name: string;
    };
    made.agents.push(installed.agentId);
    expect(installed.name).toBe("Code Reviewer");
    const mine = await profiles.get(
      { id: ann.id, role: "user" },
      installed.agentId,
    );
    expect(mine?.title).toBe("Code Reviewer");
    expect(events.map((e) => e.eventType)).toContain(
      "marketplace.listing_installed",
    );
  });
});

describe("sharing", () => {
  test("a person names themselves, shares a coworker, and it waits for review", async () => {
    const author = await person();
    const named = await call(author, "PUT", "/api/marketplace/mine/publisher", {
      displayName: `Pub ${randomUUID().slice(0, 8)}`,
      bio: "I write careful agents.",
    });
    expect(named.status).toBe(200);
    const original = await coworkerOf(author);
    const created = await call(
      author,
      "POST",
      "/api/marketplace/mine/listings",
      listingBody(original.id),
    );
    expect(created.status).toBe(201);
    const { listing } = (await created.json()) as {
      listing: { status: string; slug: string; mine: boolean };
    };
    expect(listing).toMatchObject({ status: "pending", mine: true });
    expect(events.map((e) => e.eventType)).toContain(
      "marketplace.listing_submitted",
    );

    const stranger = await person();
    expect(
      (await call(stranger, "GET", `/api/marketplace/listings/${listing.slug}`))
        .status,
    ).toBe(404);
    const mine = (await (
      await call(author, "GET", "/api/marketplace/mine")
    ).json()) as {
      listings: Array<{ status: string }>;
    };
    expect(mine.listings.map((l) => l.status)).toEqual(["pending"]);
  });

  test("a secret is refused with where it was, and the secret is not in the answer", async () => {
    const author = await person();
    await call(author, "PUT", "/api/marketplace/mine/publisher", {
      displayName: `Pub ${randomUUID().slice(0, 8)}`,
    });
    const original = await coworkerOf(
      author,
      "Call the API with sk-live-abcdefghijklmnopqrstuvwxyz0123.",
    );
    const response = await call(
      author,
      "POST",
      "/api/marketplace/mine/listings",
      listingBody(original.id),
    );
    expect(response.status).toBe(422);
    const raw = await response.text();
    expect(raw).not.toContain("abcdefghijkl");
    const body = JSON.parse(raw) as {
      error: string;
      findings: Array<{
        kind: string;
        field: string;
        line: number;
        secret: boolean;
      }>;
    };
    expect(body.findings[0]).toMatchObject({
      kind: "api_key",
      field: "Role description",
      line: 1,
      secret: true,
    });
  });

  test("something that is not a complete listing is a 400, and so is a body that is not JSON", async () => {
    const author = await person();
    expect(
      (
        await call(author, "POST", "/api/marketplace/mine/listings", {
          title: "x",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(
          author,
          "POST",
          "/api/marketplace/mine/listings",
          "{not json",
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await call(author, "POST", "/api/marketplace/mine/listings", {
          ...listingBody("a"),
          unexpected: true,
        })
      ).status,
    ).toBe(400);
    const huge = "x".repeat(70_000);
    expect(
      (
        await call(author, "PUT", "/api/marketplace/mine/publisher", {
          displayName: "n",
          bio: huge,
        })
      ).status,
    ).toBe(400);
  });

  test("a listing can be edited, which sends it back to review, and withdrawn", async () => {
    const { author, staff, original, listing } = await sharedAndApproved();
    const edited = await call(
      author,
      "PUT",
      `/api/marketplace/mine/listings/${listing.id}`,
      listingBody(original.id, { title: "Renamed" }),
    );
    expect(edited.status).toBe(200);
    const body = (await edited.json()) as {
      listing: { status: string; version: number };
    };
    expect(body.listing).toMatchObject({ status: "pending", version: 2 });
    expect(
      (
        (await call(
          staff,
          "GET",
          "/api/admin/marketplace/pending?limit=60",
        ).then((r) => r.json())) as {
          listings: Array<{ id: string }>;
        }
      ).listings.map((l) => l.id),
    ).toContain(listing.id);

    const stranger = await person();
    expect(
      (
        await call(
          stranger,
          "DELETE",
          `/api/marketplace/mine/listings/${listing.id}`,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await call(
          author,
          "DELETE",
          `/api/marketplace/mine/listings/${listing.id}`,
        )
      ).status,
    ).toBe(200);
    expect(
      (await call(author, "GET", `/api/marketplace/listings/${listing.slug}`))
        .status,
    ).toBe(404);
    expect(events.map((e) => e.eventType)).toContain(
      "marketplace.listing_withdrawn",
    );
  });
});

describe("review and reports", () => {
  test("staff approve, reject with a reason, and remove; each is on the record", async () => {
    const author = await person();
    const staff = await person("admin");
    await call(author, "PUT", "/api/marketplace/mine/publisher", {
      displayName: `Pub ${randomUUID().slice(0, 8)}`,
    });
    const original = await coworkerOf(author);
    const make = async (title: string) =>
      (
        (await (
          await call(
            author,
            "POST",
            "/api/marketplace/mine/listings",
            listingBody(original.id, { title }),
          )
        ).json()) as { listing: { id: string; slug: string } }
      ).listing;
    const a = await make("Approve me");
    const b = await make("Reject me");

    expect(
      (
        await call(
          staff,
          "POST",
          `/api/admin/marketplace/listings/${b.id}/reject`,
          { note: "" },
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await call(
          staff,
          "POST",
          `/api/admin/marketplace/listings/${b.id}/reject`,
          { note: "Too vague." },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await call(
          staff,
          "POST",
          `/api/admin/marketplace/listings/${a.id}/approve`,
        )
      ).status,
    ).toBe(200);
    // Approving something that is no longer waiting is a conflict, not a second approval.
    expect(
      (
        await call(
          staff,
          "POST",
          `/api/admin/marketplace/listings/${a.id}/approve`,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await call(
          staff,
          "POST",
          `/api/admin/marketplace/listings/${a.id}/remove`,
          { note: "Taken down." },
        )
      ).status,
    ).toBe(200);

    const mine = (await (
      await call(author, "GET", "/api/marketplace/mine")
    ).json()) as {
      listings: Array<{
        title: string;
        status: string;
        reviewNote: string | null;
      }>;
    };
    expect(mine.listings.find((l) => l.title === "Reject me")).toMatchObject({
      status: "rejected",
      reviewNote: "Too vague.",
    });
    expect(mine.listings.find((l) => l.title === "Approve me")).toMatchObject({
      status: "removed",
    });
    expect(events.map((e) => e.eventType)).toEqual(
      expect.arrayContaining([
        "marketplace.listing_approved",
        "marketplace.listing_rejected",
        "marketplace.listing_removed",
      ]),
    );
    const removal = events.find(
      (e) => e.eventType === "marketplace.listing_removed",
    );
    expect(removal?.payload).toEqual({ note: "Taken down." });
    expect(removal?.actorUserId).toBe(staff.id);
  });

  test("a reader reports once; staff see it and dismiss it", async () => {
    const { listing, staff } = await sharedAndApproved();
    const reader = await person();
    const path = `/api/marketplace/listings/${listing.slug}/report`;
    expect(
      (await call(reader, "POST", path, { reason: "nonsense" })).status,
    ).toBe(400);
    expect(
      (await call(reader, "POST", path, { reason: "spam", details: "Advert." }))
        .status,
    ).toBe(201);
    expect((await call(reader, "POST", path, { reason: "spam" })).status).toBe(
      409,
    );

    const open = (await (
      await call(staff, "GET", "/api/admin/marketplace/reports?limit=60")
    ).json()) as {
      reports: Array<{ id: string; reason: string; listing: { id: string } }>;
    };
    const ours = open.reports.filter((r) => r.listing.id === listing.id);
    expect(ours).toHaveLength(1);
    expect(
      (
        await call(
          staff,
          "POST",
          `/api/admin/marketplace/reports/${ours[0]?.id}/dismiss`,
        )
      ).status,
    ).toBe(200);
    expect(events.map((e) => e.eventType)).toEqual(
      expect.arrayContaining([
        "marketplace.report_filed",
        "marketplace.report_dismissed",
      ]),
    );
  });
});
