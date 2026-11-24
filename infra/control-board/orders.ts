/**
 * 24/7 Priority Support orders (Amgad, 24 Nov 2026, #149): who bought it, on the board.
 *
 * blackark.uk's Stripe webhook sends each change of a 24/7 subscription to `POST /intake/order`,
 * signed with INTAKE_SECRET as the intake is:
 * - "started" (a paid checkout) opens ONE case for the order: the customer, name, company, email,
 *   licence or account, Stripe subscription id, start date and status;
 * - "renewed", "payment_failed" and "cancelled" update the same order and add a note to the same case.
 * A message sent twice changes nothing twice. While a customer's 24/7 support is active, their cases
 * show a "24/7" tag, and a new case of theirs opens urgent, due within 1 hour around the clock
 * (cases.ts, `openCase`), since the offer promises a response within 1 hour, 7 days a week.
 */
import { appendAudit } from "./audit";
import { CUSTOMER_ID, type Extension } from "./board";
import { addNote, openCase } from "./cases";
import { json, readSigned } from "./intake";
import type { Sql } from "./sql";

export type SupportOrder = {
  subscription_id: string;
  customer_id: string;
  name: string | null;
  company: string | null;
  email: string | null;
  licence: string | null;
  started_at: string;
  paid_until: string | null;
  status: "active" | "past_due" | "cancelled";
  case_number: number | null;
  updated_at: string;
};

const EVENTS = ["started", "renewed", "payment_failed", "cancelled"] as const;
type OrderEvent = (typeof EVENTS)[number];
const STATUSES = ["active", "past_due", "cancelled"] as const;
const EMAIL = /^[^\s@<>()",;:]{1,64}@[A-Za-z0-9.-]{1,253}$/;

const STATUS_WORDS: Record<SupportOrder["status"], string> = {
  active: "active",
  past_due: "renewal payment failed (past due)",
  cancelled: "cancelled",
};

/** Whether this customer's 24/7 support is active now. */
export async function hasActive247(
  sql: Sql,
  customerId: string,
): Promise<boolean> {
  return (
    (await sql.first(
      "SELECT 1 AS found FROM support_orders WHERE customer_id = ? AND status = 'active' LIMIT 1",
      customerId,
    )) !== null
  );
}

/** This customer's latest 24/7 order, for the case page. */
export function latest247(
  sql: Sql,
  customerId: string,
): Promise<SupportOrder | null> {
  return sql.first<SupportOrder>(
    "SELECT * FROM support_orders WHERE customer_id = ? ORDER BY started_at DESC LIMIT 1",
    customerId,
  );
}

type OrderMessage = {
  event: OrderEvent;
  customerId: string;
  subscriptionId: string;
  status: SupportOrder["status"];
  startedAt: string;
  paidUntil: string | null;
  licence: string | null;
  name: string | null;
  company: string | null;
  email: string | null;
};

export function readOrder(value: unknown): OrderMessage | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  const text = (key: string, max: number) =>
    typeof body[key] === "string" && (body[key] as string).trim() !== ""
      ? (body[key] as string).trim().slice(0, max)
      : null;
  const event = EVENTS.find((one) => one === body.event);
  const status = STATUSES.find((one) => one === body.status);
  const customerId = text("customerId", 80);
  const subscriptionId = text("subscriptionId", 120);
  const startedAt = text("startedAt", 40);
  const email = text("email", 254);
  if (
    body.kind !== "support_247" ||
    !event ||
    !status ||
    !customerId ||
    !CUSTOMER_ID.test(customerId) ||
    !subscriptionId ||
    !/^sub_[A-Za-z0-9_]+$/.test(subscriptionId) ||
    !startedAt ||
    Number.isNaN(Date.parse(startedAt))
  )
    return null;
  return {
    event,
    customerId,
    subscriptionId,
    status,
    startedAt,
    paidUntil: text("paidUntil", 40),
    licence: text("licence", 200),
    name: text("name", 200),
    company: text("company", 200),
    email: email && EMAIL.test(email) ? email : null,
  };
}

