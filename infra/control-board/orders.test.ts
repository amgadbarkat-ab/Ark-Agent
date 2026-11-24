import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { readAudit } from "./audit";
import { casesExtension, getCase, notes } from "./cases";
import { appIntake, signIntake } from "./intake";
import { appOrders } from "./orders";
import { ORIGIN, type TestBoard, testBoard } from "./test-helpers";

const SECRET = "intake-secret-for-tests-0123456789abcdef";
let current: TestBoard | null = null;
afterEach(() => {
  current?.cleanup();
  current = null;
});

async function setup() {
  const t = await testBoard((sql, clock) => [
    casesExtension(sql, { githubRepo: "example/repo" }),
    appIntake(sql, { secret: SECRET, now: () => clock.now }),
    appOrders(sql, { secret: SECRET, now: () => clock.now }),
  ]);
  current = t;
  await t.addAccount("maria", "support");
  const browser = t.browser();
  await browser.signIn("maria", t.code("maria"));
  return { t, browser };
}

function signed(t: TestBoard, path: string, value: unknown) {
  const body = JSON.stringify(value);
  const time = String(Math.floor(t.clock.now / 1000));
  const nonce = randomBytes(18).toString("base64url");
  return t.board.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ark-time": time,
        "x-ark-nonce": nonce,
        "x-ark-signature": signIntake(SECRET, time, nonce, body),
      },
      body,
    }),
  );
}

/** What blackark.uk's Stripe webhook sends. */
function order(event: string, over: Record<string, unknown> = {}) {
  return {
    kind: "support_247",
    event,
    customerId: "demo-shop",
    subscriptionId: "sub_sup_1",
    status: "active",
    startedAt: "2026-11-18T10:00:00Z",
    paidUntil: "2026-12-18T10:00:00Z",
    licence: "team (active)",
    ...(event === "started"
      ? {
          name: "Maria Papadopoulou",
          company: "Demo Shop IKE",
          email: "maria@shop.example",
        }
      : {}),
    ...over,
  };
}

function request(t: TestBoard, over: Record<string, unknown> = {}) {
  return signed(t, "/intake/app", {
    requestId: randomUUID(),
    customerId: "demo-shop",
    installId: "aaaa1111-0000-4000-8000-000000000001",
    appVersion: "0.1.53",
    language: "el",
    subject: "Το Gmail δεν ανοίγει",
    message: "Μετά την ενημέρωση ζητάει ξανά σύνδεση.",
    urgent: false,
    plan: "paid",
    diagnostics: null,
    ...over,
  });
}

