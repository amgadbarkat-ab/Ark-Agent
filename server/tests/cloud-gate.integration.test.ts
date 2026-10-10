import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type RunAgentInput,
} from "@ag-ui/client";
import { eq } from "drizzle-orm";
import { Observable, type Subscriber } from "rxjs";
import { chargeCents, type CloudRates } from "../../shared/cloud-pricing";
import { RunGateAgent } from "../src/accounts/run-gate";
import { createRunSlots } from "../src/accounts/run-slots";
import { createAccountStore } from "../src/accounts/store";
import type { RunLocation } from "../src/agents/profile-types";
import { createCloudGate } from "../src/cloud/gate";
import { createCloudMeter } from "../src/cloud/meter";
import {
  CloudRatesChanged,
  CloudRatesNotSet,
  createCloudStore,
} from "../src/cloud/store";
import type { CloudConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import {
  cloudIntervals,
  cloudRates,
  tenantMemberships,
  tenants,
  users,
} from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Whether a run may use the cloud, against a real database.
 *
 * What these protect is a promise to the person paying: nothing runs in the cloud, and nothing is
 * counted against them, unless they switched it on having seen the prices, and it stops at the limit
 * they set. And a coworker they set to run on their own computer is never run in the cloud instead.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const accounts = createAccountStore(database, { billingMode: "subscriptions" });
const slots = createRunSlots(database);
const store = createCloudStore(database);
const meter = createCloudMeter(database);

const RATES: CloudRates = {
  computeCentsPerHour: 60,
  storageCentsPerGbMonth: 10,
  egressCentsPerGb: 5,
  paymentFeePercent: 5,
  paymentFeeFixedCents: 50,
  marginPercent: 0,
  minimumChargeCents: 500,
};

const made: string[] = [];
const locations = new Map<string, RunLocation>();

async function person() {
  const id = `cloud-${randomUUID()}`;
  await database.insert(users).values({ id, email: `${id}@example.com` });
  made.push(id);
  const tenantId = await accounts.ensureTenant(id);
  await accounts.applySubscription(tenantId, {
    planId: "team",
    status: "active",
  });
  return { id, tenantId };
}

const config = (mode: CloudConfig["mode"]): CloudConfig => ({
  mode,
  volumeBytes: 0,
  defaultCapCents: 2000,
});

const gateFor = (
  mode: CloudConfig["mode"],
  hosted = true,
  now = () => new Date(),
) =>
  createCloudGate({
    config: config(mode),
    hosted,
    store,
    meter,
    runLocationOf: async (botId) => locations.get(botId) ?? "cloud",
    now,
  });

afterEach(async () => {
  locations.clear();
  for (const id of made.splice(0)) {
    const rows = await database
      .select({ tenantId: tenantMemberships.tenantId })
      .from(tenantMemberships)
      .where(eq(tenantMemberships.userId, id));
    await database.delete(users).where(eq(users.id, id));
    for (const row of rows)
      await database.delete(tenants).where(eq(tenants.id, row.tenantId));
  }
  await database.delete(cloudRates);
});
afterAll(async () => {
  await database.$client.close();
});

/** What a person reads once every link to the plan page is taken out, as a store app does. */
const withoutPurchaseLinks = (message: string) =>
  message.replace(/\s*\[[^\]]*\]\(\/settings\/plan[^)]*\)/g, "");

