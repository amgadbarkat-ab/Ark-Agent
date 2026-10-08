import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { CloudRates } from "../../shared/cloud-pricing";
import { createAccountStore } from "../src/accounts/store";
import { createCloudGate } from "../src/cloud/gate";
import { createCloudMeter } from "../src/cloud/meter";
import {
  adminCloudRoutes,
  type CloudAudit,
  cloudRoutes,
} from "../src/cloud/routes";
import { createCloudStore } from "../src/cloud/store";
import type { CloudConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import {
  cloudCharges,
  cloudRates,
  tenantMemberships,
  tenants,
  users,
} from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * The cloud screens' server side, against a real database: a person's switch, limit and bill, and
 * staff's rates, usage and settling.
 *
 * What is protected: nobody is switched on to something they were not shown; a number that moved
 * between the screen and the click is refused; one customer never sees or changes another's; and
 * only staff set a price or settle a charge.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const accounts = createAccountStore(database, { billingMode: "subscriptions" });
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
const config = (mode: CloudConfig["mode"]): CloudConfig => ({
  mode,
  volumeBytes: 0,
  defaultCapCents: 2000,
});

const events: Parameters<CloudAudit>[0][] = [];
const audit: CloudAudit = async (event) => {
  events.push(event);
};

/** Who is calling is named in a header, so one app can be several people. */
const requireUser: Parameters<typeof cloudRoutes>[0]["requireUser"] = async (
  context,
  next,
) => {
  const as = context.req.header("x-as");
  if (!as) return context.json({ error: "Sign in" }, 401);
  const [id, role] = as.split(":");
  context.set("actor", {
    id: id as string,
    email: `${id}@example.com`,
    role: role === "admin" ? "admin" : "user",
  });
  await next();
};

function build(mode: CloudConfig["mode"] = "metered") {
  const gate = createCloudGate({
    config: config(mode),
    hosted: true,
    store,
    meter,
    runLocationOf: async () => "cloud",
  });
  return new Hono()
    .route(
      "/api/account/cloud",
      cloudRoutes({ requireUser, accounts, gate, store, audit }),
    )
    .route(
      "/api/admin/cloud",
      adminCloudRoutes({
        requireUser,
        config: config(mode),
        store,
        meter,
        database,
        audit,
        now: () => new Date("2026-10-20T10:00:00Z"),
      }),
    );
}
const app = build();

const made: string[] = [];
async function person(
  options: { role?: "admin" | "user"; subscribed?: boolean } = {},
) {
  const id = `cr-${randomUUID()}`;
  await database.insert(users).values({ id, email: `${id}@example.com` });
  made.push(id);
  const tenantId = await accounts.ensureTenant(id);
  if (options.subscribed !== false) {
    await accounts.applySubscription(tenantId, {
      planId: "team",
      status: "active",
      provider: "paddle",
      providerCustomerId: "ctm_01abc",
      providerSubscriptionId: "sub_01abcdefghij",
    });
  }
  return { id, tenantId, as: `${id}:${options.role ?? "user"}` };
}
type Who = { as: string };
const call = (
  who: Who | null,
  method: string,
  path: string,
  body?: unknown,
  target: Hono = app,
) =>
  target.request(path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(who ? { "x-as": who.as } : {}),
    },
    ...(body === undefined
      ? {}
      : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });

const mine = async (who: Who) =>
  (await call(who, "GET", "/api/account/cloud")).json() as Promise<{
    cloud: {
      enabled: boolean;
      ratesChanged: boolean;
      rates: CloudRates;
    };
  }>;

