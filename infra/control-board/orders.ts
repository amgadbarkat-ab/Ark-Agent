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
import { type Html, html } from "./html";
import { type Lang, t, when } from "./i18n";
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
    async customerSection(customerId, lang) {
      return customerTeamSection(db, customerId, lang);
    },
    async handlePublic(request, url) {
      if (url.pathname === "/intake/team") {
        const signed = await readSigned(db, request, options.secret, now());
        if (signed instanceof Response) return signed;
        const team = readTeam(signed.json);
        if (!team) return json(400, { error: "Not a team." });
        await db.run(
          "INSERT INTO customer_teams (customer_id, members, updated_at) VALUES (?, ?, ?) ON CONFLICT(customer_id) DO UPDATE SET members = excluded.members, updated_at = excluded.updated_at",
          team.customerId,
          JSON.stringify(team.members),
          new Date(now()).toISOString(),
        );
        await appendAudit(
          db,
          {
            actor: "intake:team",
            action: "team.update",
            target: `customer:${team.customerId}`,
            outcome: "ok",
            detail: `${team.members.length} people`,
          },
          now(),
        );
        return json(200, { ok: true });
      }
      if (url.pathname !== "/intake/order") return null;
      const signed = await readSigned(db, request, options.secret, now());
      if (signed instanceof Response) return signed;
      if ((signed.json as { kind?: unknown } | null)?.kind === "subprofiles")
        return subprofileOrder(db, signed.json, now());
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

// ---- Staff sub-profiles and the team (Amgad, 24 Nov 2026) --------------------------------------

type TeamMember = {
  name: string;
  email: string;
  role: "admin" | "subprofile";
  status: "pending_payment" | "active" | "suspended";
  createdAt: string;
  agents: number;
};

function readTeam(
  value: unknown,
): { customerId: string; members: TeamMember[] } | null {
  const body = (value ?? {}) as Record<string, unknown>;
  if (
    typeof body.customerId !== "string" ||
    !CUSTOMER_ID.test(body.customerId) ||
    !Array.isArray(body.members) ||
    body.members.length > 60
  )
    return null;
  const text = (v: unknown, max: number) =>
    typeof v === "string" ? v.slice(0, max) : "";
  return {
    customerId: body.customerId,
    members: body.members.map((raw) => {
      const one = (raw ?? {}) as Record<string, unknown>;
      return {
        name: text(one.name, 120),
        email: EMAIL.test(text(one.email, 254)) ? text(one.email, 254) : "",
        role: one.role === "admin" ? "admin" : "subprofile",
        status:
          one.status === "pending_payment" || one.status === "suspended"
            ? one.status
            : "active",
        createdAt: text(one.createdAt, 40),
        agents:
          typeof one.agents === "number" && Number.isInteger(one.agents)
            ? Math.max(0, one.agents)
            : 0,
      };
    }),
  };
}

type SubprofileOrder = {
  subscription_id: string;
  customer_id: string;
  quantity: number;
  status: "active" | "past_due" | "cancelled";
  case_number: number | null;
  started_at: string;
  updated_at: string;
};

/** A change of a customer's paid sub-profiles: one case per subscription, a note per change. */
async function subprofileOrder(
  db: Sql,
  value: unknown,
  now: number,
): Promise<Response> {
  const body = (value ?? {}) as Record<string, unknown>;
  const customerId = body.customerId;
  const subscriptionId = body.subscriptionId;
  const quantity = body.quantity;
  const status = STATUSES.find((one) => one === body.status);
  if (
    typeof customerId !== "string" ||
    !CUSTOMER_ID.test(customerId) ||
    typeof subscriptionId !== "string" ||
    !/^sub_[A-Za-z0-9_]+$/.test(subscriptionId) ||
    typeof quantity !== "number" ||
    !Number.isInteger(quantity) ||
    quantity < 0 ||
    quantity > 50 ||
    !status
  )
    return json(400, { error: "Not an order." });
  const at = new Date(now).toISOString();
  const known = await db.first<SubprofileOrder>(
    "SELECT * FROM subprofile_orders WHERE subscription_id = ?",
    subscriptionId,
  );
  if (known && known.customer_id !== customerId)
    return json(409, { error: "Another customer's order." });
  const line = `Staff sub-profiles paid: ${quantity} × EUR 15 a month (excl. VAT), on top of Ark Team.\nStripe subscription: ${subscriptionId}\nStatus: ${STATUS_WORDS[status]}`;
  if (!known) {
    const made = await openCase(
      db,
      {
        customerId,
        channel: "in-app",
        language: "el",
        priority: "normal",
        plan: "paid",
        subject: `Staff sub-profiles order: ${quantity}`,
        note: line,
        sourceRef: `subprofiles:${subscriptionId}`,
      },
      "intake:order",
      now,
    );
    await db.run(
      "INSERT INTO subprofile_orders (subscription_id, customer_id, quantity, status, case_number, started_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      subscriptionId,
      customerId,
      quantity,
      status,
      made.number,
      at,
      at,
    );
    await appendAudit(
      db,
      {
        actor: "intake:order",
        action: "order.create",
        target: `case:${made.number}`,
        outcome: "ok",
        detail: `sub-profiles, customer ${customerId}, ${quantity}, ${status}`,
      },
      now,
    );
    return json(201, { case: made.number });
  }
  if (known.quantity === quantity && known.status === status)
    return json(200, { case: known.case_number });
  await db.run(
    "UPDATE subprofile_orders SET quantity = ?, status = ?, updated_at = ? WHERE subscription_id = ?",
    quantity,
    status,
    at,
    subscriptionId,
  );
  if (known.case_number !== null)
    await addNote(
      db,
      known.case_number,
      "intake:order",
      `Changed: ${known.quantity} → ${quantity} paid.\n${line}`,
      now,
    );
  await appendAudit(
    db,
    {
      actor: "intake:order",
      action: "order.update",
      target: `case:${known.case_number ?? "-"}`,
      outcome: "ok",
      detail: `sub-profiles, customer ${customerId}, ${known.quantity}→${quantity}, ${status}`,
    },
    now,
  );
  return json(200, { case: known.case_number });
}

const MEMBER_STATUS: Record<TeamMember["status"], string> = {
  active: "active",
  pending_payment: "waiting for payment",
  suspended: "suspended",
};

/** The customer's team and sub-profile orders, on their page. */
async function customerTeamSection(
  db: Sql,
  customerId: string,
  l: Lang,
): Promise<Html | null> {
  const team = await db.first<{ members: string; updated_at: string }>(
    "SELECT members, updated_at FROM customer_teams WHERE customer_id = ?",
    customerId,
  );
  const orders = await db.all<SubprofileOrder>(
    "SELECT * FROM subprofile_orders WHERE customer_id = ? ORDER BY started_at DESC",
    customerId,
  );
  if (!team && orders.length === 0) return null;
  const members = team ? (JSON.parse(team.members) as TeamMember[]) : [];
  return html`<h2>${t(l, "Team")}</h2>
${
  team
    ? html`<div class="scroll"><table>
<thead><tr><th>${t(l, "Name")}</th><th>${t(l, "Email")}</th><th>${t(l, "Role")}</th><th>${t(l, "Status")}</th><th>${t(l, "Created")}</th><th>${t(l, "Digital employees")}</th></tr></thead>
<tbody>${members.map(
        (one) =>
          html`<tr><td>${one.name}</td><td>${one.email}</td><td>${t(l, one.role === "admin" ? "Administrator" : "Sub-profile")}</td><td>${t(l, MEMBER_STATUS[one.status])}</td><td>${one.createdAt ? when(l, one.createdAt) : "–"}</td><td>${one.agents}</td></tr>`,
      )}</tbody></table></div>
<p class="muted">${t(l, "As the customer's app last sent it")}: ${when(l, team.updated_at)}</p>`
    : ""
}
${
  orders.length
    ? html`<h3>${t(l, "Sub-profile orders")}</h3><ul>${orders.map(
        (one) =>
          html`<li><code>${one.subscription_id}</code> · ${one.quantity} × €15 · ${t(l, STATUS_WORDS[one.status])}${one.case_number ? html` · <a href="/cases/${one.case_number}">#${one.case_number}</a>` : ""}</li>`,
      )}</ul>`
    : ""
}`;
}
