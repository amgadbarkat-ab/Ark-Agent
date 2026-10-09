import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import {
  type CloudRates,
  checkRates,
  costOf,
  chargeCents,
  describeUsage,
  RATE_LIMITS,
} from "../../../shared/cloud-pricing";
import type { AccountStore } from "../accounts/store";
import { type AppVariables, requireAdmin } from "../auth/guards";
import type { CloudConfig } from "../config";
import type { Database } from "../db/client";
import { settleCharge } from "./charging";
import type { CloudGate } from "./gate";
import { periodBounds, periodOf } from "./intervals";
import type { CloudMeter } from "./meter";
import {
  CloudRatesChanged,
  CloudRatesNotSet,
  type CloudChargeStatus,
  type CloudStore,
} from "./store";

type Middleware = MiddlewareHandler<{ Variables: AppVariables }>;

/** What happened, for the audit trail. The caller decides how to write it down. */
export type CloudAudit = (event: {
  eventType:
    | "cloud.rates_set"
    | "cloud.enabled"
    | "cloud.disabled"
    | "cloud.cap_changed"
    | "cloud.charge_settled";
  actorUserId: string;
  targetType: string;
  targetId: string;
  payload: Record<string, unknown>;
}) => Promise<void>;

/** The most a person may set as their monthly limit, in cents: ten thousand euro. */
const CAP_MAX_CENTS = 1_000_000;
/** The least: a euro. A limit of nothing is "switch it off". */
const CAP_MIN_CENTS = 100;

const capField = z.number().int().min(CAP_MIN_CENTS).max(CAP_MAX_CENTS);
const enableBody = z.strictObject({
  monthlyCapCents: capField,
  /** The rates on the person's screen. They must still be the current ones. */
  shownRates: z.record(z.string(), z.number()),
});
const capBody = z.strictObject({ monthlyCapCents: capField });
const settleBody = z.strictObject({
  outcome: z.enum(["charged", "waived"]),
  note: z.string().trim().min(3).max(500),
});

const CAP_PROBLEM = `The limit must be a whole number of cents between ${CAP_MIN_CENTS} and ${CAP_MAX_CENTS}.`;

/** What a customer is shown of a month: never the payment provider's own words or ids. */
const customerStatus = (status: CloudChargeStatus) =>
  status === "charging" || status === "uncertain" ? "checking" : status;

