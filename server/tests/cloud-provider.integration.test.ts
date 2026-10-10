import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type {
  ComputerLocation,
  ComputerProvider,
} from "../src/computer/provider";
import { createCloudMeter } from "../src/cloud/meter";
import {
  meteredComputerProvider,
  reconcileCloudComputers,
  tenantOfBot,
} from "../src/cloud/provider";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  cloudIntervals,
  tenants,
} from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Writing down when a coworker's computer is up, without ever getting in the way of it.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const meter = createCloudMeter(database);
const tenantOf = tenantOfBot(database);
const madeTenants: string[] = [];
const madeAgents: string[] = [];

async function coworker(options: { billable: boolean } = { billable: true }) {
  const id = `agent_${randomUUID()}`;
  let tenantId: string | undefined;
  if (options.billable) {
    const [tenant] = await database
      .insert(tenants)
      .values({ name: "cp" })
      .returning({ id: tenants.id });
    tenantId = tenant?.id;
    madeTenants.push(tenantId as string);
  }
  await database
    .insert(agents)
    .values({ id, name: id, type: "built_in", configuration: {} } as never);
  await database.insert(agentProfiles).values({
    agentId: id,
    title: "t",
    roleDescription: "r",
    avatarSeed: id,
    visibility: "private",
    ...(tenantId ? { tenantId } : {}),
  });
  madeAgents.push(id);
  return { id, tenantId };
}

afterEach(async () => {
  if (madeAgents.length)
    await database
      .delete(agents)
      .where(inArray(agents.id, madeAgents.splice(0)));
  if (madeTenants.length)
    await database
      .delete(tenants)
      .where(inArray(tenants.id, madeTenants.splice(0)));
});
afterAll(async () => {
  await database.$client.close();
});

function fakeProvider(computers: ComputerLocation[] = []) {
  const calls: string[] = [];
  const provider: ComputerProvider = {
    name: "fake",
    isolation: "per-bot",
    locate: async (botId) => {
      calls.push(`locate:${botId}`);
      return `http://${botId}`;
    },
    status: async () => ({ botId: "x", status: "running" }) as never,
    stop: async (botId) => {
      calls.push(`stop:${botId}`);
      return { wasRunning: true };
    },
    reset: async (botId) => {
      calls.push(`reset:${botId}`);
      return { cleared: true };
    },
    list: async () => computers,
  };
  return { provider, calls };
}

const settle = () => Bun.sleep(80);
const rows = (tenantId: string) =>
  database
    .select()
    .from(cloudIntervals)
    .where(eq(cloudIntervals.tenantId, tenantId));

