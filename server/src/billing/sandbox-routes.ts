import { Hono, type MiddlewareHandler } from "hono";
import { planById, trialEndFrom } from "../../../shared/plans";
import type { AccountStore } from "../accounts/store";
import type { AppVariables } from "../auth/guards";

/**
 * The page a customer lands on to "pay", for the sandbox provider only.
 *
 * It takes no money: it marks the signed-in person's own account as paid and sends them back to the
 * plan page, so the whole journey (sign up, choose, pay, start working) can be walked through before a
 * real payment provider exists. It is mounted only when the sandbox provider is selected, which
 * itself refuses to start in production, and it only ever acts on the caller's own account.
 */
export function sandboxCheckoutRoutes(options: {
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  accounts: AccountStore;
  appUrl: string | undefined;
}) {
  const { requireUser, accounts, appUrl } = options;
  const app = new Hono<{ Variables: AppVariables }>();
  app.get("/checkout", requireUser, async (context) => {
    const plan = planById(context.req.query("plan") ?? "");
    const tenantId = await accounts.ensureTenant(context.var.actor.id);
    if (!plan?.purchasable || context.req.query("tenant") !== tenantId) {
      return context.json(
        { error: "That checkout is not for this account." },
        400,
      );
    }
    await accounts.applySubscription(tenantId, {
      planId: plan.id,
      status: "active",
      provider: "sandbox",
      providerCustomerId: `sandbox-customer-${tenantId}`,
      providerSubscriptionId: `sandbox-subscription-${tenantId}`,
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      cancelAtPeriodEnd: false,
    });
    const back = `${appUrl?.replace(/\/+$/, "") ?? new URL(context.req.url).origin}/settings/plan`;
    return context.redirect(back, 302);
  });

  /*
   * THE TRIAL, WALKED THROUGH WITHOUT WAITING A WEEK (DT Lab, #83). Sandbox only, like the page
   * above, and only ever the caller's own account.
   *
   * `/trial/start` puts the account on a fresh 7-day trial; `/trial/end` moves its end to a minute
   * ago, which is day 8: digital employees stop and everything stays readable. Choosing a plan on
   * `/checkout` starts them again.
   */
  app.get("/trial/start", requireUser, async (context) => {
    const tenantId = await accounts.ensureTenant(context.var.actor.id);
    await accounts.applySubscription(tenantId, {
      planId: "agent",
      status: "trialing",
      provider: "trial",
      providerCustomerId: null,
      providerSubscriptionId: null,
      currentPeriodEnd: trialEndFrom(new Date()),
      cancelAtPeriodEnd: false,
    });
    return context.redirect(planPage(context.req.url), 302);
  });
  app.get("/trial/end", requireUser, async (context) => {
    const tenantId = await accounts.ensureTenant(context.var.actor.id);
    const summary = await accounts.summaryFor(context.var.actor.id);
    if (summary.subscriptionStatus !== "trialing") {
      return context.json(
        { error: "This account is not on a trial. Start one first." },
        400,
      );
    }
    await accounts.applySubscription(tenantId, {
      currentPeriodEnd: new Date(Date.now() - 60_000),
    });
    return context.redirect(planPage(context.req.url), 302);
  });

  function planPage(requestUrl: string): string {
    return `${appUrl?.replace(/\/+$/, "") ?? new URL(requestUrl).origin}/settings/plan`;
  }
  return app;
}
