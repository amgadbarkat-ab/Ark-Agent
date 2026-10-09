import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import { createAccountStore } from "../src/accounts/store";
import { createDatabase } from "../src/db/client";
import {
  cloudAccounts,
  cloudCharges,
  cloudRates,
  tenantMemberships,
  tenants,
  users,
} from "../src/db/schema";
import { testDatabaseUrl } from "./support/database";

/**
 * A burst of requests at a process that has just started must all be answered.
 *
 * Bun's SQL pool loses queries when more of them are asked for at once than it has connections and the
 * statements have not been prepared yet: some never come back, with no error, and the connection they
 * were on is never freed. In a server that is a handful of requests hanging forever, then a process
 * answering nothing while `/health` (which does not touch the database) still says it is fine. The
 * client is therefore made without named prepared statements (db/client.ts); this is the shape of
 * request that exposed it, thirty at a time against a pool of ten, and it fails on the old client.
 *
 * It uses the default pool on purpose. Every other test pins the pool to two connections.
 */

const database = createDatabase(testDatabaseUrl());
const userId = `burst-${randomUUID().slice(0, 8)}`;
let tenantId = "";

beforeAll(async () => {
  await database
    .insert(users)
    .values({ id: userId, name: userId, email: `${userId}@example.test` });
  tenantId = await createAccountStore(database, {
    billingMode: "subscriptions",
  }).ensureTenant(userId);
});
afterAll(async () => {
  await database.delete(users).where(eq(users.id, userId));
  await database.$client.close();
});

const BURST = 30;
const GIVE_UP_MS = 6000;

/** One request's worth of work: find the account, then ask three things about it at once. */
async function request() {
  await database
    .select({ tenantId: tenantMemberships.tenantId })
    .from(tenantMemberships)
    .where(eq(tenantMemberships.userId, userId))
    .orderBy(asc(tenantMemberships.createdAt))
    .limit(1);
  await Promise.all([
    database
      .select({ rates: cloudRates.rates })
      .from(cloudRates)
      .where(eq(cloudRates.id, "current"))
      .limit(1),
    database
      .select()
      .from(cloudAccounts)
      .where(eq(cloudAccounts.tenantId, tenantId))
      .limit(1),
    database
      .select({
        id: cloudCharges.id,
        tenantName: tenants.name,
        period: cloudCharges.period,
        usage: cloudCharges.usage,
        costCents: cloudCharges.costCents,
        updatedAt: cloudCharges.updatedAt,
      })
      .from(cloudCharges)
      .innerJoin(tenants, eq(tenants.id, cloudCharges.tenantId))
      .where(and(eq(cloudCharges.tenantId, tenantId)))
      .orderBy(desc(cloudCharges.period), desc(cloudCharges.updatedAt))
      .limit(12),
  ]);
}

test("thirty requests at once against a cold pool of ten are all answered", async () => {
  const outcomes = await Promise.all(
    Array.from({ length: BURST }, () =>
      Promise.race([
        request().then(
          () => "answered",
          () => "failed",
        ),
        new Promise<string>((resolve) =>
          setTimeout(() => resolve("hung"), GIVE_UP_MS),
        ),
      ]),
    ),
  );

  expect(outcomes.filter((outcome) => outcome === "hung")).toEqual([]);
  expect(outcomes.filter((outcome) => outcome === "failed")).toEqual([]);
}, 20_000);

test("and so are five hundred, which is more than any pool is ever sized for", async () => {
  const outcomes = await Promise.all(
    Array.from({ length: 500 }, () =>
      Promise.race([
        request().then(
          () => "answered",
          () => "failed",
        ),
        new Promise<string>((resolve) =>
          setTimeout(() => resolve("hung"), GIVE_UP_MS),
        ),
      ]),
    ),
  );

  expect(outcomes.every((outcome) => outcome === "answered")).toBe(true);
}, 30_000);

test("values still reach the database as the type the column has, with statements sent unprepared", async () => {
  // Without a prepared statement the driver is not told what type a parameter is, so an object, a date
  // and a number each have to arrive in a form the database reads unaided.
  const id = `types-${randomUUID().slice(0, 8)}`;
  await database.insert(users).values({
    id,
    name: id,
    email: `${id}@example.test`,
    preferences: { nested: { list: [1, 2, 3] }, flag: true },
  });
  const [row] = await database
    .select({ preferences: users.preferences })
    .from(users)
    .where(eq(users.id, id));
  await database.delete(users).where(eq(users.id, id));

  expect(row?.preferences).toEqual({ nested: { list: [1, 2, 3] }, flag: true });
});