afterEach(async () => {
  events.length = 0;
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

const priced = async (rates: CloudRates = RATES) => {
  const staff = await person({ role: "admin" });
  await store.setRates(rates, staff.id);
  return staff;
};

describe("switching cloud running on", () => {
  test("nothing is available to a person who is not signed in", async () => {
    for (const [method, path] of [
      ["GET", "/api/account/cloud"],
      ["POST", "/api/account/cloud/enable"],
      ["PUT", "/api/account/cloud/cap"],
      ["POST", "/api/account/cloud/disable"],
    ] as const) {
      expect((await call(null, method, path, {})).status).toBe(401);
    }
  });

  test("shows the prices and the month so far, and that it is not yet on", async () => {
    await priced();
    const ann = await person();
    const body = (await (
      await call(ann, "GET", "/api/account/cloud")
    ).json()) as {
      cloud: {
        addOn: boolean;
        priced: boolean;
        enabled: boolean;
        rates: CloudRates;
        defaultCapCents: number;
      };
      charges: unknown[];
      limits: { minCents: number; maxCents: number };
    };
    expect(body.cloud).toMatchObject({
      addOn: true,
      priced: true,
      enabled: false,
      defaultCapCents: 2000,
    });
    expect(body.cloud.rates).toEqual(RATES);
    expect(body.charges).toEqual([]);
    expect(body.limits.minCents).toBe(100);
  });

  test("is refused before anything is priced", async () => {
    const ann = await person();
    const response = await call(ann, "POST", "/api/account/cloud/enable", {
      monthlyCapCents: 2000,
      shownRates: RATES,
    });
    expect(response.status).toBe(409);
    expect((await store.account(ann.tenantId)).enabled).toBe(false);
  });

  test("records the prices the person was shown and the limit they chose, and says so in the trail", async () => {
    await priced();
    const ann = await person();
    const response = await call(ann, "POST", "/api/account/cloud/enable", {
      monthlyCapCents: 5000,
      shownRates: RATES,
    });
    expect(response.status).toBe(200);
    const saved = await store.account(ann.tenantId);
    expect(saved).toMatchObject({ enabled: true, monthlyCapCents: 5000 });
    expect(saved.consentedRates).toEqual(RATES);
    expect(saved.consentedAt).toBeInstanceOf(Date);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: "cloud.enabled",
      actorUserId: ann.id,
      targetId: ann.tenantId,
      payload: { monthlyCapCents: 5000, wasEnabled: false },
    });
  });

  test("is refused when the prices moved between the screen and the click", async () => {
    await priced();
    const ann = await person();
    const staff = await person({ role: "admin" });
    await store.setRates({ ...RATES, computeCentsPerHour: 90 }, staff.id);
    const response = await call(ann, "POST", "/api/account/cloud/enable", {
      monthlyCapCents: 5000,
      shownRates: RATES,
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ changed: true });
    expect((await store.account(ann.tenantId)).enabled).toBe(false);
  });

  test("needs a subscription in good standing, because the charge goes on it", async () => {
    await priced();
    const bob = await person({ subscribed: false });
    const response = await call(bob, "POST", "/api/account/cloud/enable", {
      monthlyCapCents: 5000,
      shownRates: RATES,
    });
    expect(response.status).toBe(409);
    expect((await store.account(bob.tenantId)).enabled).toBe(false);
  });

  test("a limit that is not whole cents between a euro and ten thousand, or a stray field, changes nothing", async () => {
    await priced();
    const ann = await person();
    for (const monthlyCapCents of [0, 99, 1_000_001, 12.5, "lots", null]) {
      const response = await call(ann, "POST", "/api/account/cloud/enable", {
        monthlyCapCents,
        shownRates: RATES,
      });
      expect(response.status).toBe(400);
    }
    expect(
      (
        await call(ann, "POST", "/api/account/cloud/enable", {
          monthlyCapCents: 5000,
          shownRates: RATES,
          enabled: true,
        })
      ).status,
    ).toBe(400);
    expect(
      (await call(ann, "POST", "/api/account/cloud/enable", "{not json"))
        .status,
    ).toBe(400);
    expect((await store.account(ann.tenantId)).enabled).toBe(false);
  });

  test("where cloud running is included, there is nothing to switch on", async () => {
    await priced();
    const ann = await person();
    const included = build("included");
    const response = await call(
      ann,
      "POST",
      "/api/account/cloud/enable",
      { monthlyCapCents: 5000, shownRates: RATES },
      included,
    );
    expect(response.status).toBe(400);
    expect((await store.account(ann.tenantId)).enabled).toBe(false);
  });

  test("agreeing again to the same prices keeps the first date, so nothing used since is dropped", async () => {
    await priced();
    const ann = await person();
    const enable = () =>
      call(ann, "POST", "/api/account/cloud/enable", {
        monthlyCapCents: 5000,
        shownRates: RATES,
      });
    await enable();
    const first = (await store.account(ann.tenantId)).consentedAt;
    await call(ann, "POST", "/api/account/cloud/disable");
    await Bun.sleep(15);
    await enable();
    expect((await store.account(ann.tenantId)).consentedAt).toEqual(first);

    // New prices are a new agreement, with a new date.
    await call(ann, "POST", "/api/account/cloud/disable");
    const staff = await person({ role: "admin" });
    const newer = { ...RATES, computeCentsPerHour: 70 };
    await store.setRates(newer, staff.id);
    await Bun.sleep(15);
    await call(ann, "POST", "/api/account/cloud/enable", {
      monthlyCapCents: 5000,
      shownRates: newer,
    });
    const second = await store.account(ann.tenantId);
    expect(second.consentedAt?.getTime()).toBeGreaterThan(
      first?.getTime() ?? 0,
    );
    expect(second.consentedRates).toEqual(newer);
  });
});