/** A person's own cloud running: what it costs, whether it is on, and what they have been charged. */
export function cloudRoutes(options: {
  requireUser: Middleware;
  accounts: AccountStore;
  gate: CloudGate;
  store: CloudStore;
  audit?: CloudAudit;
}) {
  const { requireUser, accounts, gate, store, audit } = options;
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", requireUser);

  /** Cloud running is an add-on of a paid account, and has to be charged to a subscription. */
  async function addOnOrReason(userId: string) {
    const tenantId = await accounts.ensureTenant(userId);
    const status = await gate.status(tenantId);
    if (!status.addOn) {
      return {
        tenantId,
        status,
        problem: "Running in the cloud is not a paid add-on on this service.",
      };
    }
    return { tenantId, status, problem: undefined };
  }

  app.get("/", async (context) => {
    const tenantId = await accounts.ensureTenant(context.var.actor.id);
    const [status, charges] = await Promise.all([
      gate.status(tenantId),
      store.charges({ tenantId, limit: 12 }),
    ]);
    const rates = status.rates;
    return context.json({
      cloud: {
        ...status,
        // The person's reading of the same rates, as sentences, so what they agree to is checkable.
        usageLines: rates ? describeUsage(status.usage, rates) : [],
      },
      charges: charges.map((charge) => ({
        id: charge.id,
        period: charge.period,
        status: customerStatus(charge.status),
        amountCents: charge.amountCents,
        usageLines: rates ? describeUsage(charge.usage, rates) : [],
      })),
      limits: { minCents: CAP_MIN_CENTS, maxCents: CAP_MAX_CENTS },
    });
  });

  app.post("/enable", async (context) => {
    const parsed = enableBody.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (!parsed.success) return context.json({ error: CAP_PROBLEM }, 400);
    const shown = checkRates(parsed.data.shownRates);
    if (!shown.ok) {
      return context.json({ error: "Those are not the prices." }, 400);
    }
    const { tenantId, status, problem } = await addOnOrReason(
      context.var.actor.id,
    );
    if (problem) return context.json({ error: problem }, 400);
    // A payment has to be possible: the charge goes on the subscription, so there must be one that
    // is in good standing.
    const summary = await accounts.summaryFor(context.var.actor.id);
    if (
      summary.subscriptionStatus !== "active" &&
      summary.subscriptionStatus !== "trialing"
    ) {
      return context.json(
        {
          error:
            "Choose or fix your plan first: cloud running is charged to your subscription.",
        },
        409,
      );
    }
    try {
      await store.enable(tenantId, {
        monthlyCapCents: parsed.data.monthlyCapCents,
        shownRates: shown.rates,
      });
    } catch (error) {
      if (error instanceof CloudRatesNotSet) {
        return context.json({ error: error.message }, 409);
      }
      if (error instanceof CloudRatesChanged) {
        return context.json({ error: error.message, changed: true }, 409);
      }
      throw error;
    }
    await audit?.({
      eventType: "cloud.enabled",
      actorUserId: context.var.actor.id,
      targetType: "tenant",
      targetId: tenantId,
      payload: {
        monthlyCapCents: parsed.data.monthlyCapCents,
        rates: shown.rates,
        wasEnabled: status.enabled,
      },
    });
    return context.json({ cloud: await gate.status(tenantId) });
  });

  app.put("/cap", async (context) => {
    const parsed = capBody.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (!parsed.success) return context.json({ error: CAP_PROBLEM }, 400);
    const { tenantId, status, problem } = await addOnOrReason(
      context.var.actor.id,
    );
    if (problem) return context.json({ error: problem }, 400);
    if (!status.enabled) {
      return context.json(
        { error: "Switch cloud running on first, then set its limit." },
        409,
      );
    }
    await store.setCap(tenantId, parsed.data.monthlyCapCents);
    await audit?.({
      eventType: "cloud.cap_changed",
      actorUserId: context.var.actor.id,
      targetType: "tenant",
      targetId: tenantId,
      payload: {
        from: status.monthlyCapCents,
        to: parsed.data.monthlyCapCents,
      },
    });
    return context.json({ cloud: await gate.status(tenantId) });
  });

  app.post("/disable", async (context) => {
    const { tenantId, status, problem } = await addOnOrReason(
      context.var.actor.id,
    );
    if (problem) return context.json({ error: problem }, 400);
    if (status.enabled) {
      await store.disable(tenantId);
      await audit?.({
        eventType: "cloud.disabled",
        actorUserId: context.var.actor.id,
        targetType: "tenant",
        targetId: tenantId,
        payload: {},
      });
    }
    return context.json({ cloud: await gate.status(tenantId) });
  });

  return app;
}

/**
 * What each account used in a calendar month and what it cost Ark, largest cost first.
 *
 * Shared by the cloud costs screen and the administrator's overview, so the two cannot disagree about
 * what a month cost. At most 500 accounts are read; a deployment with more than that has outgrown
 * reading them one at a time, and this is where it will say so.
 */
