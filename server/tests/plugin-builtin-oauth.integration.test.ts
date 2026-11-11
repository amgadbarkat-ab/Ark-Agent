import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import { mcpServers, mcpTools } from "../src/db/schema";
import { createPluginStore } from "../src/plugins/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * ArkAgent's built-in OAuth apps against a real database (desk #83): a server an administrator added
 * but registered no client for uses the built-in one, a server nobody added uses none, and a store
 * with no built-in clients behaves exactly as before.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);

function storeWith(builtin: boolean) {
  return createPluginStore({
    database,
    auditStore: createAuditStore(database),
    credentials: {
      readSecret: async () => null,
      create: async () => {
        throw new Error("this suite does not write credentials");
      },
      revoke: async () => {
        throw new Error("this suite does not revoke credentials");
      },
    },
    encryptionKey: "x".repeat(44),
    policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
    ...(builtin
      ? {
          builtinClients: {
            google: { clientId: "builtin-google", clientSecret: "not-secret" },
            microsoft: { clientId: "builtin-microsoft", clientSecret: "" },
          },
        }
      : {}),
  });
}

const added = ["google-gmail", "microsoft-365"];
const notAdded = "google-drive";
let existing: Array<{ id: string; credentialId: string | null }> = [];

beforeAll(async () => {
  // Real catalogue keys, so a developer's own rows are put back as they were afterwards.
  existing = await database
    .select({ id: mcpServers.id, credentialId: mcpServers.credentialId })
    .from(mcpServers)
    .where(inArray(mcpServers.id, [...added, notAdded]));
  if (existing.some((row) => row.id === notAdded)) {
    throw new Error(
      `${notAdded} is configured on this database; this suite needs it absent`,
    );
  }
  const store = storeWith(false);
  for (const key of added) {
    if (!existing.some((row) => row.id === key)) {
      await store.addServer({ key, by: "admin@example.com" });
    }
  }
  await database
    .update(mcpServers)
    .set({ credentialId: null })
    .where(inArray(mcpServers.id, added));
});

afterAll(async () => {
  for (const key of added) {
    const before = existing.find((row) => row.id === key);
    if (before) {
      await database
        .update(mcpServers)
        .set({ credentialId: before.credentialId })
        .where(eq(mcpServers.id, key));
    } else {
      await database.delete(mcpTools).where(eq(mcpTools.serverId, key));
      await database.delete(mcpServers).where(eq(mcpServers.id, key));
    }
  }
});

describe("a server with no client of its own", () => {
  test("uses ArkAgent's built-in app for its vendor", async () => {
    const store = storeWith(true);
    expect(await store.oauthClientFor("google-gmail")).toEqual({
      clientId: "builtin-google",
      clientSecret: "not-secret",
    });
    expect(await store.oauthClientFor("microsoft-365")).toEqual({
      clientId: "builtin-microsoft",
      clientSecret: "",
    });
  });

  test("is shown as ready to connect", async () => {
    const servers = await storeWith(true).listServers();
    for (const key of added) {
      expect(servers.find((server) => server.id === key)?.hasCredential).toBe(
        true,
      );
    }
  });

  test("a server nobody has added gets no client, built-in or not", async () => {
    expect(await storeWith(true).oauthClientFor(notAdded)).toBeNull();
  });

  test("without built-in apps, nothing changes: no client, and setup still needed", async () => {
    const store = storeWith(false);
    expect(await store.oauthClientFor("google-gmail")).toBeNull();
    const servers = await store.listServers();
    expect(
      servers.find((server) => server.id === "google-gmail")?.hasCredential,
    ).toBe(false);
  });
});
