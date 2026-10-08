import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { chargeCents, type CloudRates } from "../../shared/cloud-pricing";
import { createAccountStore } from "../src/accounts/store";
import {
  BillingChargeUncertain,
  type BillingProvider,
  BillingUnavailableError,
} from "../src/billing/provider";
import { chargePeriod, settleCharge } from "../src/cloud/charging";
import { createCloudMeter } from "../src/cloud/meter";
import { createCloudStore } from "../src/cloud/store";
import { createDatabase } from "../src/db/client";
import {
  cloudAccounts,
  cloudCharges,
  cloudRates,
  tenantMemberships,
  tenants,
  users,
} from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Charging a month of cloud running, against a real database and a payment provider that can be
 * told to refuse, to lose its answer, or to take its time.
 *
 * The property that matters above the others: a month is charged at most once. Every other test here
 * is a way of trying to make it twice.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const accounts = createAccountStore(database, { billingMode: "subscriptions" });
const meter = createCloudMeter(database);
const store = createCloudStore(database);

const RATES: CloudRates = {
  computeCentsPerHour: 100,
  storageCentsPerGbMonth: 0,
  egressCentsPerGb: 0,
  paymentFeePercent: 5,
  paymentFeeFixedCents: 50,
  marginPercent: 0,
  minimumChargeCents: 500,
};

const NOW = () => new Date("2026-11-03T09:00:00Z");
const made: string[] = [];

async function customer(
  options: { consent?: Date | null; subscription?: boolean } = {},
) {
  const id = `charge-${randomUUID()}`;
  await database.insert(users).values({ id, email: `${id}@example.com` });
  made.push(id);
  const tenantId = await accounts.ensureTenant(id);
  await accounts.applySubscription(tenantId, {
    planId: "team",
    status: "active",
    provider: "paddle",
    ...(options.subscription === false
      ? {}
      : {
          providerCustomerId: "ctm_01abc",
          providerSubscriptionId: `sub_${randomUUID().replaceAll("-", "").slice(0, 20)}`,
        }),
  });
  const consent =
    options.consent === undefined
      ? new Date("2026-09-01T00:00:00Z")
      : options.consent;
  if (consent) {
    await database.insert(cloudAccounts).values({
      tenantId,
      enabled: true,
      monthlyCapCents: 100_000,
      consentedAt: consent,
      consentedRates: RATES,
    });
  }
  return { id, tenantId };
}

/** Hours of work in a month: one run, ending a number of hours after it began. */
async function work(tenantId: string, day: string, hours: number) {
  const runId = `run-${randomUUID()}`;
  const start = new Date(`${day}T08:00:00Z`);
  await meter.runStarted({ tenantId, botId: "bot", runId, at: start });
  await meter.runEnded(runId, new Date(start.getTime() + hours * 3_600_000));
}

type Behaviour = "ok" | "refuse" | "uncertain" | "slow";
function fakeBilling(behave: () => Behaviour = () => "ok") {
  const charges: {
    subscriptionId: string;
    amountCents: number;
    description: string;
  }[] = [];
  const billing: BillingProvider = {
    id: "paddle",
    createCheckout: async () => ({ url: "x" }),
    parseWebhook: () => [],
    charge: async (subscriptionId, request) => {
      charges.push({ subscriptionId, ...request });
      const how = behave();
      if (how === "slow") await Bun.sleep(60);
      if (how === "refuse") throw new BillingUnavailableError("no");
      if (how === "uncertain") throw new BillingChargeUncertain();
      return { reference: `ref-${charges.length}` };
    },
  };
  return { billing, charges };
}

const deps = (billing: BillingProvider) => ({
  database,
  meter,
  store,
  billing,
  accounts,
  now: NOW,
});

