import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createApp } from "../src/app";
import { createAuditStore } from "../src/audit";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import { auditEvents, termsAcceptances, users } from "../src/db/schema";
import { createTermsStore } from "../src/people/terms";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";

/**
 * Accepting the terms of service: which version, by whom, when, and only ever the one in force.
 *
 * The rules worth pinning: an acceptance is of the version the person was shown (a changed text is
 * refused, not recorded), it is recorded once, staff are never asked, a new version asks again, and
 * the deployment decides whether acceptance is required at all.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const ann = `user_ann_${suite}`;
const staff = `user_staff_${suite}`;

beforeAll(async () => {
  for (const id of [ann, staff]) {
    await database
      .insert(users)
      .values({ id, email: `${id}@example.test`, name: id })
      .onConflictDoNothing();
  }
});
afterAll(async () => {
  await database.delete(users).where(inArray(users.id, [ann, staff]));
});

const V1 = `2026-11-01-${suite}`;
const V2 = `2027-02-01-${suite}`;

describe("the store", () => {
  const store = createTermsStore(database, { version: V1, required: true });

  test("starts with nothing accepted, and asks a customer for it", async () => {
    expect(await store.status(ann, false)).toEqual({
      version: V1,
      required: true,
      acceptedAt: null,
    });
  });

  test("never asks staff", async () => {
    expect((await store.status(staff, true)).required).toBe(false);
  });

  test("does not ask anyone when the deployment does not require it", async () => {
    const off = createTermsStore(database, { version: V1, required: false });
    expect((await off.status(ann, false)).required).toBe(false);
  });

  test("records an acceptance of the version in force, once", async () => {
    const first = new Date("2026-11-02T10:00:00.000Z");
    expect(await store.accept(ann, V1, first)).toBe(true);
    // Again later: still the first time. When they agreed is one fact.
    expect(
      await store.accept(ann, V1, new Date("2026-12-01T10:00:00.000Z")),
    ).toBe(true);

    expect((await store.status(ann, false)).acceptedAt).toBe(
      first.toISOString(),
    );
    expect(await store.history(ann)).toEqual([
      { version: V1, acceptedAt: first.toISOString() },
    ]);
  });

  test("refuses, and writes nothing, for a version that is not in force", async () => {
    expect(await store.accept(staff, `2020-01-01-${suite}`)).toBe(false);
    expect(await store.history(staff)).toEqual([]);
  });

  test("a new version asks again, and the earlier acceptance stays as the record", async () => {
    const next = createTermsStore(database, { version: V2, required: true });

    expect((await next.status(ann, false)).acceptedAt).toBeNull();
    await next.accept(ann, V2, new Date("2027-02-02T09:00:00.000Z"));

    expect((await next.history(ann)).map((row) => row.version)).toEqual([
      V1,
      V2,
    ]);
  });

  test("goes with the person", async () => {
    const gone = `user_gone_${suite}`;
    await database
      .insert(users)
      .values({ id: gone, email: `${gone}@example.test`, name: gone });
    await store.accept(gone, V1);
    await database.delete(users).where(eq(users.id, gone));

    expect(
      await database
        .select()
        .from(termsAcceptances)
        .where(eq(termsAcceptances.userId, gone)),
    ).toEqual([]);
  });
});

describe("the routes", () => {
  const asPerson = (id: string, role: "admin" | "user") => {
    const store = createTermsStore(database, { version: V1, required: true });
    const auditStore = createAuditStore(database);
    // createApp takes its stores by position: `auditStore` is the 13th and `overview` the 40th and `push` the 41st, `approvals` the 42nd, `memories` the 43rd and `ownsConversation` the 44th, the last (`terms` is the 39th).
    // Every parameter from the 4th on is optional, so a miscount type-checks and silently does nothing;
    // the length is asserted so that adding a parameter makes this fail where it is wrong.
    expect(createApp.length).toBe(44);
    const none = (count: number) => Array.from({ length: count }) as never[];
    const app = createApp(
      loadConfig(testEnvironment()),
      {
        handler: () => new Response(null, { status: 204 }),
        api: {
          getSession: async () => ({
            user: { id, email: `${id}@example.test`, name: id, image: null },
          }),
        },
      } as never,
      { rolesForUser: async () => [role] },
      ...none(9),
      auditStore,
      ...none(25),
      store,
    );
    const post = (body: unknown) =>
      app.request("http://openbot.local/api/me/terms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const me = async () =>
      (
        (await (await app.request("http://openbot.local/api/me")).json()) as {
          user: {
            terms: {
              version: string;
              required: boolean;
              acceptedAt: string | null;
            } | null;
          };
        }
      ).user.terms;
    return { post, me };
  };

  test("/api/me says which version is in force and whether this person has accepted it", async () => {
    const route = asPerson(`user_route_${suite}`, "user").me;
    // No row for this person: it would not be created by asking.
    expect((await route())?.version).toBe(V1);
  });

  test("accepting records it, answers with the new standing, and leaves one audit row", async () => {
    const id = `user_accepts_${suite}`;
    await database
      .insert(users)
      .values({ id, email: `${id}@example.test`, name: id });
    const person = asPerson(id, "user");

    expect((await person.me())?.acceptedAt).toBeNull();
    const accepted = await person.post({ version: V1 });

    expect(accepted.status).toBe(200);
    const body = (await accepted.json()) as {
      terms: { acceptedAt: string | null };
    };
    expect(body.terms.acceptedAt).not.toBeNull();
    expect((await person.me())?.acceptedAt).toBe(body.terms.acceptedAt);

    // Twice is still one row in the trail.
    await person.post({ version: V1 });
    const rows = await database
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.actorUserId, id));
    expect(
      rows.filter((row) => row.eventType === "terms.accepted"),
    ).toHaveLength(1);
    expect(
      rows.find((row) => row.eventType === "terms.accepted")?.payload,
    ).toEqual({ version: V1 });
    await database.delete(users).where(eq(users.id, id));
  });

  test("a version that has changed since the person opened it is refused with the one in force", async () => {
    const id = `user_stale_${suite}`;
    await database
      .insert(users)
      .values({ id, email: `${id}@example.test`, name: id });
    const person = asPerson(id, "user");

    const refused = await person.post({ version: `old-${suite}` });

    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { version: string }).version).toBe(V1);
    expect((await person.me())?.acceptedAt).toBeNull();
    await database.delete(users).where(eq(users.id, id));
  });

  test("a request that does not name a version is refused", async () => {
    const person = asPerson(ann, "user");
    for (const body of [{}, { version: 5 }, { version: "" }, null]) {
      expect((await person.post(body)).status).toBe(400);
    }
  });

  test("staff are told it is not required of them", async () => {
    const person = asPerson(staff, "admin");
    expect((await person.me())?.required).toBe(false);
  });
});

describe("the setting", () => {
  test("is off unless the deployment says required, and anything else stops it starting", () => {
    expect(loadConfig(testEnvironment()).termsAcceptance).toBe("off");
    expect(
      loadConfig(testEnvironment({ TERMS_ACCEPTANCE: " Required " }))
        .termsAcceptance,
    ).toBe("required");
    expect(
      loadConfig(testEnvironment({ TERMS_ACCEPTANCE: "off" })).termsAcceptance,
    ).toBe("off");
    expect(() =>
      loadConfig(testEnvironment({ TERMS_ACCEPTANCE: "yes" })),
    ).toThrow(/TERMS_ACCEPTANCE/);
  });
});