describe("noting down a computer", () => {
  test("using a coworker's computer opens an interval; stopping it closes it; the provider is untouched", async () => {
    const bot = await coworker();
    const { provider, calls } = fakeProvider();
    const metered = meteredComputerProvider(provider, { meter, tenantOf });
    expect(await metered.locate(bot.id)).toBe(`http://${bot.id}`);
    await settle();
    expect(
      (await rows(bot.tenantId as string)).filter(
        (r) => r.source === "computer" && r.endedAt === null,
      ),
    ).toHaveLength(1);
    await metered.stop(bot.id);
    await settle();
    expect((await rows(bot.tenantId as string))[0]?.endedAt).not.toBeNull();
    expect(calls).toEqual([`locate:${bot.id}`, `stop:${bot.id}`]);
  });

  test("being asked for a hundred times in a minute is one record, not a hundred writes", async () => {
    const bot = await coworker();
    const { provider } = fakeProvider();
    let clock = 1_000_000;
    const metered = meteredComputerProvider(provider, {
      meter,
      tenantOf,
      refreshMs: 30_000,
      now: () => clock,
    });
    for (let i = 0; i < 100; i++) {
      await metered.locate(bot.id);
      clock += 100;
    }
    await settle();
    const [row] = await rows(bot.tenantId as string);
    expect(row).toBeDefined();
    // The only write after the first would be a refresh 30 seconds on, which this minute never reached.
    expect(row?.lastSeenAt.getTime()).toBe(row?.startedAt.getTime());
  });

  test("the platform's own coworkers, which belong to nobody, are not recorded", async () => {
    const bot = await coworker({ billable: false });
    const { provider } = fakeProvider();
    await meteredComputerProvider(provider, { meter, tenantOf }).locate(bot.id);
    await settle();
    const all = await database
      .select()
      .from(cloudIntervals)
      .where(eq(cloudIntervals.botId, bot.id));
    expect(all).toHaveLength(0);
  });

  test("a ledger that is down never fails what the person was doing", async () => {
    const bot = await coworker();
    const { provider } = fakeProvider();
    const broken = {
      ...meter,
      computerSeen: async () => {
        throw new Error("ledger down");
      },
    };
    const metered = meteredComputerProvider(provider, {
      meter: broken,
      tenantOf,
    });
    expect(await metered.locate(bot.id)).toBe(`http://${bot.id}`);
    expect((await metered.stop(bot.id)).wasRunning).toBe(true);
  });

  test("a provider's optional abilities are kept, and only those", () => {
    const { provider } = fakeProvider();
    expect(
      meteredComputerProvider(provider, { meter, tenantOf }).warm,
    ).toBeUndefined();
    const withWarm = {
      ...provider,
      warm: async () => {},
      sessionOf: async () => "s",
    };
    const wrapped = meteredComputerProvider(withWarm, { meter, tenantOf });
    expect(typeof wrapped.warm).toBe("function");
    expect(typeof wrapped.sessionOf).toBe("function");
  });
});

describe("bringing the record into line with what exists", () => {
  test("a computer that is up is recorded as up, whoever noticed, and its storage with it", async () => {
    const bot = await coworker();
    const { provider } = fakeProvider([{ botId: bot.id, status: "running" }]);
    const report = await reconcileCloudComputers({
      provider,
      meter,
      tenantOf,
      volumeBytes: 2 * 1024 ** 3,
    });
    expect(report.up).toBe(1);
    const found = await rows(bot.tenantId as string);
    expect(found.map((r) => r.source).sort()).toEqual(["computer", "storage"]);
    expect(found.find((r) => r.source === "storage")?.bytes).toBe(
      2 * 1024 ** 3,
    );
  });

  test("a suspended computer is not working time, but it still holds its disks", async () => {
    const bot = await coworker();
    const { provider } = fakeProvider([{ botId: bot.id, status: "stopped" }]);
    await reconcileCloudComputers({
      provider,
      meter,
      tenantOf,
      volumeBytes: 1024,
    });
    expect((await rows(bot.tenantId as string)).map((r) => r.source)).toEqual([
      "storage",
    ]);
  });

  test("a computer recorded as up that is no longer up is closed, and so is storage that is gone", async () => {
    const bot = await coworker();
    await meter.computerSeen({
      tenantId: bot.tenantId as string,
      botId: bot.id,
    });
    await meter.storageSeen({
      tenantId: bot.tenantId as string,
      botId: bot.id,
      bytes: 5,
    });
    const { provider } = fakeProvider([]);
    const report = await reconcileCloudComputers({
      provider,
      meter,
      tenantOf,
      volumeBytes: 5,
    });
    expect(report.closed).toBeGreaterThanOrEqual(2);
    expect(
      (await rows(bot.tenantId as string)).every((r) => r.endedAt !== null),
    ).toBe(true);
  });

  test("storage is not recorded where it is not metered", async () => {
    const bot = await coworker();
    const { provider } = fakeProvider([{ botId: bot.id, status: "running" }]);
    await reconcileCloudComputers({
      provider,
      meter,
      tenantOf,
      volumeBytes: 0,
    });
    expect((await rows(bot.tenantId as string)).map((r) => r.source)).toEqual([
      "computer",
    ]);
  });
});