describe("when staff change the prices under a switch that is on", () => {
  test("the customer is told, can agree to the new ones, and what they agreed to before is kept", async () => {
    const staff = await priced();
    const ann = await person();
    await call(ann, "POST", "/api/account/cloud/enable", {
      monthlyCapCents: 5000,
      shownRates: RATES,
    });
    const dearer = { ...RATES, computeCentsPerHour: 90 };
    await store.setRates(dearer, staff.id);

    const status = await mine(ann);
    expect(status.cloud).toMatchObject({ enabled: true, ratesChanged: true });
    expect(status.cloud.rates.computeCentsPerHour).toBe(90);

    // The old prices can no longer be agreed to; the new ones can.
    expect(
      (
        await call(ann, "POST", "/api/account/cloud/enable", {
          monthlyCapCents: 5000,
          shownRates: RATES,
        })
      ).status,
    ).toBe(409);
    events.length = 0;
    expect(
      (
        await call(ann, "POST", "/api/account/cloud/enable", {
          monthlyCapCents: 5000,
          shownRates: dearer,
        })
      ).status,
    ).toBe(200);
    expect(events[0]).toMatchObject({
      eventType: "cloud.enabled",
      payload: { wasEnabled: true, rates: dearer },
    });
    expect((await mine(ann)).cloud.ratesChanged).toBe(false);
    const { agreements } = await store.account(ann.tenantId);
    expect(agreements.map((a) => a.rates.computeCentsPerHour)).toEqual([
      60, 90,
    ]);
    expect(agreements[0]?.until).toEqual(agreements[1]?.from);
  });
});

describe("the limit and switching it off", () => {
  test("a limit is set only on an account that has it on, and the change is in the trail", async () => {
    await priced();
    const ann = await person();
    expect(
      (
        await call(ann, "PUT", "/api/account/cloud/cap", {
          monthlyCapCents: 3000,
        })
      ).status,
    ).toBe(409);
    await call(ann, "POST", "/api/account/cloud/enable", {
      monthlyCapCents: 5000,
      shownRates: RATES,
    });
    events.length = 0;
    const response = await call(ann, "PUT", "/api/account/cloud/cap", {
      monthlyCapCents: 3000,
    });
    expect(response.status).toBe(200);
    expect((await store.account(ann.tenantId)).monthlyCapCents).toBe(3000);
    expect(events).toEqual([
      expect.objectContaining({
        eventType: "cloud.cap_changed",
        payload: { from: 5000, to: 3000 },
      }),
    ]);
    expect(
      (
        await call(ann, "PUT", "/api/account/cloud/cap", {
          monthlyCapCents: 50,
        })
      ).status,
    ).toBe(400);
  });

  test("switching off stops new cloud runs at once, and is a no-op the second time", async () => {
    await priced();
    const ann = await person();
    await call(ann, "POST", "/api/account/cloud/enable", {
      monthlyCapCents: 5000,
      shownRates: RATES,
    });
    events.length = 0;
    expect((await call(ann, "POST", "/api/account/cloud/disable")).status).toBe(
      200,
    );
    expect((await store.account(ann.tenantId)).enabled).toBe(false);
    expect((await call(ann, "POST", "/api/account/cloud/disable")).status).toBe(
      200,
    );
    expect(events.map((event) => event.eventType)).toEqual(["cloud.disabled"]);
  });
});

