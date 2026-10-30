import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { modelConnections, users } from "../src/db/schema";
import {
  createModelConnectionStore,
  MAX_CONNECTIONS_PER_USER,
  TooManyConnectionsError,
} from "../src/models/connections";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const KEY = Buffer.alloc(32, 7).toString("base64");
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createModelConnectionStore(database, KEY);
const created: string[] = [];

async function person() {
  const id = `models-${randomUUID()}`;
  await database.insert(users).values({ id, email: `${id}@example.com` });
  created.push(id);
  return id;
}

const ollama = (label = "My Ollama") => ({
  providerId: "ollama",
  label,
  baseUrl: "http://localhost:11434/v1",
  model: "qwen3:8b",
});
const anthropic = (apiKey = "sk-ant-secret-1") => ({
  providerId: "anthropic",
  label: "Claude",
  baseUrl: "https://api.anthropic.com",
  model: "claude-haiku-4-5-20251001",
  apiKey,
});

afterEach(async () => {
  for (const id of created.splice(0)) {
    await database.delete(users).where(eq(users.id, id));
  }
});
afterAll(async () => {
  await database.$client.close();
});

describe("model connections", () => {
  test("the first connection becomes the default and later ones do not", async () => {
    const ann = await person();
    const first = await store.create(ann, ollama("One"));
    const second = await store.create(ann, ollama("Two"));
    expect(first.isDefault).toBe(true);
    expect(second.isDefault).toBe(false);
    expect((await store.list(ann)).map((c) => c.label)).toEqual(["One", "Two"]);
  });

  test("a key is stored encrypted, reported only as present, and opened only on request", async () => {
    const ann = await person();
    const made = await store.create(ann, anthropic("sk-ant-secret-1"));
    expect(made.hasKey).toBe(true);
    expect(JSON.stringify(made)).not.toContain("sk-ant-secret-1");
    expect(JSON.stringify(await store.list(ann))).not.toContain(
      "sk-ant-secret-1",
    );

    const [row] = await database
      .select()
      .from(modelConnections)
      .where(eq(modelConnections.id, made.id));
    expect(row?.encryptedKey).toBeTruthy();
    expect(row?.encryptedKey).not.toContain("sk-ant-secret-1");

    const opened = await store.open(ann, made.id);
    expect(opened?.apiKey).toBe("sk-ant-secret-1");
  });

  test("a provider with no key stores none", async () => {
    const ann = await person();
    const made = await store.create(ann, ollama());
    expect(made.hasKey).toBe(false);
    expect((await store.open(ann, made.id))?.apiKey).toBeNull();
  });

  test("a stored key cannot be opened with a different encryption key", async () => {
    const ann = await person();
    const made = await store.create(ann, anthropic());
    const other = createModelConnectionStore(
      database,
      Buffer.alloc(32, 9).toString("base64"),
    );
    await expect(other.open(ann, made.id)).rejects.toThrow();
  });

  test("one person cannot see, change, open or remove another's connection", async () => {
    const ann = await person();
    const bob = await person();
    const made = await store.create(ann, anthropic());
    expect(await store.list(bob)).toEqual([]);
    expect(await store.get(bob, made.id)).toBeNull();
    expect(await store.open(bob, made.id)).toBeNull();
    expect(await store.update(bob, made.id, { label: "mine now" })).toBeNull();
    expect(await store.setDefault(bob, made.id)).toBeNull();
    expect(await store.remove(bob, made.id)).toBe(false);
    expect((await store.get(ann, made.id))?.label).toBe("Claude");
  });

  test("an update changes only what it names, and the key only when asked", async () => {
    const ann = await person();
    const made = await store.create(ann, anthropic("sk-ant-secret-1"));

    const renamed = await store.update(ann, made.id, { label: "Work Claude" });
    expect(renamed?.label).toBe("Work Claude");
    expect((await store.open(ann, made.id))?.apiKey).toBe("sk-ant-secret-1");

    await store.update(ann, made.id, { apiKey: "sk-ant-secret-2" });
    expect((await store.open(ann, made.id))?.apiKey).toBe("sk-ant-secret-2");

    const cleared = await store.update(ann, made.id, { apiKey: null });
    expect(cleared?.hasKey).toBe(false);
    expect((await store.open(ann, made.id))?.apiKey).toBeNull();
  });

  test("there is always exactly one default, and choosing another moves it", async () => {
    const ann = await person();
    const a = await store.create(ann, ollama("A"));
    const b = await store.create(ann, ollama("B"));
    const moved = await store.setDefault(ann, b.id);
    expect(moved?.isDefault).toBe(true);
    const all = await store.list(ann);
    expect(all.filter((c) => c.isDefault).map((c) => c.id)).toEqual([b.id]);
    expect((await store.open(ann))?.id).toBe(b.id);
    expect(a.id).not.toBe(b.id);
  });

  test("clearing the default leaves none, so runs use the deployment's own model, until one is chosen", async () => {
    const ann = await person();
    const a = await store.create(ann, ollama("A"));
    const b = await store.create(ann, ollama("B"));
    expect((await store.clearDefault(ann))?.id).toBe(a.id);
    expect((await store.list(ann)).some((c) => c.isDefault)).toBe(false);
    expect(await store.getDefault(ann)).toBeNull();
    expect(await store.open(ann)).toBeNull();
    // Nothing to clear the second time, and removing a connection does not bring a default back.
    expect(await store.clearDefault(ann)).toBeNull();
    expect(await store.remove(ann, a.id)).toBe(true);
    expect(await store.getDefault(ann)).toBeNull();
    // Choosing one again works as before.
    expect((await store.setDefault(ann, b.id))?.isDefault).toBe(true);
    expect((await store.open(ann))?.id).toBe(b.id);
  });

  test("removing the default hands the role to the oldest remaining; removing another leaves it", async () => {
    const ann = await person();
    const a = await store.create(ann, ollama("A"));
    const b = await store.create(ann, ollama("B"));
    const c = await store.create(ann, ollama("C"));

    expect(await store.remove(ann, c.id)).toBe(true);
    expect((await store.open(ann))?.id).toBe(a.id);

    expect(await store.remove(ann, a.id)).toBe(true);
    expect((await store.open(ann))?.id).toBe(b.id);

    expect(await store.remove(ann, b.id)).toBe(true);
    expect(await store.open(ann)).toBeNull();
    expect(await store.remove(ann, b.id)).toBe(false);
  });

  test("a person's connections are limited", async () => {
    const ann = await person();
    for (let i = 0; i < MAX_CONNECTIONS_PER_USER; i++) {
      await store.create(ann, ollama(`C${i}`));
    }
    await expect(
      store.create(ann, ollama("one too many")),
    ).rejects.toBeInstanceOf(TooManyConnectionsError);
  });

  test("two connections made at once cannot both be the first", async () => {
    const ann = await person();
    await Promise.all([
      store.create(ann, ollama("X")),
      store.create(ann, ollama("Y")),
      store.create(ann, ollama("Z")),
    ]);
    const all = await store.list(ann);
    expect(all).toHaveLength(3);
    expect(all.filter((c) => c.isDefault)).toHaveLength(1);
  });

  test("removing a person removes their connections", async () => {
    const ann = await person();
    const made = await store.create(ann, anthropic());
    await database.delete(users).where(eq(users.id, ann));
    const rows = await database
      .select()
      .from(modelConnections)
      .where(eq(modelConnections.id, made.id));
    expect(rows).toEqual([]);
  });
});
