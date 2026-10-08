import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { createCloudMeter } from "../src/cloud/meter";
import { createDatabase } from "../src/db/client";
import { cloudIntervals, tenants } from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * What is recorded about the cloud being used, and what a month of it adds up to.
 *
 * The properties that matter: an hour in which a run and a computer overlap is one hour; a crash
 * is worth what was seen, never "until now"; a month holds only its own part of an interval that
 * crosses into it; two server processes recording the same computer do not make two computers; and
 * one account never sees another's usage.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const meter = createCloudMeter(database);
const made: string[] = [];

async function account(name = "cloud-meter") {
  const [row] = await database
    .insert(tenants)
    .values({ name })
    .returning({ id: tenants.id });
  made.push(row?.id as string);
  return row?.id as string;
}

afterEach(async () => {
  if (made.length > 0) {
    await database.delete(tenants).where(inArray(tenants.id, made.splice(0)));
  }
});
afterAll(async () => {
  await database.$client.close();
});

const at = (iso: string) => new Date(iso);
const HOUR = 3600;

describe("compute", () => {
  test("a run is the time between it starting and ending", async () => {
    const tenant = await account();
    await meter.runStarted({
      tenantId: tenant,
      botId: "bot",
      runId: "r1",
      at: at("2026-10-05T10:00:00Z"),
    });
    await meter.runEnded("r1", at("2026-10-05T11:30:00Z"));
    expect((await meter.usageFor(tenant, "2026-10")).computeSeconds).toBe(
      1.5 * HOUR,
    );
  });

  test("a run and the computer it ran on, overlapping, are one stretch, not two", async () => {
    const tenant = await account();
    await meter.computerSeen({
      tenantId: tenant,
      botId: "bot",
      at: at("2026-10-05T10:00:00Z"),
    });
    await meter.runStarted({
      tenantId: tenant,
      botId: "bot",
      runId: "r1",
      at: at("2026-10-05T10:20:00Z"),
    });
    await meter.runEnded("r1", at("2026-10-05T10:40:00Z"));
    await meter.computerSeen({
      tenantId: tenant,
      botId: "bot",
      at: at("2026-10-05T11:00:00Z"),
    });
    await meter.computerStopped("bot", at("2026-10-05T11:00:00Z"));
    expect((await meter.usageFor(tenant, "2026-10")).computeSeconds).toBe(
      1 * HOUR,
    );
  });

  test("two coworkers working at once are two hours of one hour", async () => {
    const tenant = await account();
    for (const bot of ["a", "b"]) {
      await meter.runStarted({
        tenantId: tenant,
        botId: bot,
        runId: `run-${bot}`,
        at: at("2026-10-05T10:00:00Z"),
      });
      await meter.runEnded(`run-${bot}`, at("2026-10-05T11:00:00Z"));
    }
    expect((await meter.usageFor(tenant, "2026-10")).computeSeconds).toBe(
      2 * HOUR,
    );
  });

  test("a run nobody ended is worth what was seen of it, and not a second more", async () => {
    const tenant = await account();
    await meter.runStarted({
      tenantId: tenant,
      botId: "bot",
      runId: "crashed",
      at: at("2026-10-05T10:00:00Z"),
    });
    await meter.runSeen("crashed", at("2026-10-05T10:10:00Z"));
    // Weeks pass; the process that held it is long gone.
    expect((await meter.usageFor(tenant, "2026-10")).computeSeconds).toBe(
      10 * 60,
    );
    expect(await meter.closeStale(5 * 60_000, at("2026-10-20T00:00:00Z"))).toBe(
      1,
    );
    expect((await meter.usageFor(tenant, "2026-10")).computeSeconds).toBe(
      10 * 60,
    );
  });

  test("an interval that crosses midnight at the end of the month is split between the two months", async () => {
    const tenant = await account();
    await meter.runStarted({
      tenantId: tenant,
      botId: "bot",
      runId: "late",
      at: at("2026-10-31T22:00:00Z"),
    });
    await meter.runEnded("late", at("2026-11-01T03:00:00Z"));
    expect((await meter.usageFor(tenant, "2026-10")).computeSeconds).toBe(
      2 * HOUR,
    );
    expect((await meter.usageFor(tenant, "2026-11")).computeSeconds).toBe(
      3 * HOUR,
    );
    expect((await meter.usageFor(tenant, "2026-09")).computeSeconds).toBe(0);
  });

  test("starting the same run twice is one run", async () => {
    const tenant = await account();
    const input = {
      tenantId: tenant,
      botId: "bot",
      runId: "same",
      at: at("2026-10-05T10:00:00Z"),
    };
    await meter.runStarted(input);
    await meter.runStarted({ ...input, at: at("2026-10-05T10:30:00Z") });
    await meter.runEnded("same", at("2026-10-05T11:00:00Z"));
    expect((await meter.usageFor(tenant, "2026-10")).computeSeconds).toBe(
      1 * HOUR,
    );
  });

  test("ending something that was never started, or ending twice, changes nothing", async () => {
    const tenant = await account();
    await meter.runEnded("never");
    await meter.runStarted({
      tenantId: tenant,
      botId: "bot",
      runId: "r",
      at: at("2026-10-05T10:00:00Z"),
    });
    await meter.runEnded("r", at("2026-10-05T10:30:00Z"));
    await meter.runEnded("r", at("2026-10-05T23:00:00Z"));
    expect((await meter.usageFor(tenant, "2026-10")).computeSeconds).toBe(
      30 * 60,
    );
  });
});

