import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { pushSubscriptions, users } from "../src/db/schema";
import { createPushStore, MOST_DEVICES_PER_PERSON } from "../src/push/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * A person's devices for notifications, against a real database.
 *
 * What is protected: a device belongs to one person at a time; a person can only forget their own;
 * there is a limit to how many one person keeps; and removing the person removes their devices.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createPushStore(database);
const made: string[] = [];

async function person() {
  const id = `push-${randomUUID()}`;
  await database.insert(users).values({ id, email: `${id}@example.com` });
  made.push(id);
  return id;
}
const device = (name: string) => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}-${name}`,
  p256dh:
    "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
  auth: "tBHItJI5svbpez7KI4CCXg",
});

afterEach(async () => {
  if (made.length > 0) {
    await database.delete(users).where(inArray(users.id, made.splice(0)));
  }
});
afterAll(async () => {
  await database.$client.close();
});

describe("a person's devices", () => {
  test("are kept, listed and counted for that person alone", async () => {
    const ann = await person();
    const bob = await person();
    const phone = device("phone");
    await store.save(ann, phone);
    await store.save(bob, device("laptop"));
    expect(await store.count(ann)).toBe(1);
    const listed = await store.forUser(ann);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.endpoint).toBe(phone.endpoint);
    expect(listed[0]?.auth).toBe(phone.auth);
    expect(await store.count(bob)).toBe(1);
  });

  test("the same device saved again is one device, and moves to whoever is signed in on it", async () => {
    const ann = await person();
    const bob = await person();
    const shared = device("shared");
    await store.save(ann, shared);
    await store.save(ann, shared);
    expect(await store.count(ann)).toBe(1);
    await store.save(bob, { ...shared, auth: "anotherAuthSecretValue" });
    expect(await store.count(ann)).toBe(0);
    expect((await store.forUser(bob))[0]?.auth).toBe("anotherAuthSecretValue");
  });

  test("a person can forget their own device and not somebody else's", async () => {
    const ann = await person();
    const bob = await person();
    const phone = device("phone");
    await store.save(ann, phone);
    expect(await store.remove(bob, phone.endpoint)).toBe(false);
    expect(await store.count(ann)).toBe(1);
    expect(await store.remove(ann, phone.endpoint)).toBe(true);
    expect(await store.count(ann)).toBe(0);
    expect(await store.remove(ann, phone.endpoint)).toBe(false);
  });

  test("past the limit, the oldest are the ones that go", async () => {
    const ann = await person();
    const all = Array.from({ length: MOST_DEVICES_PER_PERSON + 3 }, (_, n) =>
      device(`d${n}`),
    );
    for (const one of all) {
      await store.save(ann, one);
      // Distinct times, so "oldest" means something.
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const kept = (await store.forUser(ann)).map((row) => row.endpoint);
    expect(kept).toHaveLength(MOST_DEVICES_PER_PERSON);
    expect(kept).not.toContain(all[0]?.endpoint);
    expect(kept).toContain(all[all.length - 1]?.endpoint);
  });

  test("a device the push service says is gone is forgotten whoever it was", async () => {
    const ann = await person();
    const phone = device("phone");
    await store.save(ann, phone);
    await store.removeEverywhere(phone.endpoint);
    expect(await store.count(ann)).toBe(0);
  });

  test("go with the person when their account is removed", async () => {
    const ann = await person();
    await store.save(ann, device("a"));
    await store.save(ann, device("b"));
    await database.delete(users).where(eq(users.id, ann));
    made.splice(made.indexOf(ann), 1);
    const left = await database
      .select({ id: pushSubscriptions.id })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, ann));
    expect(left).toEqual([]);
  });
});
