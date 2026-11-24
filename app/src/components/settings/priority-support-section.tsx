import { IconClockHour4, IconExternalLink } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { PageRows, PageSection } from "@/components/layout/page-shell";
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
import { dateLocale, tNow, useLanguage, useT } from "@/lib/i18n";
import {
  type PriorityState,
  supportPriorityQueryOptions,
} from "@/lib/support/queries";

function day(iso: string): string {
  return new Date(iso).toLocaleDateString(dateLocale(), {
    dateStyle: "medium",
  });
}

function euros(cents: number): string {
  return new Intl.NumberFormat(dateLocale(), {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

/**
 * 24/7 Priority Support (Amgad, 24 Nov 2026): any customer can order it here. The scope is BlackArk's
 * own words; in Greek it is shown first with the English below. Ordering opens BlackArk's checkout
 * (Stripe) in the browser; the plan shows active once Stripe confirms, and inactive when a renewal
 * fails or it is cancelled.
 */
export function PrioritySupportSection() {
  const t = useT();
  const language = useLanguage();
  const state = useQuery(supportPriorityQueryOptions());
  const data: PriorityState | null | undefined = state.data;
  if (state.isPending || !data) return null;

  const plan = data.plan;
  const active = plan?.status === "active";
  const status = active
    ? tNow("Active since {date}", { date: day(plan.startedAt) })
    : plan?.status === "past_due"
      ? t("Not active: the last payment did not go through.")
      : t("Not active");

  return (
    <PageSection title={t("24/7 Priority Support")}>
      {!data.available ? (
        <p className="text-muted-foreground text-sm">
          {t("Activate ArkAgent first to order 24/7 Priority Support.")}
        </p>
      ) : !data.offer ? (
        <p className="text-destructive text-sm" role="alert">
          {t("BlackArk could not be reached. Try again in a few minutes.")}
        </p>
      ) : (
        <PageRows>
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconClockHour4 />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>
                {t("24/7 Priority Support")} ·{" "}
                {tNow("{price} / month, excl. VAT", {
                  price: euros(data.offer.monthlyCents),
                })}
              </ItemTitle>
              <ItemDescription className="line-clamp-none">
                <span className="block" lang={language === "el" ? "el" : "en"}>
                  {language === "el"
                    ? data.offer.scope.el
                    : data.offer.scope.en}
                </span>
                {language === "el" ? (
                  <span className="mt-2 block text-xs" lang="en">
                    {data.offer.scope.en}
                  </span>
                ) : null}
              </ItemDescription>
            </ItemContent>
          </Item>
          <Separator />
          <Item size="sm">
            <ItemContent>
              <ItemTitle>
                <span
                  className={active ? "text-primary" : "text-muted-foreground"}
                >
                  {status}
                </span>
              </ItemTitle>
              {active && plan?.paidUntil ? (
                <ItemDescription>
                  {tNow("Paid until {date}", { date: day(plan.paidUntil) })}
                </ItemDescription>
              ) : null}
            </ItemContent>
            {!active && data.buyUrl ? (
              <ItemActions>
                <Button
                  render={
                    <a
                      href={data.buyUrl}
                      rel="noopener noreferrer"
                      target="_blank"
                    />
                  }
                  size="sm"
                >
                  {t("Order 24/7 support")}
                  <IconExternalLink />
                </Button>
              </ItemActions>
            ) : null}
          </Item>
        </PageRows>
      )}
      {data.error && data.offer ? (
        <p className="mt-2 text-muted-foreground text-xs">
          {t("BlackArk could not be reached. Try again in a few minutes.")}
        </p>
      ) : null}
    </PageSection>
  );
}