describe("the rules", () => {
  test("a deployment that has not decided to charge asks nobody anything, and runs", async () => {
    const who = await person();
    expect(
      await gateFor("included").check({ tenantId: who.tenantId, botId: "bot" }),
    ).toEqual({ ok: true });
  });

  test("a company's own deployment is never asked, whatever its mode", async () => {
    const who = await person();
    const decision = await gateFor("metered", false).check({
      tenantId: who.tenantId,
      botId: "bot",
    });
    expect(decision).toEqual({ ok: true });
  });

  test("off means off, for everybody", async () => {
    const who = await person();
    for (const hosted of [true, false]) {
      const decision = await gateFor("off", hosted).check({
        tenantId: who.tenantId,
        botId: "bot",
      });
      expect(decision).toMatchObject({ ok: false, code: "off" });
    }
  });

  test("a coworker set to run on the person's computer is not run in the cloud, and the refusal says how to change that", async () => {
    const who = await person();
    locations.set("mine", "device");
    const decision = await gateFor("included").check({
      tenantId: who.tenantId,
      botId: "mine",
    });
    expect(decision).toMatchObject({ ok: false, code: "on_device" });
    expect(decision.ok ? "" : decision.reason).toContain("(/settings/plan)");
    // On a company's own deployment the setting means nothing: the server is theirs.
    expect(
      await gateFor("included", false).check({
        tenantId: who.tenantId,
        botId: "mine",
      }),
    ).toEqual({ ok: true });
  });

  test("as an add-on, with nothing priced yet, it is not available and nobody is asked to agree to nothing", async () => {
    const who = await person();
    const decision = await gateFor("metered").check({
      tenantId: who.tenantId,
      botId: "bot",
    });
    expect(decision).toMatchObject({ ok: false, code: "no_rates" });
  });

  test("as an add-on, an account that has not switched it on is refused, and told where", async () => {
    const who = await person();
    await store.setRates(RATES, who.id);
    const decision = await gateFor("metered").check({
      tenantId: who.tenantId,
      botId: "bot",
    });
    expect(decision).toMatchObject({ ok: false, code: "not_enabled" });
    expect(decision.ok ? "" : decision.reason).toContain("(/settings/plan)");
    expect(decision.ok ? "" : withoutPurchaseLinks(decision.reason)).toBe(
      "Running in Ark's cloud is not switched on for this account. You can also run this digital employee on your own computer.",
    );
  });

  test("switched on, it runs; switched off again, it does not", async () => {
    const who = await person();
    await store.setRates(RATES, who.id);
    await store.enable(who.tenantId, {
      monthlyCapCents: 1000,
      shownRates: RATES,
    });
    const gate = gateFor("metered");
    expect(await gate.check({ tenantId: who.tenantId, botId: "bot" })).toEqual({
      ok: true,
    });
    await store.disable(who.tenantId);
    expect(
      await gate.check({ tenantId: who.tenantId, botId: "bot" }),
    ).toMatchObject({ code: "not_enabled" });
  });

  test("it stops at the limit the person set, and not before", async () => {
    const who = await person();
    await store.setRates(RATES, who.id);
    // 60 cents an hour, 5% + 50 fee: a charge of 100 cents costs about 52 cents of running.
    await store.enable(who.tenantId, {
      monthlyCapCents: 200,
      shownRates: RATES,
      at: new Date("2026-10-01T00:00:00Z"),
    });
    const now = new Date("2026-10-15T12:00:00Z");
    const gate = gateFor("metered", true, () => now);

    await meter.runStarted({
      tenantId: who.tenantId,
      botId: "bot",
      runId: "r1",
      at: new Date("2026-10-10T10:00:00Z"),
    });
    await meter.runEnded("r1", new Date("2026-10-10T11:00:00Z")); // one hour: charge about 117 cents
    expect(await gate.check({ tenantId: who.tenantId, botId: "bot" })).toEqual({
      ok: true,
    });

    await meter.runStarted({
      tenantId: who.tenantId,
      botId: "bot",
      runId: "r2",
      at: new Date("2026-10-11T10:00:00Z"),
    });
    await meter.runEnded("r2", new Date("2026-10-11T13:00:00Z")); // four hours: over 200
    const decision = await gate.check({ tenantId: who.tenantId, botId: "bot" });
    expect(decision).toMatchObject({ ok: false, code: "cap_reached" });

    // Next month it is a new allowance.
    const november = gateFor(
      "metered",
      true,
      () => new Date("2026-11-02T00:00:00Z"),
    );
    expect(
      await november.check({ tenantId: who.tenantId, botId: "bot" }),
    ).toEqual({ ok: true });
  });

  test("another account's usage is not mine", async () => {
    const mine = await person();
    const theirs = await person();
    await store.setRates(RATES, mine.id);
    await store.enable(mine.tenantId, {
      monthlyCapCents: 200,
      shownRates: RATES,
      at: new Date("2026-10-01T00:00:00Z"),
    });
    await meter.runStarted({
      tenantId: theirs.tenantId,
      botId: "x",
      runId: "theirs",
      at: new Date("2026-10-10T00:00:00Z"),
    });
    await meter.runEnded("theirs", new Date("2026-10-10T23:00:00Z"));
    const gate = gateFor(
      "metered",
      true,
      () => new Date("2026-10-15T00:00:00Z"),
    );
    expect(await gate.check({ tenantId: mine.tenantId, botId: "bot" })).toEqual(
      { ok: true },
    );
  });
});

