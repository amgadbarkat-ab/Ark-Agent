import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createProviderTrust } from "../src/auth/provider-trust";
import { applyConfiguredAdmin } from "../src/auth/roles";
import { createDatabase } from "../src/db/client";
import { accounts, ssoProviders, userRoles, users } from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Who may be made an administrator by `INITIAL_ADMIN_EMAILS`.
 *
 * The role is granted by address. A multi-tenant Microsoft sign-in takes the address from a claim the
 * signing-in tenant's own administrator writes, so anybody who can make a directory could sign in as
 * `ceo@yourcompany.com` and be given the role. These hold that shut, on a real database, and hold
 * open the providers that can vouch.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const made = { users: [] as string[], sso: [] as string[] };
const ADMIN = "boss@ark.example";

async function person(options: {
  email?: string;
  verified?: boolean;
  providers?: string[];
}) {
  const id = `trust-${randomUUID()}`;
  await database.insert(users).values({
    id,
    email: options.email ?? `${id}@example.com`,
    emailVerified: options.verified ?? false,
  });
  made.users.push(id);
  for (const providerId of options.providers ?? []) {
    await database.insert(accounts).values({
      id: `acc-${randomUUID()}`,
      accountId: `ext-${randomUUID()}`,
      providerId,
      userId: id,
    });
  }
  return id;
}

afterEach(async () => {
  for (const id of made.users.splice(0))
    await database.delete(users).where(eq(users.id, id));
  for (const id of made.sso.splice(0))
    await database.delete(ssoProviders).where(eq(ssoProviders.id, id));
});
afterAll(async () => {
  await database.$client.close();
});

const directory = createProviderTrust(database, {
  microsoft: { tenantId: "8f2c1e40-0000-0000-0000-000000000000" },
});
const multiTenant = (tenantId: string) =>
  createProviderTrust(database, { microsoft: { tenantId } });

describe("which sign-ins can vouch for an address", () => {
  test("nobody who has signed in through nothing", async () => {
    expect(await directory.canVouchFor(await person({}))).toBe(false);
    expect(await directory.canVouchFor("not-a-person")).toBe(false);
  });

  test("Microsoft, only when it is one directory of ours", async () => {
    const id = await person({ providers: ["microsoft"] });
    expect(await directory.canVouchFor(id)).toBe(true);
    for (const tenant of ["common", "organizations", "consumers", "COMMON"]) {
      expect(await multiTenant(tenant).canVouchFor(id)).toBe(false);
    }
  });

  test("Google, only when Google verified the address", async () => {
    const verified = await person({ providers: ["google"], verified: true });
    const unverified = await person({ providers: ["google"], verified: false });
    expect(await directory.canVouchFor(verified)).toBe(true);
    expect(await directory.canVouchFor(unverified)).toBe(false);
  });

  test("Okta, which is one issuer the operator chose", async () => {
    expect(
      await directory.canVouchFor(await person({ providers: ["okta"] })),
    ).toBe(true);
  });

  test("a company provider an administrator registered, and not one that was never registered", async () => {
    const registered = `acme-${randomUUID().slice(0, 8)}`;
    await database.insert(ssoProviders).values({
      id: registered,
      providerId: registered,
      issuer: "https://login.acme.example",
      domain: "acme.example",
    });
    made.sso.push(registered);
    expect(
      await directory.canVouchFor(await person({ providers: [registered] })),
    ).toBe(true);
    expect(
      await directory.canVouchFor(await person({ providers: ["made-up-idp"] })),
    ).toBe(false);
  });

  test("a person who has one way in that can vouch is vouched for, whatever else they have", async () => {
    const id = await person({
      providers: ["microsoft", "google"],
      verified: true,
    });
    expect(await multiTenant("common").canVouchFor(id)).toBe(true);
  });
});

describe("the configured administrator list", () => {
  const roleOf = async (id: string) =>
    (
      await database
        .select({ role: userRoles.role })
        .from(userRoles)
        .where(eq(userRoles.userId, id))
    ).map((row) => row.role);

  test("does not make an address an administrator when a multi-tenant directory supplied it", async () => {
    const squatter = await person({ email: ADMIN, providers: ["microsoft"] });
    const promoted = await applyConfiguredAdmin(
      database,
      squatter,
      [ADMIN],
      multiTenant("common").canVouchFor,
    );
    expect(promoted).toBe(false);
    expect(await roleOf(squatter)).not.toContain("admin");
  });

  test("does make the real one an administrator when a provider that can vouch supplied it", async () => {
    const real = await person({ email: ADMIN, providers: ["microsoft"] });
    expect(
      await applyConfiguredAdmin(
        database,
        real,
        [ADMIN],
        directory.canVouchFor,
      ),
    ).toBe(true);
    expect(await roleOf(real)).toContain("admin");
    // And a returning administrator is not "promoted" again.
    expect(
      await applyConfiguredAdmin(
        database,
        real,
        [ADMIN],
        directory.canVouchFor,
      ),
    ).toBe(false);
  });

  test("with no rule given it behaves as it always has, for a deployment with one company directory", async () => {
    const id = await person({ email: ADMIN, providers: ["microsoft"] });
    expect(await applyConfiguredAdmin(database, id, [ADMIN])).toBe(true);
  });

  test("an address not on the list is not promoted by any provider", async () => {
    const id = await person({ providers: ["okta"] });
    expect(
      await applyConfiguredAdmin(database, id, [ADMIN], directory.canVouchFor),
    ).toBe(false);
  });
});
