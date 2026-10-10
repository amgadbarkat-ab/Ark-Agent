import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
  decryptSecret,
  encryptionKeyId,
  encryptSecret,
  useRetiredEncryptionKeys,
} from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  credentials,
  modelConnections,
  ssoProviders,
  users,
} from "../src/db/schema";
import { resealAll, sealedColumns } from "../src/rekey";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Moving every sealed value from a retired key to the current one, against a real database.
 *
 * The rows these tests make sit among whatever else the shared test database holds, sealed under keys
 * this file has never seen, so assertions are about THESE rows by id, never about totals.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);

const OLD = Buffer.alloc(32, 11).toString("base64");
const NEW = Buffer.alloc(32, 12).toString("base64");
const LOST = Buffer.alloc(32, 13).toString("base64");

const made = {
  credentials: [] as string[],
  users: [] as string[],
  sso: [] as string[],
};

afterEach(async () => {
  useRetiredEncryptionKeys([]);
  if (made.credentials.length > 0)
    await database
      .delete(credentials)
      .where(inArray(credentials.id, made.credentials.splice(0)));
  if (made.users.length > 0)
    await database.delete(users).where(inArray(users.id, made.users.splice(0)));
  if (made.sso.length > 0)
    await database
      .delete(ssoProviders)
      .where(inArray(ssoProviders.id, made.sso.splice(0)));
});
afterAll(async () => {
  await database.$client.close();
});

async function storedCredential(sealed: string) {
  const [row] = await database
    .insert(credentials)
    .values({
      kind: "mcp",
      provider: `rotation-${randomUUID()}`,
      encryptedValue: sealed,
      keyId: `key-${randomUUID()}`,
      metadata: {},
    })
    .returning({ id: credentials.id });
  made.credentials.push(row?.id as string);
  return row?.id as string;
}

async function credentialValue(id: string) {
  const [row] = await database
    .select({ value: credentials.encryptedValue })
    .from(credentials)
    .where(eq(credentials.id, id));
  return row?.value as string;
}

function mine(
  reports: Awaited<ReturnType<typeof resealAll>>,
  table: string,
  ids: string[],
) {
  const report = reports.find((r) => r.table === table && r.column !== "");
  return {
    report,
    unreadableMine: (report?.unreadable ?? []).filter((id) => ids.includes(id)),
  };
}

describe("re-sealing under the current key", () => {
  test("every sealed value moves to the current key and still reads back the same", async () => {
    useRetiredEncryptionKeys([OLD]);

    const credentialId = await storedCredential(
      await encryptSecret(OLD, "token-1"),
    );

    const userId = `rot-${randomUUID()}`;
    made.users.push(userId);
    await database.insert(users).values({
      id: userId,
      name: "Rot",
      email: `${userId}@example.com`,
      emailVerified: true,
    });
    const [connection] = await database
      .insert(modelConnections)
      .values({
        userId,
        providerId: "anthropic",
        label: "Mine",
        baseUrl: "https://api.anthropic.com",
        encryptedKey: await encryptSecret(OLD, "sk-model-key"),
        model: "claude",
        isDefault: true,
      })
      .returning({ id: modelConnections.id });

    const ssoId = `rot-sso-${randomUUID()}`;
    made.sso.push(ssoId);
    await database.insert(ssoProviders).values({
      id: ssoId,
      providerId: ssoId,
      issuer: "https://login.acme.example",
      domain: `${ssoId}.example`,
      oidcConfig: await encryptSecret(OLD, '{"clientSecret":"s3"}'),
      samlConfig: null,
    });

    const reports = await resealAll(database, {
      currentKey: NEW,
      dryRun: false,
    });

    const newId = await encryptionKeyId(NEW);
    const sealedNow = [
      await credentialValue(credentialId),
      (
        await database
          .select({ v: modelConnections.encryptedKey })
          .from(modelConnections)
          .where(eq(modelConnections.id, connection?.id as string))
      )[0]?.v as string,
      (
        await database
          .select({ v: ssoProviders.oidcConfig })
          .from(ssoProviders)
          .where(eq(ssoProviders.id, ssoId))
      )[0]?.v as string,
    ];
    for (const value of sealedNow) {
      expect(JSON.parse(value).kid).toBe(newId);
    }

    // Under the new key alone, with the old key forgotten, all of it still opens.
    useRetiredEncryptionKeys([]);
    expect(await decryptSecret(NEW, sealedNow[0] as string)).toBe("token-1");
    expect(await decryptSecret(NEW, sealedNow[1] as string)).toBe(
      "sk-model-key",
    );
    expect(await decryptSecret(NEW, sealedNow[2] as string)).toBe(
      '{"clientSecret":"s3"}',
    );

    // And the report named the columns it looked at.
    expect(reports.map((r) => `${r.table}.${r.column}`)).toEqual([
      "credentials.encrypted_value",
      "model_connections.encrypted_key",
      "sso_providers.oidc_config",
      "sso_providers.saml_config",
    ]);
  });

  test("a report changes nothing, and says what it would", async () => {
    useRetiredEncryptionKeys([OLD]);
    const sealed = await encryptSecret(OLD, "left alone");
    const id = await storedCredential(sealed);

    const reports = await resealAll(database, {
      currentKey: NEW,
      dryRun: true,
    });

    expect(await credentialValue(id)).toBe(sealed);
    expect(
      reports.find((r) => r.table === "credentials")?.resealed,
    ).toBeGreaterThanOrEqual(1);
  });

  test("running it again finds nothing left to do", async () => {
    useRetiredEncryptionKeys([OLD]);
    await storedCredential(await encryptSecret(OLD, "once"));
    await resealAll(database, { currentKey: NEW, dryRun: false });

    const again = await resealAll(database, { currentKey: NEW, dryRun: true });
    // Everything this file made is under the new key. Others' rows, sealed under keys this file does
    // not hold, are unreadable here and not this file's concern.
    expect(again.reduce((total, r) => total + r.resealed, 0)).toBe(0);
  });

  test("a value no held key opens is reported by id, left exactly as it was, and not mistaken for done", async () => {
    useRetiredEncryptionKeys([OLD]);
    const stranded = await encryptSecret(LOST, "unrecoverable here");
    const id = await storedCredential(stranded);
    const fine = await storedCredential(await encryptSecret(OLD, "fine"));

    const reports = await resealAll(database, {
      currentKey: NEW,
      dryRun: false,
    });

    expect(await credentialValue(id)).toBe(stranded);
    const { unreadableMine } = mine(reports, "credentials", [id, fine]);
    expect(unreadableMine).toEqual([id]);
    // The one it could open was moved regardless.
    expect(JSON.parse(await credentialValue(fine)).kid).toBe(
      await encryptionKeyId(NEW),
    );
  });

  test("a value changed by somebody else mid-run is not overwritten with the old one", async () => {
    useRetiredEncryptionKeys([OLD]);
    const original = await encryptSecret(OLD, "before");
    const id = await storedCredential(original);

    // The person rotates their own token between the script reading the row and writing it.
    const theirs = await encryptSecret(NEW, "theirs, just now");
    await database
      .update(credentials)
      .set({ encryptedValue: theirs })
      .where(eq(credentials.id, id));

    const column = sealedColumns(database).find(
      (c) => c.table === "credentials",
    );
    const wrote = await column?.replace(
      id,
      original,
      await encryptSecret(NEW, "before"),
    );

    expect(wrote).toBe(false);
    expect(await credentialValue(id)).toBe(theirs);
  });
});
