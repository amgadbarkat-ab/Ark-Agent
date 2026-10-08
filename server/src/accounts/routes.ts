import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { planById, purchasablePlans } from "../../../shared/plans";
import { type AppVariables, requireAdmin } from "../auth/guards";
import {
  type BillingProvider,
  BillingUnavailableError,
} from "../billing/provider";
import { parsePageLimit } from "../paging";
import { type AccountStore, UnknownAccountError } from "./store";

type Middleware = MiddlewareHandler<{ Variables: AppVariables }>;

/** What happened, for the audit trail. The caller decides how to write it down. */
export type AccountAudit = (event: {
  eventType:
    | "account.plan_changed"
    | "account.suspended"
    | "account.resumed"
    | "account.subscription_changed";
  actorUserId: string;
  tenantId: string;
  payload: Record<string, unknown>;
}) => Promise<void>;

const planBody = z.strictObject({ planId: z.string().min(1).max(64) });
const adminPlanBody = z.strictObject({
  planId: z.string().min(1).max(64),
  status: z
    .enum(["incomplete", "trialing", "active", "past_due", "canceled"])
    .optional(),
});
const suspendBody = z.strictObject({ reason: z.string().trim().max(500) });

const PAGE_MAX = 100;

/** A person's own account: what they have, what it allows, and how to change it. */
export function accountRoutes(options: {
  requireUser: Middleware;
  accounts: AccountStore;
  billing: BillingProvider;
  /** Where the app is served, so a payment page can send the customer back. */
  appUrl: string | undefined;
  audit?: AccountAudit;
}) {
  const { requireUser, accounts, billing, appUrl, audit } = options;
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", requireUser);

  const returnUrl = (context: { req: { url: string } }) =>
    `${appUrl?.replace(/\/+$/, "") ?? new URL(context.req.url).origin}/settings/plan`;

  app.get("/", async (context) => {
    const account = await accounts.summaryFor(context.var.actor.id);
    return context.json({
      account,
      billing: {
        mode: accounts.billingMode,
        provider: billing.id,
        // Whether a customer can buy a plan themselves, or has to ask us.
        selfService: billing.id !== "manual",
      },
      plans: purchasablePlans(),
    });
  });

  app.post("/plan", async (context) => {
    if (accounts.billingMode === "internal") {
      return context.json(
        { error: "Plans are not used on this deployment." },
        400,
      );
    }
    const parsed = planBody.safeParse(
      await context.req.json().catch(() => undefined),
    );
    const plan = parsed.success ? planById(parsed.data.planId) : undefined;
    if (!plan?.purchasable) {
      return context.json({ error: "Choose one of the plans." }, 400);
    }
    const actor = context.var.actor;
    const tenantId = await accounts.ensureTenant(actor.id);
    try {
      /*
       * Somebody who already has a subscription moves it; they are not sold a second one. Without
       * this, choosing another plan would bill them for both.
       */
      const summary = await accounts.summaryFor(actor.id);
      const subscriptionId = await accounts.providerSubscriptionIdFor(
        tenantId,
        billing.id,
      );
      const subscribed =
        subscriptionId !== undefined &&
        (summary.subscriptionStatus === "active" ||
          summary.subscriptionStatus === "trialing" ||
          summary.subscriptionStatus === "past_due");
      if (subscribed && billing.changePlan) {
        if (summary.subscriptionStatus === "past_due") {
          return context.json(
            {
              error:
                "The last payment did not go through. Update your card from Manage billing, then change your plan.",
            },
            409,
          );
        }
        if (summary.planId === plan.id) {
          return context.json(
            {
              error: summary.cancelAtPeriodEnd
                ? "This plan ends at the end of the period. Choose it again once it has ended."
                : "You are already on that plan.",
            },
            409,
          );
        }
        const upgrade =
          plan.priceEurCents > (planById(summary.planId)?.priceEurCents ?? 0);
        await billing.changePlan(subscriptionId, plan.id, { upgrade });
        await audit?.({
          eventType: "account.subscription_changed",
          actorUserId: actor.id,
          tenantId,
          payload: { change: "plan", from: summary.planId, to: plan.id },
        });
        // The account changes when the provider says so; the screen waits for that.
        return context.json({ changed: true });
      }
      const checkout = await billing.createCheckout({
        tenantId,
        planId: plan.id,
        email: actor.email,
        returnUrl: returnUrl(context),
      });
      return context.json({ checkoutUrl: checkout.url });
    } catch (error) {
      if (error instanceof BillingUnavailableError) {
        return context.json({ error: error.message }, 503);
      }
      throw error;
    }
  });

  app.post("/portal", async (context) => {
    const summary = await accounts.summaryFor(context.var.actor.id);
    const customerId = await accounts.providerCustomerIdFor(
      summary.tenantId,
      billing.id,
    );
    if (!billing.createPortal || !customerId) {
      return context.json(
        { error: "There is no billing page for this account yet." },
        404,
      );
    }
    try {
      const portal = await billing.createPortal(customerId, returnUrl(context));
      return context.json({ portalUrl: portal.url });
    } catch (error) {
      if (error instanceof BillingUnavailableError) {
        return context.json({ error: error.message }, 503);
      }
      throw error;
    }
  });

  app.post("/cancel", async (context) => {
    const summary = await accounts.summaryFor(context.var.actor.id);
    const subscriptionId = await accounts.providerSubscriptionIdFor(
      summary.tenantId,
      billing.id,
    );
    if (!billing.cancel || !subscriptionId) {
      return context.json({ error: "Contact us to cancel this account." }, 400);
    }
    try {
      await billing.cancel(subscriptionId, { atPeriodEnd: true });
    } catch (error) {
      if (error instanceof BillingUnavailableError) {
        return context.json({ error: error.message }, 503);
      }
      throw error;
    }
    await accounts.applySubscription(summary.tenantId, {
      cancelAtPeriodEnd: true,
    });
    await audit?.({
      eventType: "account.subscription_changed",
      actorUserId: context.var.actor.id,
      tenantId: summary.tenantId,
      payload: { change: "cancel_at_period_end", planId: summary.planId },
    });
    return context.json({ cancelAtPeriodEnd: true });
  });

  return app;
}