describe("agreeing to the prices", () => {
  test("cannot be done before there are prices", async () => {
    const who = await person();
    await expect(
      store.enable(who.tenantId, { monthlyCapCents: 1000, shownRates: RATES }),
    ).rejects.toBeInstanceOf(CloudRatesNotSet);
  });

  test("is an agreement to the prices that were on the screen: if they moved, it does not happen", async () => {
    const who = await person();
    await store.setRates(RATES, who.id);
    await store.setRates({ ...RATES, computeCentsPerHour: 90 }, who.id);
    await expect(
      store.enable(who.tenantId, { monthlyCapCents: 1000, shownRates: RATES }),
    ).rejects.toBeInstanceOf(CloudRatesChanged);
    expect((await store.account(who.tenantId)).enabled).toBe(false);
  });

  test("records what they agreed to, whatever the prices later become", async () => {
    const who = await person();
    await store.setRates(RATES, who.id);
    await store.enable(who.tenantId, {
      monthlyCapCents: 1500,
      shownRates: RATES,
    });
    await store.setRates({ ...RATES, computeCentsPerHour: 90 }, who.id);
    const account = await store.account(who.tenantId);
    expect(account.consentedRates?.computeCentsPerHour).toBe(60);
    expect(account.monthlyCapCents).toBe(1500);
    expect(account.consentedAt).toBeInstanceOf(Date);
  });
});