afterEach(async () => {
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

const rowsOf = (tenantId: string) =>
  database
    .select()
    .from(cloudCharges)
    .where(eq(cloudCharges.tenantId, tenantId));

describe("a month", () => {
  test("is charged once, at the amount that covers its cost and the payment fee", async () => {
    const who = await customer();
    await store.setRates(RATES, who.id);
    await work(who.tenantId, "2026-10-05", 10); // 10 hours at 100 cents: cost 1000
    const { billing, charges } = fakeBilling();

    const report = await chargePeriod(deps(billing), "2026-10", who.tenantId);

    expect(report).toMatchObject({
      charged: 1,
      chargedCents: chargeCents(
        { computeSeconds: 36_000, storageByteSeconds: 0, egressBytes: 0 },
        RATES,
      ),
    });
    expect(charges).toHaveLength(1);
    expect(charges[0]?.description).toBe("Ark cloud running, October 2026");
    expect(charges[0]?.amountCents).toBe(Math.ceil((1000 + 50) / 0.95));
    const [row] = await rowsOf(who.tenantId);
    expect(row).toMatchObject({
      status: "charged",
      period: "2026-10",
      providerRef: "ref-1",
    });
    expect(row?.usage.computeSeconds).toBe(36_000);
    expect(row?.rates.computeCentsPerHour).toBe(100);
  });

  test("run again, it is not charged again, nor when run twice at once", async () => {
    const who = await customer();
    await store.setRates(RATES, who.id);
    await work(who.tenantId, "2026-10-05", 10);
    const { billing, charges } = fakeBilling(() => "slow");

    await Promise.all([
      chargePeriod(deps(billing), "2026-10", who.tenantId),
      chargePeriod(deps(billing), "2026-10", who.tenantId),
      chargePeriod(deps(billing), "2026-10", who.tenantId),
    ]);
    await chargePeriod(deps(billing), "2026-10", who.tenantId);

    expect(charges).toHaveLength(1);
    expect(await rowsOf(who.tenantId)).toHaveLength(1);
  });

  test("that has not ended cannot be charged", async () => {
    const who = await customer();
    await store.setRates(RATES, who.id);
    const { billing } = fakeBilling();
    await expect(chargePeriod(deps(billing), "2026-11")).rejects.toThrow(
      /has ended/,
    );
    await expect(chargePeriod(deps(billing), "2026-12")).rejects.toThrow(
      /has ended/,
    );
  });

  test("with no prices set, nothing is charged to anybody", async () => {
    const who = await customer();
    await work(who.tenantId, "2026-10-05", 10);
    const { billing, charges } = fakeBilling();
    const report = await chargePeriod(deps(billing), "2026-10");
    expect(report.charged).toBe(0);
    expect(charges).toHaveLength(0);
  });

  test("of an account that never agreed to pay is not charged, however much it used", async () => {
    const who = await customer({ consent: null });
    await store.setRates(RATES, who.id);
    await work(who.tenantId, "2026-10-05", 50);
    const { billing, charges } = fakeBilling();
    await chargePeriod(deps(billing), "2026-10");
    expect(charges).toHaveLength(0);
  });

  test("counts only what happened after they agreed", async () => {
    const who = await customer({ consent: new Date("2026-10-20T00:00:00Z") });
    await store.setRates(RATES, who.id);
    await work(who.tenantId, "2026-10-05", 40); // before: never charged
    await work(who.tenantId, "2026-10-25", 10); // after
    const { billing, charges } = fakeBilling();
    await chargePeriod(deps(billing), "2026-10", who.tenantId);
    expect(charges[0]?.amountCents).toBe(Math.ceil((1000 + 50) / 0.95));
  });

  test("of an account that used nothing is no row and no charge", async () => {
    const who = await customer();
    await store.setRates(RATES, who.id);
    const { billing, charges } = fakeBilling();
    await chargePeriod(deps(billing), "2026-10", who.tenantId);
    expect(charges).toHaveLength(0);
    expect(await rowsOf(who.tenantId)).toHaveLength(0);
  });
});

describe("a month too small to send", () => {
  test("is carried, and rides with the next month so one fee is paid, not two", async () => {
    const who = await customer();
    await store.setRates(RATES, who.id);
    await work(who.tenantId, "2026-09-10", 1); // cost 100, charge ~158: under the 500 minimum
    const { billing, charges } = fakeBilling();

    const first = await chargePeriod(deps(billing), "2026-09", who.tenantId);
    expect(first).toMatchObject({ carried: 1, charged: 0 });
    expect(charges).toHaveLength(0);
    expect((await rowsOf(who.tenantId))[0]).toMatchObject({
      status: "carried",
      amountCents: 0,
    });

    await work(who.tenantId, "2026-10-10", 9); // cost 900
    const second = await chargePeriod(deps(billing), "2026-10", who.tenantId);
    expect(second.charged).toBe(1);
    // 100 carried + 900 this month = 1000 of cost, one fee.
    expect(charges[0]?.amountCents).toBe(Math.ceil((1000 + 50) / 0.95));
    const rows = await rowsOf(who.tenantId);
    expect(rows.every((row) => row.status === "charged")).toBe(true);

    // And the carried month is not carried a second time.
    await chargePeriod(deps(billing), "2026-10", who.tenantId);
    expect(charges).toHaveLength(1);
  });
});

describe("when the payment service says no", () => {
  test("a refused charge is tried again next run, and only taken when it goes through", async () => {
    const who = await customer();
    await store.setRates(RATES, who.id);
    await work(who.tenantId, "2026-10-05", 10);
    let behaviour: Behaviour = "refuse";
    const { billing, charges } = fakeBilling(() => behaviour);

    const first = await chargePeriod(deps(billing), "2026-10", who.tenantId);
    expect(first).toMatchObject({ pending: 1, charged: 0 });
    expect((await rowsOf(who.tenantId))[0]?.status).toBe("pending");

    behaviour = "ok";
    const second = await chargePeriod(deps(billing), "2026-10", who.tenantId);
    expect(second.charged).toBe(1);
    expect(charges).toHaveLength(2); // one refused, one taken
    expect((await rowsOf(who.tenantId))[0]?.status).toBe("charged");
  });

  test("a charge whose answer was lost is never sent again, however often the job runs", async () => {
    const who = await customer();
    await store.setRates(RATES, who.id);
    await work(who.tenantId, "2026-10-05", 10);
    let behaviour: Behaviour = "uncertain";
    const { billing, charges } = fakeBilling(() => behaviour);

    const first = await chargePeriod(deps(billing), "2026-10", who.tenantId);
    expect(first.uncertain).toBe(1);
    behaviour = "ok";
    for (let i = 0; i < 3; i++)
      await chargePeriod(deps(billing), "2026-10", who.tenantId);

    expect(charges).toHaveLength(1);
    expect((await rowsOf(who.tenantId))[0]?.status).toBe("uncertain");
  });

  test("a charge that was being sent when the process died is not sent again either", async () => {
    const who = await customer();
    await store.setRates(RATES, who.id);
    await work(who.tenantId, "2026-10-05", 10);
    // What a crash between writing the row and hearing back leaves behind.
    await database.insert(cloudCharges).values({
      tenantId: who.tenantId,
      period: "2026-10",
      status: "charging",
      usage: { computeSeconds: 36_000, storageByteSeconds: 0, egressBytes: 0 },
      rates: RATES,
      costCents: "1000",
      amountCents: 1105,
    });
    const { billing, charges } = fakeBilling();
    await chargePeriod(deps(billing), "2026-10", who.tenantId);
    expect(charges).toHaveLength(0);
  });

  test("a person settles an uncertain month by hand, and it is final", async () => {
    const who = await customer();
    await store.setRates(RATES, who.id);
    await work(who.tenantId, "2026-10-05", 10);
    const { billing } = fakeBilling(() => "uncertain");
    await chargePeriod(deps(billing), "2026-10", who.tenantId);
    const [row] = await rowsOf(who.tenantId);

    expect(
      await settleCharge(
        database,
        row?.id as string,
        "charged",
        "Checked at Paddle: it was taken.",
      ),
    ).toBe(true);
    expect((await rowsOf(who.tenantId))[0]).toMatchObject({
      status: "charged",
      note: "Checked at Paddle: it was taken.",
    });
    // Final: settling again, or the other way, does nothing.
    expect(
      await settleCharge(
        database,
        row?.id as string,
        "waived",
        "changed my mind",
      ),
    ).toBe(false);
    expect((await rowsOf(who.tenantId))[0]?.status).toBe("charged");
  });

  test("an account with no subscription at the payment service waits, with the reason, and nothing is sent", async () => {
    const who = await customer({ subscription: false });
    await store.setRates(RATES, who.id);
    await work(who.tenantId, "2026-10-05", 10);
    const { billing, charges } = fakeBilling();
    const report = await chargePeriod(deps(billing), "2026-10", who.tenantId);
    expect(report.pending).toBe(1);
    expect(charges).toHaveLength(0);
    expect((await rowsOf(who.tenantId))[0]?.note).toMatch(/no subscription/i);
  });
});