describe("one customer and another", () => {
  test("a customer sees and changes only their own account", async () => {
    await priced();
    const ann = await person();
    const bob = await person();
    await call(ann, "POST", "/api/account/cloud/enable", {
      monthlyCapCents: 5000,
      shownRates: RATES,
    });
    await database.insert(cloudCharges).values({
      tenantId: ann.tenantId,
      period: "2026-09",
      status: "charged",
      usage: { computeSeconds: 3600, storageByteSeconds: 0, egressBytes: 0 },
      rates: RATES,
      costCents: "60",
      amountCents: 123,
      providerRef: "paddle:sub_01abcdefghij:secret-reference",
    });

    const bobs = (await (
      await call(bob, "GET", "/api/account/cloud")
    ).json()) as {
      cloud: { enabled: boolean };
      charges: unknown[];
    };
    expect(bobs.cloud.enabled).toBe(false);
    expect(bobs.charges).toEqual([]);
    await call(bob, "PUT", "/api/account/cloud/cap", { monthlyCapCents: 100 });
    expect((await store.account(ann.tenantId)).monthlyCapCents).toBe(5000);
    expect((await call(bob, "POST", "/api/account/cloud/disable")).status).toBe(
      200,
    );
    expect((await store.account(ann.tenantId)).enabled).toBe(true);

    const anns = (await (
      await call(ann, "GET", "/api/account/cloud")
    ).json()) as {
      charges: { period: string; status: string; amountCents: number }[];
    };
    expect(anns.charges).toHaveLength(1);
    expect(anns.charges[0]).toMatchObject({
      period: "2026-09",
      status: "charged",
      amountCents: 123,
    });
    // The payment provider's own references and our notes are not the customer's to read.
    expect(JSON.stringify(anns)).not.toContain("secret-reference");
    expect(JSON.stringify(anns)).not.toContain("sub_01abcdefghij");
  });

  test("a month the machine is unsure of is shown as being checked, not as a failure", async () => {
    await priced();
    const ann = await person();
    await database.insert(cloudCharges).values({
      tenantId: ann.tenantId,
      period: "2026-09",
      status: "uncertain",
      usage: { computeSeconds: 3600, storageByteSeconds: 0, egressBytes: 0 },
      rates: RATES,
      costCents: "60",
      amountCents: 123,
      note: "The payment service did not say whether it took the charge.",
    });
    const body = (await (
      await call(ann, "GET", "/api/account/cloud")
    ).json()) as {
      charges: { status: string }[];
    };
    expect(body.charges[0]?.status).toBe("checking");
    expect(JSON.stringify(body)).not.toContain("did not say");
  });
});