describe("when staff change the prices", () => {
  const DEARER = { ...RATES, computeCentsPerHour: 120 };
  const OCTOBER = new Date("2026-10-01T00:00:00Z");
  const hour = async (tenantId: string, runId: string, day: string) => {
    await meter.runStarted({
      tenantId,
      botId: "bot",
      runId,
      at: new Date(`${day}T10:00:00Z`),
    });
    await meter.runEnded(runId, new Date(`${day}T11:00:00Z`));
  };

  test("nothing new runs until the person has agreed to the new prices", async () => {
    const who = await person();
    await store.setRates(RATES, who.id);
    await store.enable(who.tenantId, {
      monthlyCapCents: 5000,
      shownRates: RATES,
      at: OCTOBER,
    });
    const gate = gateFor(
      "metered",
      true,
      () => new Date("2026-10-15T12:00:00Z"),
    );
    expect(await gate.check({ tenantId: who.tenantId, botId: "bot" })).toEqual({
      ok: true,
    });

    await store.setRates(DEARER, who.id);
    const decision = await gate.check({ tenantId: who.tenantId, botId: "bot" });
    expect(decision).toMatchObject({ ok: false, code: "rates_changed" });
    expect((decision as { reason: string }).reason).toContain("/settings/plan");
    expect((await gate.status(who.tenantId)).ratesChanged).toBe(true);

    await store.enable(who.tenantId, {
      monthlyCapCents: 5000,
      shownRates: DEARER,
      at: new Date("2026-10-15T00:00:00Z"),
    });
    expect(await gate.check({ tenantId: who.tenantId, botId: "bot" })).toEqual({
      ok: true,
    });
    expect((await gate.status(who.tenantId)).ratesChanged).toBe(false);
  });

  test("what was used before they agreed to the new prices stays at the old ones, and counts against the limit at them", async () => {
    const who = await person();
    await store.setRates(RATES, who.id);
    await store.enable(who.tenantId, {
      monthlyCapCents: 5000,
      shownRates: RATES,
      at: OCTOBER,
    });
    await hour(who.tenantId, "before", "2026-10-05");
    await store.setRates(DEARER, who.id);
    await store.enable(who.tenantId, {
      monthlyCapCents: 5000,
      shownRates: DEARER,
      at: new Date("2026-10-10T00:00:00Z"),
    });
    await hour(who.tenantId, "after", "2026-10-12");

    const status = await gateFor(
      "metered",
      true,
      () => new Date("2026-10-15T12:00:00Z"),
    ).status(who.tenantId);
    // One hour at 60 and one at 120, with one fee: not two hours at either.
    const oneHour = {
      computeSeconds: 3600,
      storageByteSeconds: 0,
      egressBytes: 0,
    };
    expect(status.hours).toBe(2);
    expect(status.chargeSoFarCents).toBe(
      Math.ceil((60 + 120 + RATES.paymentFeeFixedCents) / 0.95),
    );
    expect(status.chargeSoFarCents).not.toBe(
      chargeCents({ ...oneHour, computeSeconds: 7200 }, RATES),
    );
    expect(status.chargeSoFarCents).not.toBe(
      chargeCents({ ...oneHour, computeSeconds: 7200 }, DEARER),
    );
  });

  test("agreeing again to the same prices is not a new agreement", async () => {
    const who = await person();
    await store.setRates(RATES, who.id);
    await store.enable(who.tenantId, {
      monthlyCapCents: 5000,
      shownRates: RATES,
      at: OCTOBER,
    });
    await store.disable(who.tenantId);
    await store.enable(who.tenantId, {
      monthlyCapCents: 3000,
      shownRates: RATES,
      at: new Date("2026-10-20T00:00:00Z"),
    });
    const account = await store.account(who.tenantId);
    expect(account.agreements).toHaveLength(1);
    expect(account.agreements[0]?.from).toEqual(OCTOBER);
    expect(account.agreements[0]?.until).toBeNull();
  });

  test("agreeing to different prices closes the old agreement where the new one begins", async () => {
    const who = await person();
    await store.setRates(RATES, who.id);
    await store.enable(who.tenantId, {
      monthlyCapCents: 5000,
      shownRates: RATES,
      at: OCTOBER,
    });
    await store.setRates(DEARER, who.id);
    const second = new Date("2026-10-10T00:00:00Z");
    await store.enable(who.tenantId, {
      monthlyCapCents: 5000,
      shownRates: DEARER,
      at: second,
    });
    const { agreements } = await store.account(who.tenantId);
    expect(agreements).toHaveLength(2);
    expect(agreements[0]).toMatchObject({ from: OCTOBER, until: second });
    expect(agreements[0]?.rates.computeCentsPerHour).toBe(60);
    expect(agreements[1]).toMatchObject({ from: second, until: null });
    expect(agreements[1]?.rates.computeCentsPerHour).toBe(120);
  });

  test("an add-on never agreed to has nothing chargeable, whatever was recorded before it was one", async () => {
    const who = await person();
    await store.setRates(RATES, who.id);
    await hour(who.tenantId, "earlier", "2026-10-05");
    const status = await gateFor(
      "metered",
      true,
      () => new Date("2026-10-15T12:00:00Z"),
    ).status(who.tenantId);
    expect(status).toMatchObject({
      hours: 0,
      chargeSoFarCents: 0,
      enabled: false,
      ratesChanged: false,
    });
  });
});