describe("24/7 Priority Support orders on the board", () => {
  test("a paid order opens one case with who bought it; sent twice, still one", async () => {
    const { t, browser } = await setup();
    const made = await signed(t, "/intake/order", order("started"));
    expect(made.status).toBe(201);
    expect(await made.json()).toEqual({ case: 1 });
    expect(await getCase(t.sql, 1)).toMatchObject({
      customer_id: "demo-shop",
      subject: "24/7 Priority Support order: Demo Shop IKE",
      plan: "paid",
      priority: "normal",
      created_by: "intake:order",
    });
    expect((await notes(t.sql, 1))[0]?.body).toBe(
      [
        "24/7 Priority Support was ordered from the app (EUR 100 a month, excl. VAT).",
        "Customer (account): demo-shop",
        "Name: Maria Papadopoulou",
        "Company: Demo Shop IKE",
        "Email: maria@shop.example",
        "Licence: team (active)",
        "Stripe subscription: sub_sup_1",
        "Started: 2026-11-18T10:00:00Z",
        "Paid until: 2026-12-18T10:00:00Z",
        "Status: active",
      ].join("\n"),
    );
    const again = await signed(t, "/intake/order", order("started"));
    expect(await again.json()).toEqual({ case: 1 });
    expect(
      await t.sql.first<{ n: number }>("SELECT COUNT(*) AS n FROM cases"),
    ).toEqual({ n: 1 });
    expect(
      (await readAudit(t.sql, 10, 0)).find((r) => r.action === "order.create"),
    ).toMatchObject({ actor: "intake:order", target: "case:1" });

    // The team sees it: on the case page, and as a tag in the list.
    const page = (await browser.get("/cases/1")).text;
    expect(page).toContain("24/7 Priority Support");
    expect(page).toContain("Active: answer within 1 hour, any day, any time");
    expect((await browser.get("/cases")).text).toContain(
      '<span class="tag bad">24/7</span>',
    );
  });

  test("while active, the customer's new support case opens urgent, due within 1 hour, any day", async () => {
    const { t } = await setup();
    await signed(t, "/intake/order", order("started"));
    // Saturday 21 Nov 2026, 23:00 Athens: outside business hours, still 1 hour.
    t.clock.now = Date.parse("2026-11-21T21:00:00.000Z");
    expect((await request(t)).status).toBe(201);
    expect(await getCase(t.sql, 2)).toMatchObject({
      priority: "urgent",
      sla_due_at: "2026-11-21T22:00:00.000Z",
    });
    // Another customer is not affected.
    expect((await request(t, { customerId: "demo-clinic" })).status).toBe(201);
    expect((await getCase(t.sql, 3))?.priority).toBe("normal");
  });

  test("renewal, failed renewal and cancellation update the same order and the same case", async () => {
    const { t } = await setup();
    await signed(t, "/intake/order", order("started"));
    await signed(
      t,
      "/intake/order",
      order("payment_failed", { status: "past_due" }),
    );
    await signed(
      t,
      "/intake/order",
      order("payment_failed", { status: "past_due" }),
    );
    expect((await request(t)).status).toBe(201);
    // Past due is not active: a normal case.
    expect((await getCase(t.sql, 2))?.priority).toBe("normal");
    await signed(
      t,
      "/intake/order",
      order("renewed", { paidUntil: "2027-01-18T10:00:00Z" }),
    );
    await signed(
      t,
      "/intake/order",
      order("cancelled", { status: "cancelled" }),
    );
    const bodies = (await notes(t.sql, 1)).map((n) => n.body.split("\n")[0]);
    expect(bodies).toEqual([
      "24/7 Priority Support was ordered from the app (EUR 100 a month, excl. VAT).",
      "Renewal payment FAILED: 24/7 support is not active until it is paid.",
      "Renewal paid.",
      "Subscription cancelled: 24/7 support has ended.",
    ]);
    expect(
      await t.sql.first<{ status: string; paid_until: string }>(
        "SELECT status, paid_until FROM support_orders WHERE subscription_id = 'sub_sup_1'",
      ),
    ).toEqual({ status: "cancelled", paid_until: "2027-01-18T10:00:00Z" });
    expect(
      await t.sql.first<{ n: number }>(
        "SELECT COUNT(*) AS n FROM cases WHERE source_ref LIKE 'order:%'",
      ),
    ).toEqual({ n: 1 });
  });

  test("only a signed, well-formed order is taken, and an order never moves to another customer", async () => {
    const { t } = await setup();
    const unsigned = await t.board.fetch(
      new Request(`${ORIGIN}/intake/order`, {
        method: "POST",
        body: JSON.stringify(order("started")),
      }),
    );
    expect(unsigned.status).toBe(403);
    expect(
      (await signed(t, "/intake/order", order("started", { kind: "other" })))
        .status,
    ).toBe(400);
    expect(
      (
        await signed(
          t,
          "/intake/order",
          order("started", { subscriptionId: "not-a-sub" }),
        )
      ).status,
    ).toBe(400);
    await signed(t, "/intake/order", order("started"));
    expect(
      (
        await signed(
          t,
          "/intake/order",
          order("cancelled", {
            customerId: "demo-clinic",
            status: "cancelled",
          }),
        )
      ).status,
    ).toBe(409);
  });
});