/** Our staff's view of every account: plans, usage, and the power to suspend. */
export function adminAccountRoutes(options: {
  requireUser: Middleware;
  accounts: AccountStore;
  audit?: AccountAudit;
}) {
  const { requireUser, accounts, audit } = options;
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", requireUser);
  app.use("*", async (context, next) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    await next();
  });

  app.get("/", async (context) => {
    const url = new URL(context.req.url);
    const parsed = parsePageLimit(url.searchParams.get("limit"), PAGE_MAX);
    if (!parsed.ok) return context.json({ error: parsed.error }, 400);
    const search = url.searchParams.get("search");
    if (search !== null && search.length > 200) {
      return context.json(
        { error: "A search of at most 200 characters is required." },
        400,
      );
    }
    try {
      return context.json(
        await accounts.listForAdmin({
          ...(search ? { search } : {}),
          ...(url.searchParams.get("cursor")
            ? { cursor: url.searchParams.get("cursor") as string }
            : {}),
          ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
        }),
      );
    } catch {
      return context.json({ error: "That page cursor is not valid." }, 400);
    }
  });

  app.put("/:tenantId/plan", async (context) => {
    const parsed = adminPlanBody.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (!parsed.success || !planById(parsed.data.planId)) {
      return context.json({ error: "Choose a plan that exists." }, 400);
    }
    const tenantId = context.req.param("tenantId");
    try {
      await accounts.applySubscription(tenantId, {
        planId: parsed.data.planId,
        status: parsed.data.status ?? "active",
        provider: "manual",
      });
    } catch (error) {
      if (error instanceof UnknownAccountError) {
        return context.json({ error: "No such account." }, 404);
      }
      throw error;
    }
    await audit?.({
      eventType: "account.plan_changed",
      actorUserId: context.var.actor.id,
      tenantId,
      payload: {
        planId: parsed.data.planId,
        status: parsed.data.status ?? "active",
      },
    });
    return context.json({ ok: true });
  });

  app.post("/:tenantId/suspend", async (context) => {
    const parsed = suspendBody.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (!parsed.success) {
      return context.json({ error: "Say why, in a sentence or two." }, 400);
    }
    const tenantId = context.req.param("tenantId");
    try {
      await accounts.suspend(tenantId, parsed.data.reason);
    } catch (error) {
      if (error instanceof UnknownAccountError) {
        return context.json({ error: "No such account." }, 404);
      }
      throw error;
    }
    await audit?.({
      eventType: "account.suspended",
      actorUserId: context.var.actor.id,
      tenantId,
      payload: { reason: parsed.data.reason },
    });
    return context.json({ ok: true });
  });

  app.post("/:tenantId/resume", async (context) => {
    const tenantId = context.req.param("tenantId");
    try {
      await accounts.resume(tenantId);
    } catch (error) {
      if (error instanceof UnknownAccountError) {
        return context.json({ error: "No such account." }, 404);
      }
      throw error;
    }
    await audit?.({
      eventType: "account.resumed",
      actorUserId: context.var.actor.id,
      tenantId,
      payload: {},
    });
    return context.json({ ok: true });
  });

  return app;
}