function details(order: OrderMessage | SupportOrder): string {
  const o =
    "event" in order
      ? {
          customer: order.customerId,
          name: order.name,
          company: order.company,
          email: order.email,
          licence: order.licence,
          subscription: order.subscriptionId,
          started: order.startedAt,
          paidUntil: order.paidUntil,
          status: order.status,
        }
      : {
          customer: order.customer_id,
          name: order.name,
          company: order.company,
          email: order.email,
          licence: order.licence,
          subscription: order.subscription_id,
          started: order.started_at,
          paidUntil: order.paid_until,
          status: order.status,
        };
  return [
    `Customer (account): ${o.customer}`,
    `Name: ${o.name ?? "not given"}`,
    `Company: ${o.company ?? "not given"}`,
    `Email: ${o.email ?? "not given"}`,
    `Licence: ${o.licence ?? "unknown"}`,
    `Stripe subscription: ${o.subscription}`,
    `Started: ${o.started}`,
    `Paid until: ${o.paidUntil ?? "-"}`,
    `Status: ${STATUS_WORDS[o.status]}`,
  ].join("\n");
}

/** `POST /intake/order`: one 24/7 support order, opened or updated, with its board case. */
export function appOrders(
  db: Sql,
  options: { secret: string; now?: () => number },
): Extension {
  const now = options.now ?? Date.now;
  return {
    async handle() {
      return null;
    },
    async handlePublic(request, url) {
      if (url.pathname !== "/intake/order") return null;
      const signed = await readSigned(db, request, options.secret, now());
      if (signed instanceof Response) return signed;
      const order = readOrder(signed.json);
      if (!order) return json(400, { error: "Not an order." });
      const at = new Date(now()).toISOString();
      const known = await db.first<SupportOrder>(
        "SELECT * FROM support_orders WHERE subscription_id = ?",
        order.subscriptionId,
      );
      if (known && known.customer_id !== order.customerId)
        return json(409, { error: "Another customer's order." });

      if (!known) {
        // The first message about this order (normally "started"): the order and its case.
        const who = order.company ?? order.name ?? order.customerId;
        const made = await openCase(
          db,
          {
            customerId: order.customerId,
            channel: "in-app",
            language: "el",
            priority: "normal",
            plan: "paid",
            subject: `24/7 Priority Support order: ${who}`.slice(0, 200),
            note: `24/7 Priority Support was ordered from the app (EUR 100 a month, excl. VAT).\n${details(order)}`,
            sourceRef: `order:${order.subscriptionId}`,
          },
          "intake:order",
          now(),
        );
        await db.run(
          "INSERT INTO support_orders (subscription_id, customer_id, name, company, email, licence, started_at, paid_until, status, case_number, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          order.subscriptionId,
          order.customerId,
          order.name,
          order.company,
          order.email,
          order.licence,
          order.startedAt,
          order.paidUntil,
          order.status,
          made.number,
          at,
        );
        await appendAudit(
          db,
          {
            actor: "intake:order",
            action: "order.create",
            target: `case:${made.number}`,
            outcome: "ok",
            detail: `24/7 support, customer ${order.customerId}, ${order.status}`,
          },
          now(),
        );
        return json(201, { case: made.number });
      }

      // A later change: the same order, the same case. Repeating a message changes nothing.
      const unchanged =
        known.status === order.status &&
        (order.paidUntil ?? "") <= (known.paid_until ?? "");
      if (order.event === "started" || unchanged)
        return json(200, { case: known.case_number });
      await db.run(
        // "Paid until" only moves forward: an older message never shortens it.
        "UPDATE support_orders SET status = ?, paid_until = CASE WHEN ? > COALESCE(paid_until, '') THEN ? ELSE paid_until END, licence = COALESCE(?, licence), updated_at = ? WHERE subscription_id = ?",
        order.status,
        order.paidUntil ?? "",
        order.paidUntil,
        order.licence,
        at,
        order.subscriptionId,
      );
      const what: Record<OrderEvent, string> = {
        started: "Order confirmed again",
        renewed: "Renewal paid",
        payment_failed:
          "Renewal payment FAILED: 24/7 support is not active until it is paid",
        cancelled: "Subscription cancelled: 24/7 support has ended",
      };
      if (known.case_number !== null)
        await addNote(
          db,
          known.case_number,
          "intake:order",
          `${what[order.event]}.\nStatus: ${STATUS_WORDS[order.status]}\nPaid until: ${order.paidUntil ?? known.paid_until ?? "-"}`,
          now(),
        );
      await appendAudit(
        db,
        {
          actor: "intake:order",
          action: "order.update",
          target: `case:${known.case_number ?? "-"}`,
          outcome: "ok",
          detail: `24/7 support, customer ${order.customerId}, ${order.event}, ${order.status}`,
        },
        now(),
      );
      return json(200, { case: known.case_number });
    },
  };
}
