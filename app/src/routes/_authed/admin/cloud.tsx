import {
  IconChevronRight,
  IconCloud,
  IconCoins,
  IconReceipt,
} from "@tabler/icons-react";
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
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { formatEur } from "@/lib/account/queries";
import {
  setCloudRatesMutationOptions,
  settleCloudChargeMutationOptions,
} from "@/lib/cloud/mutations";
import {
  type AdminCloudCharge,
  adminCloudChargesQueryOptions,
  adminCloudRatesQueryOptions,
  adminCloudUsageQueryOptions,
  type CloudMode,
  type CloudRates,
  formatPeriod,
  formatRate,
} from "@/lib/cloud/queries";
import { queryClient } from "@/query-client";

export const Route = createFileRoute("/_authed/admin/cloud")({
  component: CloudCosts,
});

const MODE_WORDS: Record<CloudMode, string> = {
  included:
    "Cloud running is included for everyone. Nothing is charged, and usage is recorded.",
  metered:
    "Cloud running is an add-on. Customers switch it on, see these prices, set a limit, and are charged each month.",
  off: "Cloud running is switched off on this service.",
};

/** What each rate is, in the words staff think in, with the unit it is entered in. */
const RATE_FIELDS: {
  key: keyof CloudRates;
  label: string;
  unit: string;
  help: string;
}[] = [
  {
    key: "computeCentsPerHour",
    label: "Running",
    unit: "cents per hour",
    help: "What one coworker's cloud capacity costs us for an hour. Measure it: see docs/ark/17-cloud-runtime.md.",
  },
  {
    key: "storageCentsPerGbMonth",
    label: "Storage",
    unit: "cents per GB a month",
    help: "What a gigabyte of a coworker's saved files costs us for a month. Zero if storage is not charged.",
  },
  {
    key: "egressCentsPerGb",
    label: "Data sent out",
    unit: "cents per GB",
    help: "Not measured yet, so it is not charged whatever is entered. Leave at zero.",
  },
  {
    key: "paymentFeePercent",
    label: "Payment fee",
    unit: "percent",
    help: "What the payment service keeps of each charge. The charge is raised so we receive the cost after this.",
  },
  {
    key: "paymentFeeFixedCents",
    label: "Payment fee, fixed",
    unit: "cents per charge",
    help: "What the payment service keeps of each charge whatever its size.",
  },
  {
    key: "marginPercent",
    label: "Margin",
    unit: "percent",
    help: "Added to cost. Zero charges exactly what it costs us. A business decision, not an engineering one.",
  },
  {
    key: "minimumChargeCents",
    label: "Smallest charge",
    unit: "cents",
    help: "A month that comes to less than this is added to the next month instead of charged.",
  },
];

/** The last six calendar months in UTC, newest first, as "2026-10". */
function recentPeriods(count = 6): string[] {
  const now = new Date();
  return Array.from({ length: count }, (_, back) => {
    const date = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1),
    );
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  });
}

