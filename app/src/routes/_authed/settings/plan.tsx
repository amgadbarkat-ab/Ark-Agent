import { IconCreditCard, IconRobot, IconSparkles } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, useSearch } from "@tanstack/react-router";
import React, { useEffect, useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { CloudRunningSection } from "@/components/settings/cloud-running";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import {
  cancelPlanMutationOptions,
  choosePlanMutationOptions,
  openBillingPortalMutationOptions,
} from "@/lib/account/mutations";
import {
  type AccountOverview,
  accountQueryOptions,
  formatEur,
  type PlanOffer,
} from "@/lib/account/queries";
import { queryClient } from "@/query-client";

export const Route = createFileRoute("/_authed/settings/plan")({
  // `paid` is put on the address by the payment page when the customer comes back from paying.
  validateSearch: (search: Record<string, unknown>): { paid?: string } =>
    search.paid === undefined ? {} : { paid: String(search.paid) },
  component: PlanPage,
});

/** How long the page keeps asking whether a payment or a change has landed, before saying it is slow. */
const CONFIRM_FOR_MS = 90_000;
const CONFIRM_EVERY_MS = 2_000;

/** Where the person is sent to pay or manage billing: a different site, so a full navigation. */
function goTo(address: string) {
  window.location.assign(address);
}

function statusLine(
  account: AccountOverview["account"],
  waiting: boolean,
): string {
  if (waiting) return "Waiting for confirmation";
  const until = account.currentPeriodEnd
    ? new Date(account.currentPeriodEnd).toLocaleDateString()
    : null;
  if (!account.canRun && account.blockedReason) return account.blockedReason;
  if (account.cancelAtPeriodEnd) {
    return until ? `Ends on ${until}` : "Ends at the end of this period";
  }
  switch (account.subscriptionStatus) {
    case "past_due":
      return "The last payment did not go through. Update your card to keep it.";
    case "trialing":
      return until ? `Trial until ${until}` : "On a trial";
    default:
      return until ? `Renews on ${until}` : "Active";
  }
}

function workingLine(account: AccountOverview["account"]): string {
  const limit =
    account.maxActiveBots === null ? "no limit" : String(account.maxActiveBots);
  return account.maxActiveBots === null
    ? `${account.activeBots} working now, no limit`
    : `${account.activeBots} of ${limit} working now`;
}

/**
 * Whether the account is waiting for the payment provider to say something.
 *
 * A payment is confirmed by the provider telling the server, which is a moment after the customer
 * lands back here. Until it has, the account still says "no plan", which is true and alarming, so the
 * page says what is happening and asks again by itself. A change of plan is confirmed the same way.
 */
function isWaiting(
  account: AccountOverview["account"] | undefined,
  paid: unknown,
  requested: string | null,
): boolean {
  if (!account) return false;
  const paidAndNotYetSeen =
    paid !== undefined &&
    !account.canRun &&
    (account.blockedCode === "no_plan" || account.blockedCode === "canceled");
  return (
    paidAndNotYetSeen || (requested !== null && account.planId !== requested)
  );
}

function PlanPage() {
  const { paid } = useSearch({ strict: false }) as { paid?: unknown };
  /** A plan the customer asked to move to, until the account shows it. */
  const [requested, setRequested] = useState<string | null>(null);
  const [gaveUp, setGaveUp] = useState(false);
  const overview = useQuery(accountQueryOptions());
  const choose = useMutation(choosePlanMutationOptions());
  const portal = useMutation(openBillingPortalMutationOptions());
  const cancel = useMutation(cancelPlanMutationOptions(queryClient));
  const [confirmCancel, setConfirmCancel] = useState(false);

  const waiting = isWaiting(overview.data?.account, paid, requested);
  const { refetch } = overview;
  /*
   * Ask again until the provider has told the server, then stop, and give up after a while with an
   * honest sentence. A timer of our own rather than the query's refetch interval: that one also
   * stops while the tab is in the background, and the customer may well be paying in another.
   */
  useEffect(() => {
    if (!waiting) {
      setGaveUp(false);
      return;
    }
    if (gaveUp) return;
    const giveUp = setTimeout(() => setGaveUp(true), CONFIRM_FOR_MS);
    const ask = setInterval(() => void refetch(), CONFIRM_EVERY_MS);
    return () => {
      clearTimeout(giveUp);
      clearInterval(ask);
    };
  }, [waiting, gaveUp, refetch]);

  const data = overview.data;
  const failure = choose.error ?? portal.error ?? cancel.error;

  return (
    <PageShell
      description="What you have, how much of it is in use, and how to change it. A coworker counts only while it is working."
      title="Plan"
    >
      {overview.isPending ? null : overview.error || !data ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          Could not load your plan.
        </p>
      ) : (
        <>
          {waiting ? (
            <p className="mt-4 text-sm" role="status">
              {gaveUp
                ? "This is taking longer than usual. If your plan does not appear soon, contact us and we will sort it out."
                : requested !== null
                  ? "Changing your plan. This page updates by itself."
                  : "Thank you. We are confirming your payment. This page updates by itself."}
            </p>
          ) : null}
          {!waiting && !data.account.canRun && data.account.blockedReason ? (
            <p className="mt-4 text-sm" role="status">
              {data.account.blockedCode === "no_plan"
                ? "Choose a plan to start your digital employees."
                : data.account.blockedReason}
            </p>
          ) : null}
          {failure ? (
            <p className="mt-4 text-destructive text-sm" role="alert">
              {failure.message}
            </p>
          ) : null}

          <PageSection
            description={
              data.billing.mode === "internal"
                ? "This deployment is run by your company: nobody pays and there is no limit."
                : undefined
            }
            title="Your plan"
          >
            <PageRows>
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconSparkles />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{data.account.planName}</ItemTitle>
                  <ItemDescription className="line-clamp-none">
                    {statusLine(data.account, waiting)}
                  </ItemDescription>
                </ItemContent>
              </Item>
              <Separator />
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconRobot />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>Coworkers</ItemTitle>
                  <ItemDescription>{workingLine(data.account)}</ItemDescription>
                </ItemContent>
              </Item>
            </PageRows>
          </PageSection>

          {data.billing.mode === "subscriptions" ? (
            <PageSection
              description="Every plan is for one person. Switch any time; your coworkers keep their work."
              title="Plans"
            >
              {data.plans.length === 0 ? (
                <PageEmpty>No plans are on offer right now.</PageEmpty>
              ) : (
                <PageRows>
                  {data.plans.map((plan, index) => (
                    <React.Fragment key={plan.id}>
                      <PlanRow
                        busy={choose.isPending || waiting}
                        current={
                          plan.id === data.account.planId && data.account.canRun
                        }
                        onChoose={() =>
                          choose.mutate(plan.id, {
                            onSuccess: (chosen) => {
                              if ("checkoutUrl" in chosen) {
                                goTo(chosen.checkoutUrl);
                              } else {
                                setRequested(plan.id);
                              }
                            },
                          })
                        }
                        plan={plan}
                        selfService={data.billing.selfService}
                      />
                      {index !== data.plans.length - 1 && <Separator />}
                    </React.Fragment>
                  ))}
                </PageRows>
              )}
              {!data.billing.selfService ? (
                <p className="mt-4 text-muted-foreground text-sm">
                  Online payment is not available yet. Contact us to start or
                  change a plan.
                </p>
              ) : null}
            </PageSection>
          ) : null}

          {data.billing.mode === "subscriptions" && data.account.canRun ? (
            <CloudRunningSection />
          ) : null}

          {data.billing.mode === "subscriptions" && data.billing.selfService ? (
            <PageSection title="Billing">
              <PageRows>
                <Item size="sm">
                  <ItemMedia variant="icon">
                    <IconCreditCard />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>Cards and invoices</ItemTitle>
                    <ItemDescription>
                      Update your card, or download an invoice.
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      disabled={portal.isPending}
                      onClick={() =>
                        portal.mutate(undefined, {
                          onSuccess: ({ portalUrl }) => goTo(portalUrl),
                        })
                      }
                      size="sm"
                      variant="outline"
                    >
                      Manage billing
                    </Button>
                  </ItemActions>
                </Item>
                {data.account.canRun && !data.account.cancelAtPeriodEnd ? (
                  <>
                    <Separator />
                    <Item size="sm">
                      <ItemContent>
                        <ItemTitle>Cancel</ItemTitle>
                        <ItemDescription>
                          {confirmCancel
                            ? "Your coworkers keep working until the end of the period you have paid for. Cancel now?"
                            : "Stop renewing at the end of this period."}
                        </ItemDescription>
                      </ItemContent>
                      <ItemActions>
                        {confirmCancel ? (
                          <>
                            <Button
                              onClick={() => setConfirmCancel(false)}
                              size="sm"
                              variant="ghost"
                            >
                              Keep my plan
                            </Button>
                            <Button
                              disabled={cancel.isPending}
                              onClick={() => {
                                cancel.mutate(undefined, {
                                  onSettled: () => setConfirmCancel(false),
                                });
                              }}
                              size="sm"
                              variant="destructive"
                            >
                              {cancel.isPending ? "Cancelling…" : "Cancel plan"}
                            </Button>
                          </>
                        ) : (
                          <Button
                            onClick={() => setConfirmCancel(true)}
                            size="sm"
                            variant="outline"
                          >
                            Cancel plan
                          </Button>
                        )}
                      </ItemActions>
                    </Item>
                  </>
                ) : null}
              </PageRows>
            </PageSection>
          ) : null}
        </>
      )}
    </PageShell>
  );
}

function PlanRow({
  busy,
  current,
  onChoose,
  plan,
  selfService,
}: {
  busy: boolean;
  current: boolean;
  onChoose: () => void;
  plan: PlanOffer;
  selfService: boolean;
}) {
  return (
    <Item size="sm">
      <ItemContent>
        <ItemTitle>
          {plan.name}
          <span className="font-normal text-muted-foreground text-xs">
            {formatEur(plan.priceEurCents)} a month
          </span>
        </ItemTitle>
        <ItemDescription className="line-clamp-none">
          {plan.summary}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        {current ? (
          <span className="text-muted-foreground text-sm">Your plan</span>
        ) : (
          <Button
            aria-label={`Choose ${plan.name}`}
            disabled={busy || !selfService}
            onClick={onChoose}
            size="sm"
            variant="outline"
          >
            Choose
          </Button>
        )}
      </ItemActions>
    </Item>
  );
}
