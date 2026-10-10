import { Hono, type MiddlewareHandler } from "hono";
import { planById } from "../../../shared/plans";
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
  return app;
}