function CloudCosts() {
  const rates = useQuery(adminCloudRatesQueryOptions());
  const periods = recentPeriods();
  const [period, setPeriod] = useState(periods[0] as string);
  const usage = useQuery(adminCloudUsageQueryOptions(period));
  const charges = useQuery(adminCloudChargesQueryOptions());
  const [editing, setEditing] = useState(false);

  const needsAttention = (charges.data ?? []).filter((charge) =>
    ["pending", "charging", "uncertain"].includes(charge.status),
  );
  const settled = (charges.data ?? []).filter(
    (charge) => !["pending", "charging", "uncertain"].includes(charge.status),
  );

  return (
    <PageShell
      description="What running in Ark's cloud costs us, what it is priced at, and what has been charged. Set the prices from measured cost."
      title="Cloud costs"
    >
      <PageSection
        description={rates.data ? MODE_WORDS[rates.data.mode] : undefined}
        title="Prices"
      >
        {rates.isPending ? null : rates.error || !rates.data ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            Could not load the prices.
          </p>
        ) : (
          <PageRows>
            <Item
              render={<button onClick={() => setEditing(true)} type="button" />}
              size="sm"
            >
              <ItemMedia variant="icon">
                <IconCoins />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>Prices for cloud running</ItemTitle>
                <ItemDescription className="line-clamp-none">
                  {rates.data.rates
                    ? `${formatRate(rates.data.rates.computeCentsPerHour)} an hour, ${rates.data.rates.paymentFeePercent}% payment fee, ${rates.data.rates.marginPercent}% margin.`
                    : "Not set. Until they are, nothing can be switched on or charged."}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <IconChevronRight className="size-4 text-muted-foreground" />
              </ItemActions>
            </Item>
          </PageRows>
        )}
      </PageSection>

      <PageSection
        description={
          usage.data
            ? `${usage.data.totals.hours.toFixed(1)} hours of running cost us ${formatEur(Math.ceil(usage.data.totals.costCents))}. At these prices it is ${formatEur(usage.data.totals.chargeCents)} charged.`
            : "What each account used, and what it cost us."
        }
        title="Usage"
      >
        <div className="mb-3">
          <Select
            items={Object.fromEntries(
              periods.map((value) => [value, formatPeriod(value)]),
            )}
            onValueChange={(value) => setPeriod(String(value))}
            value={period}
          >
            <SelectTrigger aria-label="Month" className="w-44" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {periods.map((value) => (
                <SelectItem key={value} value={value}>
                  {formatPeriod(value)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {usage.isPending ? null : usage.error || !usage.data ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            Could not load the usage.
          </p>
        ) : usage.data.accounts.length === 0 ? (
          <PageEmpty>Nothing ran in the cloud this month.</PageEmpty>
        ) : (
          <PageRows>
            {usage.data.accounts.map((account, index) => (
              <React.Fragment key={account.tenantId}>
                <Item size="sm">
                  <ItemMedia variant="icon">
                    <IconCloud />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{account.name}</ItemTitle>
                    <ItemDescription className="line-clamp-none">
                      {account.usageLines.join(" · ") ||
                        `${account.hours.toFixed(2)} hours`}
                      {" · "}
                      {account.enabled ? "switched on" : "not switched on"}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <span className="text-muted-foreground text-sm">
                      cost {formatEur(Math.ceil(account.costCents))}
                    </span>
                  </ItemActions>
                </Item>
                {index !== usage.data.accounts.length - 1 && <Separator />}
              </React.Fragment>
            ))}
          </PageRows>
        )}
      </PageSection>

      <PageSection
        description="A month the payment service refused, or that it did not answer for. A refused month is tried again by itself. One that was not answered is never sent again by a machine: look at the payment service's own record, then say what happened."
        title="Needs a decision"
      >
        {charges.isPending ? null : charges.error ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            Could not load the charges.
          </p>
        ) : needsAttention.length === 0 ? (
          <PageEmpty>Nothing is waiting.</PageEmpty>
        ) : (
          <PageRows>
            {needsAttention.map((charge, index) => (
              <React.Fragment key={charge.id}>
                <ChargeRow charge={charge} settle />
                {index !== needsAttention.length - 1 && <Separator />}
              </React.Fragment>
            ))}
          </PageRows>
        )}
      </PageSection>

      <PageSection title="Recent months">
        {charges.isPending || charges.error ? null : settled.length === 0 ? (
          <PageEmpty>No months have been charged yet.</PageEmpty>
        ) : (
          <PageRows>
            {settled.map((charge, index) => (
              <React.Fragment key={charge.id}>
                <ChargeRow charge={charge} />
                {index !== settled.length - 1 && <Separator />}
              </React.Fragment>
            ))}
          </PageRows>
        )}
      </PageSection>

      {rates.data ? (
        <RatesDialog
          limits={rates.data.limits}
          onOpenChange={setEditing}
          open={editing}
          rates={rates.data.rates}
        />
      ) : null}
    </PageShell>
  );
}

const STATUS_WORDS: Record<AdminCloudCharge["status"], string> = {
  charged: "charged",
  carried: "carried to the next month",
  pending: "refused, will be tried again",
  charging: "sent, no answer recorded",
  uncertain: "sent, the payment service did not say",
  waived: "waived",
};

function ChargeRow({
  charge,
  settle = false,
}: {
  charge: AdminCloudCharge;
  settle?: boolean;
}) {
  const [outcome, setOutcome] = useState<"charged" | "waived" | null>(null);
  const [note, setNote] = useState("");
  const settleCharge = useMutation(
    settleCloudChargeMutationOptions(queryClient),
  );

  return (
    <Item size="sm">
      <ItemMedia variant="icon">
        <IconReceipt />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>
          {charge.tenantName}
          <span className="font-normal text-muted-foreground text-xs">
            {formatPeriod(charge.period)}
          </span>
        </ItemTitle>
        <ItemDescription className="line-clamp-none">
          {STATUS_WORDS[charge.status]}
          {charge.note ? `. ${charge.note}` : ""}
        </ItemDescription>
        {outcome ? (
          <Input
            aria-label="Where you saw it"
            autoFocus
            className="mt-2"
            onChange={(event) => setNote(event.target.value)}
            placeholder={
              outcome === "charged"
                ? "Where you saw it taken, for the record"
                : "Why it is not being charged"
            }
            value={note}
          />
        ) : null}
        {settleCharge.error ? (
          <p className="text-destructive text-sm" role="alert">
            {settleCharge.error.message}
          </p>
        ) : null}
      </ItemContent>
      <ItemActions>
        <span className="text-muted-foreground text-sm">
          {charge.amountCents > 0 ? formatEur(charge.amountCents) : "—"}
        </span>
        {settle ? (
          outcome ? (
            <>
              <Button
                onClick={() => setOutcome(null)}
                size="sm"
                variant="ghost"
              >
                Cancel
              </Button>
              <Button
                disabled={settleCharge.isPending || note.trim().length < 3}
                onClick={() =>
                  settleCharge.mutate({
                    chargeId: charge.id,
                    outcome,
                    note: note.trim(),
                  })
                }
                size="sm"
                variant={outcome === "waived" ? "destructive" : "default"}
              >
                {outcome === "charged" ? "Record as charged" : "Waive"}
              </Button>
            </>
          ) : (
            <>
              <Button
                onClick={() => setOutcome("charged")}
                size="sm"
                variant="outline"
              >
                It was charged
              </Button>
              <Button
                onClick={() => setOutcome("waived")}
                size="sm"
                variant="outline"
              >
                Waive
              </Button>
            </>
          )
        ) : null}
      </ItemActions>
    </Item>
  );
}

function RatesDialog({
  limits,
  onOpenChange,
  open,
  rates,
}: {
  limits: Record<keyof CloudRates, number>;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  rates: CloudRates | null;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        {open ? (
          <RatesForm
            limits={limits}
            onDone={() => onOpenChange(false)}
            rates={rates}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function RatesForm({
  limits,
  onDone,
  rates,
}: {
  limits: Record<keyof CloudRates, number>;
  onDone: () => void;
  rates: CloudRates | null;
}) {
  const [typed, setTyped] = useState<Record<keyof CloudRates, string>>(
    () =>
      Object.fromEntries(
        RATE_FIELDS.map(({ key }) => [key, String(rates?.[key] ?? "")]),
      ) as Record<keyof CloudRates, string>,
  );
  const save = useMutation(setCloudRatesMutationOptions(queryClient));

  const parsed = Object.fromEntries(
    RATE_FIELDS.map(({ key }) => [
      key,
      typed[key].trim() === "" ? Number.NaN : Number(typed[key]),
    ]),
  ) as Record<keyof CloudRates, number>;
  const problem = RATE_FIELDS.find(
    ({ key }) =>
      !Number.isFinite(parsed[key]) ||
      parsed[key] < 0 ||
      parsed[key] > limits[key],
  );
  const complete = !problem && parsed.computeCentsPerHour > 0;

  return (
    <>
      <DialogHeader>
        <DialogTitle>Prices for cloud running</DialogTitle>
        <DialogDescription>
          Customers see these exactly, and agree to them before anything is
          charged. A customer who agreed to earlier prices is asked again. A
          month is charged at the prices they agreed to, worked out from the
          time the coworkers ran.
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="mt-4 overflow-y-auto">
        <FieldGroup>
          {RATE_FIELDS.map(({ key, label, unit, help }) => (
            <Field key={key}>
              <FieldLabel htmlFor={`rate-${key}`}>
                {label} ({unit})
              </FieldLabel>
              <Input
                id={`rate-${key}`}
                inputMode="decimal"
                onChange={(event) =>
                  setTyped((before) => ({
                    ...before,
                    [key]: event.target.value,
                  }))
                }
                value={typed[key]}
              />
              <FieldDescription>{help}</FieldDescription>
            </Field>
          ))}
        </FieldGroup>
        {problem ? (
          <p className="mt-3 text-destructive text-sm" role="alert">
            {problem.label} must be a number from 0 to {limits[problem.key]}.
          </p>
        ) : null}
        {save.error ? (
          <p className="mt-3 text-destructive text-sm" role="alert">
            {save.error.message}
          </p>
        ) : null}
      </DialogBody>
      <DialogFooter className="mt-4">
        <Button onClick={onDone} size="sm" type="button" variant="ghost">
          Cancel
        </Button>
        <Button
          disabled={!complete || save.isPending}
          onClick={() => save.mutate(parsed, { onSuccess: onDone })}
          size="sm"
          type="button"
        >
          {save.isPending ? "Saving…" : "Save prices"}
        </Button>
      </DialogFooter>
    </>
  );
}
