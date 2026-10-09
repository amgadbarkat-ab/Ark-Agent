import { afterEach, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { accountKeys, type AccountOverview } from "@/lib/account/queries";
import { authKeys, type AuthenticatedUser } from "@/lib/auth/queries";
import { Route } from "@/routes/_authed/_app";

/**
 * The gate that sends someone who has signed up but not chosen a plan to choose one.
 *
 * It must stop exactly that person: not someone whose plan lapsed (they are told why where they
 * land), not staff, not a company's own deployment, and not anyone on a deployment that has no
 * account service at all.
 */

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

const user = (role: "admin" | "user" = "user"): AuthenticatedUser => ({
  id: "u1",
  email: "ann@example.com",
  role,
  onboarding: null,
  terms: null,
});

function overview(
  account: Partial<AccountOverview["account"]>,
  mode: AccountOverview["billing"]["mode"] = "subscriptions",
): AccountOverview {
  return {
    account: {
      tenantId: "t",
      tenantName: "n",
      planId: "agent",
      planName: "Ark Agent",
      subscriptionStatus: "incomplete",
      maxActiveBots: 1,
      canRun: false,
      activeBots: 0,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      ...account,
    },
    billing: { mode, provider: "manual", selfService: false },
    plans: [],
  };
}

async function enter(who: AuthenticatedUser, data: AccountOverview | "fail") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(authKeys.currentUser(), who);
  if (data !== "fail") queryClient.setQueryData(accountKeys.overview(), data);
  global.fetch = (async () =>
    data === "fail"
      ? new Response(null, { status: 404 })
      : Response.json(data)) as never;
  const beforeLoad = Route.options.beforeLoad as (
    input: unknown,
  ) => Promise<unknown>;
  try {
    await beforeLoad({ context: { queryClient } });
    return "entered";
  } catch (error) {
    const target = (error as { options?: { to?: string } }).options?.to;
    return target ? `redirected to ${target}` : `threw ${String(error)}`;
  }
}

test("someone with no plan is sent to choose one", async () => {
  expect(await enter(user(), overview({ blockedCode: "no_plan" }))).toBe(
    "redirected to /settings/plan",
  );
});

test("someone whose plan lapsed or whose account is suspended still enters, and is told why there", async () => {
  expect(await enter(user(), overview({ blockedCode: "canceled" }))).toBe(
    "entered",
  );
  expect(await enter(user(), overview({ blockedCode: "suspended" }))).toBe(
    "entered",
  );
});

test("someone with a working plan enters", async () => {
  expect(
    await enter(
      user(),
      overview({ canRun: true, subscriptionStatus: "active" }),
    ),
  ).toBe("entered");
});

test("staff are never sent to choose a plan", async () => {
  expect(await enter(user("admin"), overview({ blockedCode: "no_plan" }))).toBe(
    "entered",
  );
});

test("a company's own deployment never asks anyone to choose", async () => {
  expect(
    await enter(user(), overview({ blockedCode: "no_plan" }, "internal")),
  ).toBe("entered");
});

test("a deployment with no account service has nothing to gate on", async () => {
  expect(await enter(user(), "fail")).toBe("entered");
});
