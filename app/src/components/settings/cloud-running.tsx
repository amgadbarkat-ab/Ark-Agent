import {
  IconChevronRight,
  IconClockHour4,
  IconCloud,
  IconReceipt,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import React, { useState } from "react";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Separator } from "@/components/ui/separator";
import { formatEur } from "@/lib/account/queries";
import {
  disableCloudMutationOptions,
  enableCloudMutationOptions,
  setCloudCapMutationOptions,
} from "@/lib/cloud/mutations";
import {
  type CloudChargeView,
  type CloudOverview,
  type CloudRates,
  cloudQueryOptions,
  formatPeriod,
  formatRate,
} from "@/lib/cloud/queries";
import { queryClient } from "@/query-client";

const CHARGE_WORDS: Record<CloudChargeView["status"], string> = {
  charged: "Charged to your plan's payment method.",
  carried: "Too small to charge by itself, so it is added to the next month.",
  pending: "Waiting to be charged.",
  checking: "Being confirmed with the payment service.",
  waived: "Not charged.",
};

/**
 * Running in Ark's cloud, as an add-on a person switches on: the prices in plain words, the limit
 * they set, the month so far and the months already charged.
 *
 * Nothing renders on a deployment where it is not an add-on (a company's own, or where it is included
 * in the plan): the section is an answer to "what will I be charged", and there the answer is nothing.
 * The server's verdicts (`addOn`, `priced`, `enabled`, `atCap`) are shown as given.
 */
export function CloudRunningSection() {
  const overview = useQuery(cloudQueryOptions());
  const [open, setOpen] = useState(false);

  if (overview.isPending) return null;
  if (overview.error || !overview.data) {
    return (
      <p className="mt-4 text-destructive text-sm" role="alert">
        Could not load cloud running.
      </p>
    );
  }
  const { cloud, charges, limits } = overview.data;
  if (!cloud.addOn) return null;

  return (
    <PageSection
      description="Your coworkers can run on your own computer at no charge. Letting them run on Ark's computers is optional: you pay what it costs us, for the time they are working, and never more than the limit you set."
      title="Cloud running"
    >
      <PageRows>
        <Item
          render={<button onClick={() => setOpen(true)} type="button" />}
          size="sm"
        >
          <ItemMedia variant="icon">
            <IconCloud />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>Run in Ark's cloud</ItemTitle>
            <ItemDescription className="line-clamp-none">
              {summary(cloud)}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <IconChevronRight className="size-4 text-muted-foreground" />
          </ItemActions>
        </Item>
        {cloud.enabled || cloud.hours > 0 ? (
          <>
            <Separator />
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconClockHour4 />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{formatPeriod(cloud.period)}</ItemTitle>
                <ItemDescription className="line-clamp-none">
                  {cloud.atCap
                    ? "The limit is reached, so no more cloud runs start this month. Raise it or wait for next month."
                    : cloud.nearCap
                      ? "Close to the limit."
                      : cloud.usageLines.length > 0
                        ? cloud.usageLines.join(" · ")
                        : "Nothing used yet."}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <span className="text-muted-foreground text-sm">
                  {formatEur(cloud.chargeSoFarCents)} of{" "}
                  {formatEur(cloud.monthlyCapCents)}
                </span>
              </ItemActions>
            </Item>
          </>
        ) : null}
        {charges.map((charge) => (
          <React.Fragment key={charge.id}>
            <Separator />
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconReceipt />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{formatPeriod(charge.period)}</ItemTitle>
                <ItemDescription className="line-clamp-none">
                  {[...charge.usageLines, CHARGE_WORDS[charge.status]].join(
                    " · ",
                  )}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <span className="text-muted-foreground text-sm">
                  {charge.amountCents > 0 ? formatEur(charge.amountCents) : "—"}
                </span>
              </ItemActions>
            </Item>
          </React.Fragment>
        ))}
      </PageRows>

      <CloudDialog
        cloud={cloud}
        limits={limits}
        onOpenChange={setOpen}
        open={open}
      />
    </PageSection>
  );
}

/** The current answer, not the field's name. */
function summary(cloud: CloudOverview["cloud"]): string {
  if (!cloud.priced || !cloud.rates) {
    return "Not available yet. For now, run your coworkers on your own computer.";
  }
  if (cloud.enabled && cloud.ratesChanged) {
    return "The prices changed. Cloud runs are paused until you agree to the new ones.";
  }
  if (cloud.enabled) {
    return `On. Up to ${formatEur(cloud.monthlyCapCents)} a month, charged once a month.`;
  }
  return `Off. ${formatRate(cloud.rates.computeCentsPerHour)} for each hour a coworker is working, plus the payment fee.`;
}

function priceLines(rates: CloudRates): { label: string; value: string }[] {
  const lines = [
    {
      label: "An hour of a coworker working",
      value: formatRate(rates.computeCentsPerHour),
    },
  ];
  if (rates.storageCentsPerGbMonth > 0) {
    lines.push({
      label: "A gigabyte of storage for a month",
      value: formatRate(rates.storageCentsPerGbMonth),
    });
  }
  if (rates.egressCentsPerGb > 0) {
    lines.push({
      label: "A gigabyte sent out",
      value: formatRate(rates.egressCentsPerGb),
    });
  }
  lines.push({
    label: "Payment fee, added so the fee is not ours to carry",
    value:
      rates.paymentFeeFixedCents > 0
        ? `${rates.paymentFeePercent}% + ${formatRate(rates.paymentFeeFixedCents)}`
        : `${rates.paymentFeePercent}%`,
  });
  if (rates.marginPercent > 0) {
    lines.push({
      label: "Added on top of the cost",
      value: `${rates.marginPercent}%`,
    });
  }
  return lines;
}

