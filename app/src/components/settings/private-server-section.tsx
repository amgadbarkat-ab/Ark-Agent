import { IconServer2 } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
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
import { dateLocale, useT } from "@/lib/i18n";
import { connectPrivateServerMutationOptions } from "@/lib/private-server/mutations";
import {
  type PrivateServerState,
  privateServerQueryOptions,
  type ServerOrder,
  type ServerTier,
} from "@/lib/private-server/queries";
import { queryClient } from "@/query-client";

/** Euros from cents, as the person's language writes them: "€23.50" or "23,50 €". */
export function euros(cents: number): string {
  return (cents / 100).toLocaleString(dateLocale(), {
    style: "currency",
    currency: "EUR",
  });
}

function day(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString(dateLocale(), {
        day: "numeric",
        month: "long",
        year: "numeric",
      });
}

/**
 * Ark Private Server (#149; COO's tiers, prices approved by Amgad 19 Nov 17:45): a server BlackArk sets
 * up for this business alone, to run an open model on. Each tier with its storage, the model it suits
 * and its price; "Choose" opens BlackArk's buy page (Stripe Checkout, in BlackArk's look) in the
 * browser. After payment the order shows as being set up by BlackArk, and once it is ready one click
 * makes it the person's model. For administrators; hidden when this build has no BlackArk to ask.
 */
export function PrivateServerSection() {
  const t = useT();
  const state = useQuery(privateServerQueryOptions());
  if (state.isPending || state.isError) return null;
  const data = state.data;
  return (
    <PageSection
      description={t(
        "A server BlackArk sets up for your business alone, to run an open model. Your conversations stay on it, not with a model company. Prices exclude VAT and are billed monthly through Stripe.",
      )}
      title={t("Ark Private Server")}
    >
      {!data.available ? (
        <p className="mt-4 text-muted-foreground text-sm">
          {t("Activate ArkAgent first to order a private server.")}
        </p>
      ) : (
        <>
          {data.error ? (
            <p className="mt-4 text-destructive text-sm" role="alert">
              {t(data.error)}
            </p>
          ) : null}
          {data.order ? <OrderRow data={data} order={data.order} /> : null}
          {data.tiers.length > 0 ? (
            <PageRows>
              {data.tiers.map((tier, index) => (
                <div key={tier.id}>
                  <TierRow
                    buyUrl={data.buyUrl}
                    current={
                      data.order?.tier === tier.id &&
                      data.order.status !== "cancelled"
                    }
                    tier={tier}
                  />
                  {index !== data.tiers.length - 1 && <Separator />}
                </div>
              ))}
            </PageRows>
          ) : null}
        </>
      )}
    </PageSection>
  );
}

function TierRow({
  tier,
  buyUrl,
  current,
}: {
  tier: ServerTier;
  buyUrl: string | null;
  current: boolean;
}) {
  const t = useT();
  const hardware = [tier.gpu, tier.cpu, tier.memory].filter(Boolean).join(", ");
  const models =
    tier.models.length > 0
      ? t("Suits {size} models, such as {models}.", {
          size: tier.modelSize,
          models: tier.models.join(", "),
        })
      : t("Suits {size} models.", { size: tier.modelSize });
  const href = buyUrl ? `${buyUrl}${encodeURIComponent(tier.id)}` : null;
  return (
    <Item size="sm">
      <ItemMedia variant="icon">
        <IconServer2 />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{tier.name}</ItemTitle>
        <ItemDescription>
          {t("{hardware}. Storage: {storage}.", {
            hardware,
            storage: tier.storage,
          })}{" "}
          {models}
        </ItemDescription>
        <ItemDescription>
          <span className="font-medium font-mono text-foreground">
            {t("{price} a month", { price: euros(tier.monthlyCents) })}
          </span>
          {tier.activationCents > 0
            ? ` · ${t("plus {price} once, to activate", {
                price: euros(tier.activationCents),
              })}`
            : null}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        {current ? (
          <span className="text-muted-foreground text-xs">
            {t("Your server")}
          </span>
        ) : href ? (
          <Button
            render={<a href={href} rel="noopener noreferrer" target="_blank" />}
            size="sm"
            variant="outline"
          >
            {t("Choose")}
          </Button>
        ) : null}
      </ItemActions>
    </Item>
  );
}

function OrderRow({
  data,
  order,
}: {
  data: PrivateServerState;
  order: ServerOrder;
}) {
  const t = useT();
  const connect = useMutation(connectPrivateServerMutationOptions(queryClient));
  const tier = data.tiers.find((candidate) => candidate.id === order.tier);
  const name = tier?.name ?? t("Ark Private Server");
  const sentence =
    order.status === "setting_up"
      ? t(
          "Paid on {date}. BlackArk is setting up your server; this page shows when it is ready.",
          { date: day(order.orderedAt) },
        )
      : order.status === "ready"
        ? data.connected
          ? t("Ready, and your digital employees use it. Model: {model}.", {
              model: order.model ?? "",
            })
          : t("Ready. Model: {model}. Use it to make it your default model.", {
              model: order.model ?? "",
            })
        : order.status === "stopped"
          ? t("Stopped by BlackArk. Contact BlackArk in Help & support.")
          : t("Cancelled. Choose a server below to order again.");
  return (
    <div className="mt-4 rounded-xl border border-border bg-card p-4">
      <p className="font-medium text-sm">{name}</p>
      <p
        className="mt-1 text-muted-foreground text-sm"
        role={order.status === "setting_up" ? "status" : undefined}
      >
        {sentence}
      </p>
      {order.paidUntil && order.status !== "cancelled" ? (
        <p className="mt-1 text-muted-foreground text-xs">
          {t("Paid until {date}.", { date: day(order.paidUntil) })}
        </p>
      ) : null}
      {order.status === "ready" && !data.connected ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            disabled={connect.isPending}
            onClick={() => connect.mutate()}
            size="sm"
          >
            {t("Use this server")}
          </Button>
          {connect.error ? (
            <span className="text-destructive text-xs" role="alert">
              {t(connect.error.message)}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
