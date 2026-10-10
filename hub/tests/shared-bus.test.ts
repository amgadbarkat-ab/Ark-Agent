import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { SharedBus } from "../src/shared-bus";
import { createTestDatabase, type TestDatabase } from "./support";

/**
 * The bus several hub processes share, against a real PostgreSQL. Each `SharedBus` here is what one
 * hub process holds; two of them on one database are two processes.
 */

let database: TestDatabase;
const open: SharedBus[] = [];

beforeAll(async () => {
  database = await createTestDatabase();
});
afterEach(async () => {
  // Every process a test started stops with it, so connections do not pile up across the file.
  for (const bus of open.splice(0)) await bus.close();
});
afterAll(async () => {
  await database.drop();
});

/** One hub process: its own bus (and so its own listening connection) over the shared database. */
async function process_(sql = database.sql) {
  const bus = new SharedBus(sql, () => {});
  await bus.start();
  open.push(bus);
  return { bus, sql };
}

const until = async (check: () => boolean, ms = 5000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting");
    await Bun.sleep(10);
  }
};

describe("two processes", () => {
  test("what one publishes the other hears, and the one that published hears it once", async () => {
    const a = await process_();
    const b = await process_();
    const heardByA: unknown[] = [];
    const heardByB: unknown[] = [];
    a.bus.subscribe("thread:1", (event, payload) =>
      heardByA.push([event, payload]),
    );
    b.bus.subscribe("thread:1", (event, payload) =>
      heardByB.push([event, payload]),
    );

    a.bus.publish("thread:1", "stored", { seq: 1, text: "hello" });
    // In its own process it is heard in the same call, as the in-process bus always did.
    expect(heardByA).toEqual([["stored", { seq: 1, text: "hello" }]]);
    await until(() => heardByB.length === 1);
    // Give a duplicate time to show up if there is one.
    await Bun.sleep(150);
    expect(heardByA).toHaveLength(1);
    expect(heardByB).toEqual([["stored", { seq: 1, text: "hello" }]]);
  });

  test("only those listening to the topic hear it", async () => {
    const a = await process_();
    const b = await process_();
    const mine: string[] = [];
    const other: string[] = [];
    b.bus.subscribe("thread:x", (event) => mine.push(event));
    b.bus.subscribe("thread:y", (event) => other.push(event));
    a.bus.publish("thread:x", "stored", {});
    await until(() => mine.length === 1);
    await Bun.sleep(100);
    expect(other).toEqual([]);
  });

  test("a leaving listener stops hearing", async () => {
    const a = await process_();
    const b = await process_();
    const heard: string[] = [];
    const stop = b.bus.subscribe("t", (event) => heard.push(event));
    a.bus.publish("t", "one", {});
    await until(() => heard.length === 1);
    stop();
    a.bus.publish("t", "two", {});
    await Bun.sleep(150);
    expect(heard).toEqual(["one"]);
    expect(b.bus.listenerCount("t")).toBe(0);
  });

  test("an event too big for a NOTIFY crosses intact, and is tidied away afterwards", async () => {
    const a = await process_();
    const b = await process_();
    const heard: Array<{ text: string }> = [];
    b.bus.subscribe("big", (_event, payload) =>
      heard.push(payload as { text: string }),
    );
    const text = `${"é".repeat(60_000)}end`;
    a.bus.publish("big", "stored", { text });
    await until(() => heard.length === 1);
    expect(heard[0]?.text).toBe(text);

    const rows = await a.sql`select count(*)::int as n from hub_bus_overflow`;
    expect(rows[0]?.n).toBeGreaterThanOrEqual(1);
    await a.sql`update hub_bus_overflow set created_at = now() - interval '1 hour'`;
    await (a.bus as unknown as { sweep(): Promise<void> }).sweep();
    expect(
      (await a.sql`select count(*)::int as n from hub_bus_overflow`)[0]?.n,
    ).toBe(0);
  });

  test("a large event and the small ones around it arrive in the order they were sent", async () => {
    const a = await process_();
    const b = await process_();
    const order: string[] = [];
    b.bus.subscribe("order", (event) => order.push(event));
    a.bus.publish("order", "first", {});
    a.bus.publish("order", "big", { text: "x".repeat(40_000) });
    a.bus.publish("order", "third", {});
    a.bus.publish("order", "fourth", {});
    await until(() => order.length === 4);
    expect(order).toEqual(["first", "big", "third", "fourth"]);
  });

  test("hubs in different schemas of one database never hear each other", async () => {
    const other = await createTestDatabase();
    try {
      const a = await process_();
      const stranger = new SharedBus(other.sql, () => {});
      await stranger.start();
      const heard: string[] = [];
      stranger.subscribe("shared-name", (event) => heard.push(event));
      a.bus.publish("shared-name", "secret", {});
      await Bun.sleep(300);
      expect(heard).toEqual([]);
      await stranger.close();
    } finally {
      await other.drop();
    }
  });

  test("a message that is not ours or is garbage does not stop the bus", async () => {
    const a = await process_();
    const b = await process_();
    const heard: string[] = [];
    b.bus.subscribe("t", (event) => heard.push(event));
    const [{ schema }] = await a.sql<
      { schema: string }[]
    >`select current_schema() as schema`;
    await a.sql.notify(`hub_bus_${schema}`, "{not json");
    await a.sql.notify(
      `hub_bus_${schema}`,
      JSON.stringify({ o: "x", r: "99999999" }),
    );
    a.bus.publish("t", "after", {});
    await until(() => heard.length === 1);
    expect(heard).toEqual(["after"]);
  });
});

describe("losing the connection", () => {
  test("tells its owner to catch up when listening comes back, and carries on", async () => {
    const a = await process_();
    const b = await process_();
    let resyncs = 0;
    b.bus.onResync(() => {
      resyncs += 1;
    });
    const heard: string[] = [];
    b.bus.subscribe("t", (event) => heard.push(event));

    // Cut every connection that is listening, as a failover or a network blip would.
    await a.sql`
      select pg_terminate_backend(pid) from pg_stat_activity
      where datname = current_database() and query ilike 'listen %'`;
    await until(() => resyncs >= 1, 15_000);

    // Once it is back the traffic flows again.
    let attempt = 0;
    while (heard.length === 0 && attempt++ < 100) {
      a.bus.publish("t", "again", {});
      await Bun.sleep(100);
    }
    expect(heard[0]).toBe("again");
  });

  test("one process hearing nothing at the start is not a gap", async () => {
    const a = await process_();
    let resyncs = 0;
    a.bus.onResync(() => {
      resyncs += 1;
    });
    await Bun.sleep(200);
    expect(resyncs).toBe(0);
  });
});