/** A coworker whose run stays open until the test lets it finish. */
class FakeBot extends AbstractAgent {
  started = 0;
  constructor() {
    super({ agentId: "fake", description: "fake" });
  }
  run(input: RunAgentInput): Observable<BaseEvent> {
    this.started += 1;
    return new Observable((subscriber: Subscriber<BaseEvent>) => {
      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent);
      setTimeout(() => {
        subscriber.next({
          type: EventType.RUN_FINISHED,
          threadId: input.threadId,
          runId: input.runId,
        } as BaseEvent);
        subscriber.complete();
      }, 50);
    });
  }
  clone(): FakeBot {
    return this;
  }
}

const runInput = (): RunAgentInput =>
  ({
    threadId: `t-${randomUUID()}`,
    runId: `r-${randomUUID()}`,
    messages: [],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  }) as RunAgentInput;

async function runThroughGate(
  who: { id: string },
  mode: CloudConfig["mode"],
  bot = new FakeBot(),
) {
  const gate = new RunGateAgent(
    bot,
    { actorId: who.id, botId: "gated-bot" },
    {
      accounts,
      slots,
      pollMs: 20,
      heartbeatMs: 40,
      cloud: { gate: gateFor(mode), meter },
    },
  );
  const events: BaseEvent[] = [];
  const input = runInput();
  await new Promise<void>((resolve, reject) => {
    gate.run(input).subscribe({
      next: (event) => events.push(event),
      error: reject,
      complete: resolve,
    });
  });
  return { events, bot, runId: input.runId };
}

describe("in front of a real run", () => {
  test("a refused run never reaches the coworker, says why in the conversation, and holds no place", async () => {
    const who = await person();
    await store.setRates(RATES, who.id);
    const { events, bot } = await runThroughGate(who, "metered");
    expect(bot.started).toBe(0);
    const said = events
      .filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)
      .map((event) => (event as unknown as { delta: string }).delta)
      .join("");
    expect(said).toContain("not switched on");
    expect(said).toContain("(/settings/plan)");
    expect(
      events.some(
        (e) =>
          e.type === EventType.CUSTOM &&
          (e as unknown as { name: string }).name === "ark.cloud_refused",
      ),
    ).toBe(true);
    expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
    expect(await slots.activeBots(who.tenantId)).toBe(0);
  });

  test("a run that is allowed is recorded from its start to its end, and only that run", async () => {
    const who = await person();
    await store.setRates(RATES, who.id);
    await store.enable(who.tenantId, {
      monthlyCapCents: 5000,
      shownRates: RATES,
    });
    const { bot, runId } = await runThroughGate(who, "metered");
    expect(bot.started).toBe(1);
    const rows = await database
      .select()
      .from(cloudIntervals)
      .where(eq(cloudIntervals.tenantId, who.tenantId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: "run",
      ref: runId,
      botId: "gated-bot",
    });
    // Ended just after the run completes: the release is not awaited by the run itself.
    let ended = rows[0]?.endedAt ?? null;
    for (let attempt = 0; attempt < 50 && ended === null; attempt++) {
      await Bun.sleep(20);
      const [row] = await database
        .select({ endedAt: cloudIntervals.endedAt })
        .from(cloudIntervals)
        .where(eq(cloudIntervals.tenantId, who.tenantId));
      ended = row?.endedAt ?? null;
    }
    expect(ended).not.toBeNull();
  });

  test("a deployment where cloud running is included records it too, so cost is visible, and asks nothing", async () => {
    const who = await person();
    const { bot } = await runThroughGate(who, "included");
    expect(bot.started).toBe(1);
    const rows = await database
      .select()
      .from(cloudIntervals)
      .where(eq(cloudIntervals.tenantId, who.tenantId));
    expect(rows).toHaveLength(1);
  });
});