describe("what staff do", () => {
  test("only staff reach any of it", async () => {
    const ann = await person();
    for (const [method, path, body] of [
      ["GET", "/api/admin/cloud/rates", undefined],
      ["PUT", "/api/admin/cloud/rates", RATES],
      ["GET", "/api/admin/cloud/usage", undefined],
      ["GET", "/api/admin/cloud/charges", undefined],
      [
        "POST",
        `/api/admin/cloud/charges/${randomUUID()}/settle`,
        { outcome: "waived", note: "no" },
      ],
    ] as const) {
      expect((await call(null, method, path, body)).status).toBe(401);
      expect((await call(ann, method, path, body)).status).toBe(403);
    }
    expect(await store.rates()).toBeNull();
  });

  test("sets the prices, refusing nonsense, and writes down what they were and became", async () => {
    const staff = await person({ role: "admin" });
    for (const bad of [
      { ...RATES, computeCentsPerHour: 0 },
      { ...RATES, computeCentsPerHour: -1 },
      { ...RATES, computeCentsPerHour: 99_999 },
      { ...RATES, paymentFeePercent: 80 },
      { ...RATES, surprise: 1 },
      { computeCentsPerHour: 60 },
      [],
      "rates",
    ]) {
      expect(
        (await call(staff, "PUT", "/api/admin/cloud/rates", bad)).status,
      ).toBe(400);
    }
    expect(await store.rates()).toBeNull();

    expect(
      (await call(staff, "PUT", "/api/admin/cloud/rates", RATES)).status,
    ).toBe(200);
    expect(await store.rates()).toEqual(RATES);
    const next = { ...RATES, marginPercent: 10 };
    await call(staff, "PUT", "/api/admin/cloud/rates", next);
    expect(events.at(-1)).toMatchObject({
      eventType: "cloud.rates_set",
      payload: { from: RATES, to: next },
    });
    const read = (await (
      await call(staff, "GET", "/api/admin/cloud/rates")
    ).json()) as { rates: CloudRates; mode: string };
    expect(read).toMatchObject({ rates: next, mode: "metered" });
  });

  test("shows what each account used in a month and what it cost, most expensive first", async () => {
    const staff = await priced();
    const ann = await person();
    const bob = await person();
    const start = (who: { tenantId: string }) =>
      meter.runStarted({
        tenantId: who.tenantId,
        botId: `bot-${who.tenantId}`,
        runId: `run-${randomUUID()}`,
        at: new Date("2026-09-10T08:00:00Z"),
      });
    await start(ann);
    await start(bob);
    const ids = await database.execute<{ id: string }>(
      `select ref as id from cloud_intervals where tenant_id in ('${ann.tenantId}','${bob.tenantId}')`,
    );
    expect(ids.length).toBe(2);
    // Two hours for Ann, one for Bob.
    await meter.runEnded(
      (ids[0] as { id: string }).id,
      new Date("2026-09-10T09:00:00Z"),
    );
    await meter.runEnded(
      (ids[1] as { id: string }).id,
      new Date("2026-09-10T10:00:00Z"),
    );
    const body = (await (
      await call(staff, "GET", "/api/admin/cloud/usage?period=2026-09")
    ).json()) as {
      period: string;
      priced: boolean;
      totals: { hours: number; costCents: number };
      accounts: { tenantId: string; hours: number; costCents: number }[];
    };
    expect(body.period).toBe("2026-09");
    expect(body.priced).toBe(true);
    expect(body.accounts.map((row) => row.tenantId).sort()).toEqual(
      [ann.tenantId, bob.tenantId].sort(),
    );
    expect(body.totals.hours).toBeCloseTo(3, 5);
    expect(body.totals.costCents).toBeCloseTo(180, 5);
    expect(body.accounts[0]?.costCents).toBeGreaterThanOrEqual(
      body.accounts[1]?.costCents ?? 0,
    );
    expect(
      (await call(staff, "GET", "/api/admin/cloud/usage?period=Oct-2026"))
        .status,
    ).toBe(400);
  });

  test("lists charges, by status, and settles one the machine could not, once, with a reason in the trail", async () => {
    const staff = await priced();
    const ann = await person();
    const [uncertain] = await database
      .insert(cloudCharges)
      .values({
        tenantId: ann.tenantId,
        period: "2026-09",
        status: "uncertain",
        usage: { computeSeconds: 3600, storageByteSeconds: 0, egressBytes: 0 },
        rates: RATES,
        costCents: "60",
        amountCents: 123,
      })
      .returning({ id: cloudCharges.id });
    await database.insert(cloudCharges).values({
      tenantId: ann.tenantId,
      period: "2026-08",
      status: "charged",
      usage: { computeSeconds: 3600, storageByteSeconds: 0, egressBytes: 0 },
      rates: RATES,
      costCents: "60",
      amountCents: 100,
    });
    const listed = async (query = "") =>
      (await (
        await call(staff, "GET", `/api/admin/cloud/charges${query}`)
      ).json()) as {
        charges: { id: string; status: string; tenantName: string }[];
      };
    expect((await listed()).charges).toHaveLength(2);
    const only = await listed("?status=uncertain");
    expect(only.charges.map((charge) => charge.status)).toEqual(["uncertain"]);
    expect(only.charges[0]?.tenantName.length).toBeGreaterThan(0);
    expect(
      (await call(staff, "GET", "/api/admin/cloud/charges?status=bogus"))
        .status,
    ).toBe(400);

    const id = (uncertain as { id: string }).id;
    expect(
      (
        await call(staff, "POST", `/api/admin/cloud/charges/${id}/settle`, {
          outcome: "charged",
        })
      ).status,
    ).toBe(400);
    const settle = (outcome: "charged" | "waived") =>
      call(staff, "POST", `/api/admin/cloud/charges/${id}/settle`, {
        outcome,
        note: "Paddle shows it taken on 2026-10-02",
      });
    expect((await settle("charged")).status).toBe(200);
    expect(events.at(-1)).toMatchObject({
      eventType: "cloud.charge_settled",
      targetId: id,
      payload: { outcome: "charged" },
    });
    // Final: a second answer, even the opposite one, does not change it.
    expect((await settle("waived")).status).toBe(409);
    const [after] = await database
      .select({ status: cloudCharges.status })
      .from(cloudCharges)
      .where(eq(cloudCharges.id, id));
    expect(after?.status).toBe("charged");
    expect(
      (
        await call(staff, "POST", "/api/admin/cloud/charges/not-an-id/settle", {
          outcome: "waived",
          note: "reason given",
        })
      ).status,
    ).toBe(404);
  });
});
