import { IconCreditCard, IconRobot, IconSparkles } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import React, { useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
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
  component: PlanPage,
});

/** Where the person is sent to pay or manage billing: a different site, so a full navigation. */
function goTo(address: string) {
  window.location.assign(address);
}

function statusLine(account: AccountOverview["account"]): string {
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

function PlanPage() {
  const overview = useQuery(accountQueryOptions());
  const choose = useMutation(choosePlanMutationOptions());
  const portal = useMutation(openBillingPortalMutationOptions());
  const cancel = useMutation(cancelPlanMutationOptions(queryClient));
  const [confirmCancel, setConfirmCancel] = useState(false);

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
          {!data.account.canRun && data.account.blockedReason ? (
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
                    {statusLine(data.account)}
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
                        busy={choose.isPending}
                        current={
                          plan.id === data.account.planId && data.account.canRun
                        }
                        onChoose={() =>
                          choose.mutate(plan.id, {
                            onSuccess: ({ checkoutUrl }) => goTo(checkoutUrl),
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