describe("a computer seen by several server processes", () => {
  test("is one interval, however many say it is up, and one hour of it is one hour", async () => {
    const tenant = await account();
    await Promise.all(
      Array.from({ length: 8 }, () =>
        meter.computerSeen({
          tenantId: tenant,
          botId: "shared-bot",
          at: at("2026-10-05T10:00:00Z"),
        }),
      ),
    );
    await meter.computerSeen({
      tenantId: tenant,
      botId: "shared-bot",
      at: at("2026-10-05T11:00:00Z"),
    });
    const rows = await database
      .select()
      .from(cloudIntervals)
      .where(eq(cloudIntervals.tenantId, tenant));
    expect(rows).toHaveLength(1);
    expect((await meter.usageFor(tenant, "2026-10")).computeSeconds).toBe(
      1 * HOUR,
    );
  });

  test("a computer that stops and comes up again is two intervals", async () => {
    const tenant = await account();
    await meter.computerSeen({
      tenantId: tenant,
      botId: "bot",
      at: at("2026-10-05T10:00:00Z"),
    });
    await meter.computerStopped("bot", at("2026-10-05T10:30:00Z"));
    await meter.computerSeen({
      tenantId: tenant,
      botId: "bot",
      at: at("2026-10-05T12:00:00Z"),
    });
    await meter.computerStopped("bot", at("2026-10-05T12:30:00Z"));
    expect((await meter.usageFor(tenant, "2026-10")).computeSeconds).toBe(3600);
    const rows = await database
      .select()
      .from(cloudIntervals)
      .where(eq(cloudIntervals.tenantId, tenant));
    expect(rows).toHaveLength(2);
  });
});

describe("storage", () => {
  test("is the size held, times the time it was held", async () => {
    const tenant = await account();
    const gib = 1024 ** 3;
    await meter.storageSeen({
      tenantId: tenant,
      botId: "bot",
      bytes: 2 * gib,
      at: at("2026-10-05T10:00:00Z"),
    });
    await meter.storageCleared("bot", at("2026-10-05T12:00:00Z"));
    expect((await meter.usageFor(tenant, "2026-10")).storageByteSeconds).toBe(
      2 * gib * 2 * HOUR,
    );
  });

  test("never adds compute: storage held while nothing runs is not working time", async () => {
    const tenant = await account();
    await meter.storageSeen({
      tenantId: tenant,
      botId: "bot",
      bytes: 1024,
      at: at("2026-10-05T10:00:00Z"),
    });
    await meter.storageCleared("bot", at("2026-10-06T10:00:00Z"));
    expect((await meter.usageFor(tenant, "2026-10")).computeSeconds).toBe(0);
  });
});

describe("whose it is", () => {
  test("one account never sees another's usage, and the month's accounts are listed", async () => {
    const mine = await account("mine");
    const theirs = await account("theirs");
    await meter.runStarted({
      tenantId: theirs,
      botId: "bot",
      runId: "theirs-run",
      at: at("2026-10-05T10:00:00Z"),
    });
    await meter.runEnded("theirs-run", at("2026-10-05T12:00:00Z"));
    expect((await meter.usageFor(mine, "2026-10")).computeSeconds).toBe(0);
    expect((await meter.usageFor(theirs, "2026-10")).computeSeconds).toBe(
      2 * HOUR,
    );
    const listed = await meter.tenantsWithUsage("2026-10");
    expect(listed).toContain(theirs);
    expect(listed).not.toContain(mine);
  });
});