/** Euros as typed to whole cents, or null when it is not an amount that fits the limits. */
function capCents(
  typed: string,
  limits: CloudOverview["limits"],
): number | null {
  if (typed.trim() === "") return null;
  const euros = Number(typed);
  if (!Number.isFinite(euros)) return null;
  const cents = Math.round(euros * 100);
  if (Math.abs(euros * 100 - cents) > 1e-6) return null;
  return cents >= limits.minCents && cents <= limits.maxCents ? cents : null;
}

function CloudDialog({
  cloud,
  limits,
  onOpenChange,
  open,
}: {
  cloud: CloudOverview["cloud"];
  limits: CloudOverview["limits"];
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        {/* Mounted only while open, so each opening starts from what is true now. */}
        {open ? (
          <CloudForm
            cloud={cloud}
            limits={limits}
            onDone={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function CloudForm({
  cloud,
  limits,
  onDone,
}: {
  cloud: CloudOverview["cloud"];
  limits: CloudOverview["limits"];
  onDone: () => void;
}) {
  const [typed, setTyped] = useState(
    String(
      (cloud.enabled ? cloud.monthlyCapCents : cloud.defaultCapCents) / 100,
    ),
  );
  /*
   * What was agreed to is the exact prices on the screen. If they change under the person (staff
   * set new ones, or the page re-reads after a refusal), the agreement no longer holds and has to be
   * given again.
   */
  const shown = JSON.stringify(cloud.rates);
  const [agreedTo, setAgreedTo] = useState<string | null>(null);
  const agreed = agreedTo === shown;

  const enable = useMutation(enableCloudMutationOptions(queryClient));
  const setCap = useMutation(setCloudCapMutationOptions(queryClient));
  const disable = useMutation(disableCloudMutationOptions(queryClient));
  const cents = capCents(typed, limits);
  /*
   * Agreeing is needed to switch on, and again when the prices changed under a switch that was on.
   * What was already used stays priced at what was agreed for it; only new runs wait.
   */
  const needsAgreement = !cloud.enabled || cloud.ratesChanged;
  const busy = enable.isPending || setCap.isPending || disable.isPending;
  const failure = (enable.error ?? setCap.error ?? disable.error)?.message;
  const rates = cloud.rates;

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {cloud.enabled
            ? cloud.ratesChanged
              ? "The prices changed"
              : "Cloud running"
            : "Switch on cloud running"}
        </DialogTitle>
        <DialogDescription>
          You pay what it costs us to run your coworkers for you, and nothing
          for the ones that run on your own computer. It is charged once a month
          to your plan's payment method, with tax where it applies.
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="mt-4 overflow-y-auto">
        {rates ? (
          <div className="mb-5 flex flex-col gap-2">
            {priceLines(rates).map((line) => (
              <Item key={line.label} size="sm" variant="muted">
                <ItemContent>
                  <ItemTitle>{line.label}</ItemTitle>
                </ItemContent>
                <ItemActions>
                  <span className="text-sm">{line.value}</span>
                </ItemActions>
              </Item>
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">
            Cloud running has not been priced yet.
          </p>
        )}
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="cloud-cap">
              Most to spend in a month (€)
            </FieldLabel>
            <Input
              id="cloud-cap"
              inputMode="decimal"
              onChange={(event) => setTyped(event.target.value)}
              value={typed}
            />
            <FieldDescription>
              When this month's charge reaches it, new runs in the cloud stop
              starting until next month or until you raise it. Between{" "}
              {formatEur(limits.minCents)} and {formatEur(limits.maxCents)}.
            </FieldDescription>
          </Field>
          {needsAgreement ? (
            <div className="flex items-start gap-2 text-sm">
              <Checkbox
                checked={agreed}
                id="cloud-agree"
                onCheckedChange={(next) =>
                  setAgreedTo(next === true ? shown : null)
                }
              />
              <label htmlFor="cloud-agree">
                I have read these prices and agree to be charged them for the
                time my coworkers run in Ark's cloud.
              </label>
            </div>
          ) : null}
        </FieldGroup>
        {typed.trim() !== "" && cents === null ? (
          <p className="mt-3 text-destructive text-sm" role="alert">
            The limit is a number of euros between {formatEur(limits.minCents)}{" "}
            and {formatEur(limits.maxCents)}.
          </p>
        ) : null}
        {failure ? (
          <p className="mt-3 text-destructive text-sm" role="alert">
            {failure}
          </p>
        ) : null}
      </DialogBody>
      <DialogFooter className="mt-4">
        <Button onClick={onDone} size="sm" type="button" variant="ghost">
          Close
        </Button>
        {cloud.enabled ? (
          <Button
            disabled={busy}
            onClick={() => disable.mutate(undefined, { onSuccess: onDone })}
            size="sm"
            type="button"
            variant="outline"
          >
            {disable.isPending ? "Switching off…" : "Switch off"}
          </Button>
        ) : null}
        {cloud.enabled && !cloud.ratesChanged ? (
          <Button
            disabled={busy || cents === null || cents === cloud.monthlyCapCents}
            onClick={() =>
              cents !== null && setCap.mutate(cents, { onSuccess: onDone })
            }
            size="sm"
            type="button"
          >
            {setCap.isPending ? "Saving…" : "Save limit"}
          </Button>
        ) : (
          <Button
            disabled={busy || !rates || !agreed || cents === null}
            onClick={() =>
              rates &&
              cents !== null &&
              enable.mutate(
                { monthlyCapCents: cents, shownRates: rates },
                { onSuccess: onDone },
              )
            }
            size="sm"
            type="button"
          >
            {enable.isPending
              ? "Saving…"
              : cloud.enabled
                ? "Agree to the new prices"
                : "Switch on"}
          </Button>
        )}
      </DialogFooter>
    </>
  );
}