export async function monthlyUsage(
  deps: { store: CloudStore; meter: CloudMeter },
  period: string,
) {
  const { store, meter } = deps;
  periodBounds(period);
  const rates = await store.rates();
  const tenantIds = (await meter.tenantsWithUsage(period)).slice(0, 500);
  const names = await store.tenantNames(tenantIds);
  const accounts = await Promise.all(
    tenantIds.map(async (tenantId) => {
      const usage = await meter.usageFor(tenantId, period);
      const account = await store.account(tenantId);
      const cost = rates ? costOf(usage, rates).costCents : 0;
      return {
        tenantId,
        name: names.get(tenantId) ?? tenantId,
        enabled: account.enabled,
        hours: usage.computeSeconds / 3600,
        usageLines: rates ? describeUsage(usage, rates) : [],
        costCents: cost,
        chargeCents: rates ? chargeCents(usage, rates) : 0,
      };
    }),
  );
  accounts.sort((a, b) => b.costCents - a.costCents);
  const total = (key: "hours" | "costCents" | "chargeCents") =>
    accounts.reduce((sum, row) => sum + row[key], 0);
  return {
    period,
    priced: rates !== null,
    totals: {
      hours: total("hours"),
      costCents: total("costCents"),
      chargeCents: total("chargeCents"),
    },
    accounts,
  };
}

/** Our staff's view of cloud running: what it is priced at, what each account used, what was charged. */
export function adminCloudRoutes(options: {
  requireUser: Middleware;
  config: CloudConfig;
  store: CloudStore;
  meter: CloudMeter;
  database: Database;
  audit?: CloudAudit;
  now?: () => Date;
}) {
  const { requireUser, config, store, meter, database, audit } = options;
  const now = options.now ?? (() => new Date());
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", requireUser);
  app.use("*", async (context, next) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    await next();
  });

  app.get("/rates", async (context) =>
    context.json({
      mode: config.mode,
      rates: await store.rates(),
      limits: RATE_LIMITS,
    }),
  );

  app.put("/rates", async (context) => {
    const checked = checkRates(await context.req.json().catch(() => undefined));
    if (!checked.ok) return context.json({ error: checked.error }, 400);
    const before = await store.rates();
    await store.setRates(checked.rates, context.var.actor.id);
    await audit?.({
      eventType: "cloud.rates_set",
      actorUserId: context.var.actor.id,
      targetType: "cloud_rates",
      targetId: "current",
      payload: { from: before, to: checked.rates },
    });
    return context.json({ rates: checked.rates });
  });

  /** What each account used in a month, and what it cost Ark, so that rates can be set from it. */
  app.get("/usage", async (context) => {
    const requested = new URL(context.req.url).searchParams.get("period");
    const period = requested ?? periodOf(now());
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
      return context.json({ error: "The month is written 2026-10." }, 400);
    }
    return context.json(await monthlyUsage({ store, meter }, period));
  });

  app.get("/charges", async (context) => {
    const asked = new URL(context.req.url).searchParams.get("status");
    const valid = [
      "charging",
      "charged",
      "carried",
      "pending",
      "uncertain",
      "waived",
    ];
    if (asked !== null && !valid.includes(asked)) {
      return context.json({ error: "That is not a charge status." }, 400);
    }
    const charges = await store.charges({
      ...(asked ? { statuses: [asked as CloudChargeStatus] } : {}),
      limit: 100,
    });
    return context.json({
      charges: charges.map((charge) => ({
        ...charge,
        updatedAt: charge.updatedAt.toISOString(),
      })),
    });
  });

  /**
   * A month the machine would not decide: staff looked at the payment service's own record and say
   * whether it took the money. Final, and it says why, because it is the only way money is
   * recorded as taken or forgiven by hand.
   */
  app.post("/charges/:id/settle", async (context) => {
    const parsed = settleBody.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (!parsed.success) {
      return context.json(
        { error: "Say whether it was charged or waived, and why." },
        400,
      );
    }
    const id = context.req.param("id");
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      return context.json({ error: "No such charge." }, 404);
    }
    const done = await settleCharge(
      database,
      id,
      parsed.data.outcome,
      parsed.data.note,
    );
    if (!done) {
      return context.json(
        { error: "That month is already final, or does not exist." },
        409,
      );
    }
    await audit?.({
      eventType: "cloud.charge_settled",
      actorUserId: context.var.actor.id,
      targetType: "cloud_charge",
      targetId: id,
      payload: { outcome: parsed.data.outcome, note: parsed.data.note },
    });
    return context.json({ ok: true });
  });

  return app;
}

export type { CloudRates };
