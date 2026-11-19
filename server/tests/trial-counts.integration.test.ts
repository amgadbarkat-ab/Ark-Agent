import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { channels, sessions, users } from "../src/db/schema";
import { installCounts, systemKind } from "../src/trial/counts";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * The counts a v0.1.49 check-in carries (#149). Other test files share this database, so this
 * measures what its own rows add, never absolute numbers.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const NOW = new Date("2026-11-18T10:00:00Z");
const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const tag = randomUUID().slice(0, 8);
const ids = {
  recent: `counts-${tag}-recent`,
  session: `counts-${tag}-session`,
  idle: `counts-${tag}-idle`,
  newChannel: `counts-${tag}-new`,
  oldChannel: `counts-${tag}-old`,
};

async function remove() {
  await database
    .delete(sessions)
    .where(inArray(sessions.userId, [ids.recent, ids.session, ids.idle]));
  await database
    .delete(users)
    .where(inArray(users.id, [ids.recent, ids.session, ids.idle]));
  await database
    .delete(channels)
    .where(inArray(channels.id, [ids.newChannel, ids.oldChannel]));
}

let before: Awaited<ReturnType<typeof installCounts>>;
beforeAll(async () => {
  await remove();
  before = await installCounts(database, () => NOW);
});
afterAll(async () => {
  await remove();
  await database.$client.close();
});

describe("check-in counts (v0.1.49)", () => {
  test("counts people, people active in 7 days, and conversations started in 7 days; nothing else", async () => {
    await database.insert(users).values([
      // Signed in two days ago.
      {
        id: ids.recent,
        email: `${ids.recent}@example.test`,
        lastSignedInAt: day(2),
      },
      // Signed in long ago, but a session was used yesterday.
      {
        id: ids.session,
        email: `${ids.session}@example.test`,
        lastSignedInAt: day(40),
      },
      // Not used for a month.
      {
        id: ids.idle,
        email: `${ids.idle}@example.test`,
        lastSignedInAt: day(30),
      },
    ]);
    await database.insert(sessions).values({
      id: `${ids.session}-s`,
      userId: ids.session,
      token: `${ids.session}-token`,
      expiresAt: day(-7),
      createdAt: day(20),
      updatedAt: day(1),
    });
    await database.insert(channels).values([
      { id: ids.newChannel, name: "New", description: "", createdAt: day(3) },
      { id: ids.oldChannel, name: "Old", description: "", createdAt: day(10) },
    ]);
    const after = await installCounts(database, () => NOW);
    expect(after.people - before.people).toBe(3);
    expect(after.activePeople7d - before.activePeople7d).toBe(2);
    expect(after.conversations7d - before.conversations7d).toBe(1);
    expect(typeof after.phoneLine).toBe("boolean");
    // Numbers, one flag and the kind of system: no name, email or text of any kind.
    expect(Object.keys(after).sort()).toEqual(
      ["activePeople7d", "conversations7d", "os", "people", "phoneLine"].filter(
        (key) => key !== "os" || after.os !== undefined,
      ),
    );
    expect(JSON.stringify(after)).not.toContain("example.test");
  });

  test("the kind of system, from the platform name", () => {
    expect(systemKind("win32")).toBe("windows");
    expect(systemKind("darwin")).toBe("macos");
    expect(systemKind("linux")).toBe("linux");
    expect(systemKind("freebsd")).toBeUndefined();
  });
});
