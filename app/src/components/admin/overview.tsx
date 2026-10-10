import {
  IconActivity,
  IconAlertTriangle,
  IconCash,
  IconChevronRight,
  IconCircleCheck,
  IconCloud,
  IconEye,
  IconInfoCircle,
  IconUserPlus,
  IconUsers,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link, type LinkOptions } from "@tanstack/react-router";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { formatEur } from "@/lib/account/queries";
import {
  type OverviewAttention,
  type OverviewCheck,
  overviewQueryOptions,
} from "@/lib/overview/queries";

/**
 * Where a thing that needs attention can be dealt with.
 *
 * The server names the screen, and this is the list of screens it may name. A path the server sends
 * that is not here is shown without a link rather than followed: the app decides where it navigates.
 */
const SCREENS: Record<string, LinkOptions> = {
  "/admin/accounts": { to: "/admin/accounts" },
  "/admin/cloud": { to: "/admin/cloud" },
  "/admin/marketplace": { to: "/admin/marketplace" },
};

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

const number = new Intl.NumberFormat("en");

/**
 * The first thing an administrator sees: what needs a decision, how the service is doing right now,
 * and what is still to settle before customers can rely on it.
 *
 * Every figure is the server's count. Nothing here works out whether something is wrong; it renders
 * the server's verdicts, in the order the server gave them.
 */
export function AdminOverview() {
  const overview = useQuery(overviewQueryOptions());

  if (overview.isPending) return null;
  if (overview.error || !overview.data) {
    return (
      <p className="mt-8 text-destructive text-sm" role="alert">
        Could not load the overview.
      </p>
    );
  }
  const { attention, customers, revenue, now, cloud, checks } = overview.data;
  const outstanding = checks.filter((check) => check.state === "todo").length;
  const ordered = [...checks].sort(
    (a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state],
  );

  return (
    <>
      <PageSection
        description="Things only you can settle. Each links to where."
        title="Needs your attention"
      >
        {attention.length === 0 ? (
          <PageEmpty>Nothing needs you right now.</PageEmpty>
        ) : (
          <PageRows>
            {attention.map((item, index) => (
              <div key={item.id}>
                <AttentionRow item={item} />
                {index !== attention.length - 1 && <Separator />}
              </div>
            ))}
          </PageRows>
        )}
      </PageSection>

      <PageSection
        description="Counts from this moment. Revenue is at list price, before tax."
        title="Right now"
      >
        <PageRows>
          <Figure
            description={
              customers.byPlan.length > 0
                ? customers.byPlan
                    .map((plan) => `${plan.name} ${plan.paying}`)
                    .join(", ")
                : "No plans are for sale."
            }
            icon={<IconUsers />}
            title={`Paying customers, of ${plural(customers.accounts, "account", "accounts")}`}
            value={number.format(customers.paying)}
          />
          <Separator />
          <Figure
            description="Every account paying now, at the price of its plan."
            icon={<IconCash />}
            title="Monthly recurring revenue"
            value={formatEur(revenue.monthlyRecurringCents)}
          />
          <Separator />
          <Figure
            description={`${plural(customers.newLast30Days, "account", "accounts")} in the last 30 days, and ${plural(customers.newPeopleLast7Days, "person", "people")} signed up this week.`}
            icon={<IconUserPlus />}
            title="New accounts this week"
            value={number.format(customers.newLast7Days)}
          />
          <Separator />
          <Figure
            description={`${plural(now.queuedWork, "background job", "background jobs")} waiting for a turn.`}
            icon={<IconActivity />}
            title="Working right now"
            value={`${plural(now.runs, "run", "runs")}, ${plural(now.accounts, "account", "accounts")}`}
          />
          {cloud ? (
            <>
              <Separator />
              <Figure
                description={
                  cloud.priced
                    ? `${cloud.hours.toFixed(1)} hours across ${plural(cloud.accountsUsing, "account", "accounts")}. ${formatEur(cloud.chargeCents)} would be charged if the month ended now.`
                    : `${cloud.hours.toFixed(1)} hours across ${plural(cloud.accountsUsing, "account", "accounts")}. No prices are set yet, so nothing is charged.`
                }
                icon={<IconCloud />}
                title={`Cloud running in ${cloud.period}, cost to us`}
                value={formatEur(cloud.costCents)}
              />
            </>
          ) : null}
        </PageRows>
      </PageSection>

      <PageSection
        description={
          outstanding > 0
            ? `${plural(outstanding, "thing is", "things are")} still to settle before customers can rely on this. Read from how it is set up now.`
            : "Nothing is outstanding. Read from how it is set up now."
        }
        title="Before customers rely on it"
      >
        <PageRows>
          {ordered.map((check, index) => (
            <div key={check.id}>
              <CheckRow check={check} />
              {index !== ordered.length - 1 && <Separator />}
            </div>
          ))}
        </PageRows>
      </PageSection>
    </>
  );
}

const STATE_ORDER: Record<OverviewCheck["state"], number> = {
  todo: 0,
  info: 1,
  ok: 2,
};

function Figure({
  description,
  icon,
  title,
  value,
}: {
  description: string;
  icon: React.ReactNode;
  title: string;
  value: string;
}) {
  return (
    <Item size="sm">
      <ItemMedia variant="icon">{icon}</ItemMedia>
      <ItemContent>
        <ItemTitle>{title}</ItemTitle>
        <ItemDescription className="line-clamp-none">
          {description}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <span className="font-medium text-sm tabular-nums">{value}</span>
      </ItemActions>
    </Item>
  );
}

function AttentionRow({ item }: { item: OverviewAttention }) {
  const screen = item.to ? SCREENS[item.to] : undefined;
  const body = (
    <>
      <ItemMedia variant="icon">
        {item.severity === "action" ? <IconAlertTriangle /> : <IconEye />}
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{item.title}</ItemTitle>
        <ItemDescription className="line-clamp-none">
          {item.detail}
        </ItemDescription>
      </ItemContent>
    </>
  );
  // A row that goes somewhere is the link, and has no children on the element it renders as; a row
  // that does not is a plain row with no chevron, which would otherwise promise a destination.
  return screen ? (
    <Item render={(props) => <Link {...screen} {...props} />} size="sm">
      {body}
      <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
    </Item>
  ) : (
    <Item size="sm">{body}</Item>
  );
}

function CheckRow({ check }: { check: OverviewCheck }) {
  return (
    <Item size="sm">
      <ItemMedia variant="icon">
        {check.state === "ok" ? (
          <IconCircleCheck />
        ) : check.state === "todo" ? (
          <IconAlertTriangle />
        ) : (
          <IconInfoCircle />
        )}
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{check.title}</ItemTitle>
        <ItemDescription className="line-clamp-none">
          {check.detail}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <span
          className={
            check.state === "todo"
              ? "font-medium text-destructive text-xs"
              : "text-muted-foreground text-xs"
          }
        >
          {check.state === "ok"
            ? "Done"
            : check.state === "todo"
              ? "To do"
              : "Your choice"}
        </span>
      </ItemActions>
    </Item>
  );
}
