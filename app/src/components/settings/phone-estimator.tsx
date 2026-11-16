/**
 * What the phone add-on would cost, before anyone buys it (#109, MD 15–16 Nov).
 *
 * Shown to administrators wherever the add-on is not switched on. The business answers three
 * questions (country, hours of incoming and outgoing calls a month); the estimate is worked out on
 * this page from the dated rate table, line by line, in EUR. A price a provider does not publish is
 * shown as missing and the total reads "at least" — never a zero. "Request activation" makes a
 * summary for the administrator to send to BlackArk; nothing is sent from here and nothing is paid
 * here. BlackArk switches the add-on on in the signed profile once it is paid for.
 */
import { IconCopy, IconPhone } from "@tabler/icons-react";
import { useId, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/lib/i18n";
import {
  type EstimateLine,
  estimatePhoneCost,
  euros,
} from "../../../../shared/phone-estimate";
import { PHONE_RATES } from "../../../../shared/phone-rates";

const LINE_LABELS: Record<EstimateLine["key"], string> = {
  number: "A local phone number (Twilio)",
  incoming: "Incoming call minutes (Twilio)",
  outgoing: "Outgoing call minutes (Twilio), not in the current feature",
  streams: "Live audio stream (Twilio Media Streams)",
  speech: "Speech (OpenAI Realtime)",
};

function range(line: { low: number; high: number }): string {
  return Math.abs(line.high - line.low) < 0.005
    ? euros(line.low)
    : `${euros(line.low)} – ${euros(line.high)}`;
}

export function PhoneEstimator() {
  const t = useT();
  const id = useId();
  const [iso, setIso] = useState("GR");
  const [incoming, setIncoming] = useState("10");
  const [outgoing, setOutgoing] = useState("0");
  const [share, setShare] = useState("40");
  const [model, setModel] = useState(PHONE_RATES.speechModels[0]?.id ?? "");
  const [summary, setSummary] = useState<string | null>(null);

  const countries = useMemo(
    () =>
      [...PHONE_RATES.countries].sort((a, b) =>
        a.region === b.region
          ? a.name.localeCompare(b.name)
          : a.region === "eu"
            ? -1
            : 1,
      ),
    [],
  );

  const result = useMemo(() => {
    try {
      return {
        estimate: estimatePhoneCost(PHONE_RATES, {
          iso,
          incomingHours: Number(incoming || 0),
          outgoingHours: Number(outgoing || 0),
          employeeShare: Number(share || 0) / 100,
          speechModel: model,
        }),
        error: null,
      };
    } catch (error) {
      return {
        estimate: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }, [iso, incoming, outgoing, share, model]);
  const estimate = result.estimate;

  const atLeast = (value: string) =>
    estimate && !estimate.complete
      ? t("at least {amount}", { amount: value })
      : value;

  const request = () => {
    if (!estimate) return;
    const lines = [
      t("Phone answering add-on: request for activation"),
      `${t("Country")}: ${estimate.country.name}`,
      `${t("Incoming calls")}: ${incoming} ${t("hours a month")}`,
      `${t("Outgoing calls")}: ${outgoing} ${t("hours a month")}`,
      `${t("Speech model")}: ${model}`,
      ...estimate.lines.map(
        (line) =>
          `${t(LINE_LABELS[line.key])}: ${line.missing ? t("not published") : range(line)}`,
      ),
      `${t("BlackArk add-on")}: ${euros(estimate.blackArk)} ${t("a month, excluding VAT")}`,
      `${t("Estimated total")}: ${atLeast(`${euros(estimate.totalLow)} – ${euros(estimate.totalHigh)}`)} ${t("a month")}`,
      t("Rates as of {date}; 1 EUR = {rate} USD (ECB, {fxDate}).", {
        date: PHONE_RATES.asOf,
        rate: String(PHONE_RATES.eurUsd),
        fxDate: PHONE_RATES.eurUsdDate,
      }),
    ];
    setSummary(lines.join("\n"));
  };

  return (
    <section aria-label={t("Phone answering (paid add-on)")} className="mt-8">
      <h2 className="px-2 text-xs font-medium text-muted-foreground">
        {t("Phone answering (paid add-on)")}
      </h2>
      <div className="mt-3 rounded-lg border border-border p-4">
        <div className="flex items-start gap-3">
          <IconPhone aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-sm">
              {t(
                "A digital employee can answer the business's phone line. It is a separate paid add-on, billed apart from ArkAgent, and stays off until it is ordered and paid for. Answer three questions for an estimate.",
              )}
            </p>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 @min-[36rem]:grid-cols-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-country`}>{t("Country")}</Label>
            <select
              className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
              id={`${id}-country`}
              onChange={(event) => setIso(event.target.value)}
              value={iso}
            >
              {countries.map((country) => (
                <option key={country.iso} value={country.iso}>
                  {t(country.name)}
                  {country.region === "gcc" ? " (GCC)" : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-model`}>{t("Speech model")}</Label>
            <select
              className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
              id={`${id}-model`}
              onChange={(event) => setModel(event.target.value)}
              value={model}
            >
              {PHONE_RATES.speechModels.map((speech) => (
                <option key={speech.id} value={speech.id}>
                  {speech.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-in`}>
              {t("Incoming calls, hours a month")}
            </Label>
            <Input
              id={`${id}-in`}
              inputMode="decimal"
              onChange={(event) => setIncoming(event.target.value)}
              value={incoming}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-out`}>
              {t("Outgoing calls, hours a month")}
            </Label>
            <Input
              id={`${id}-out`}
              inputMode="decimal"
              onChange={(event) => setOutgoing(event.target.value)}
              value={outgoing}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-share`}>
              {t("How much of a call the employee speaks, %")}
            </Label>
            <Input
              id={`${id}-share`}
              inputMode="numeric"
              onChange={(event) => setShare(event.target.value)}
              value={share}
            />
          </div>
        </div>

        {result.error ? (
          <p className="mt-3 text-destructive text-sm" role="alert">
            {t(result.error)}
          </p>
        ) : null}

        {estimate ? (
          <div className="mt-4">
            <table className="w-full text-sm">
              <caption className="sr-only">
                {t("Estimated monthly cost")}
              </caption>
              <tbody>
                {estimate.lines.map((line) => (
                  <tr className="border-border border-b" key={line.key}>
                    <th className="py-1.5 pr-3 text-left font-normal">
                      {t(LINE_LABELS[line.key])}
                    </th>
                    <td className="py-1.5 text-right tabular-nums">
                      {line.missing
                        ? t("not published: ask BlackArk for a quote")
                        : range(line)}
                    </td>
                  </tr>
                ))}
                <tr className="border-border border-b">
                  <th className="py-1.5 pr-3 text-left font-normal">
                    {t("BlackArk add-on, excluding VAT")}
                  </th>
                  <td className="py-1.5 text-right tabular-nums">
                    {euros(estimate.blackArk)}
                  </td>
                </tr>
                <tr>
                  <th className="py-2 pr-3 text-left">
                    {t("Estimated total a month")}
                  </th>
                  <td className="py-2 text-right font-medium tabular-nums">
                    {atLeast(
                      `${euros(estimate.totalLow)} – ${euros(estimate.totalHigh)}`,
                    )}
                  </td>
                </tr>
              </tbody>
            </table>
            <ul className="mt-3 list-disc space-y-1 pl-5 text-muted-foreground text-xs">
              <li>
                {t(
                  "Billed separately from ArkAgent. Twilio and OpenAI amounts are their list prices, converted at 1 EUR = {rate} USD (ECB, {fxDate}); rates as of {date}.",
                  {
                    rate: String(PHONE_RATES.eurUsd),
                    fxDate: PHONE_RATES.eurUsdDate,
                    date: PHONE_RATES.asOf,
                  },
                )}
              </li>
              <li>
                {t(
                  "An estimate only. Your phone company's charge for forwarding calls is not included, and speech can cost more on long calls.",
                )}
              </li>
              <li>
                {t(
                  "A number in some countries, including Greece, needs papers with the provider first.",
                )}
              </li>
              {!estimate.complete ? (
                <li>
                  {t(
                    "Some prices are not published for this country, so the total is a minimum.",
                  )}
                </li>
              ) : null}
            </ul>
            <div className="mt-4 flex gap-2">
              <Button onClick={request} size="sm">
                {t("Request activation")}
              </Button>
            </div>
            {summary ? (
              <div className="mt-3">
                <p className="text-muted-foreground text-xs">
                  {t(
                    "Send this to BlackArk. Nothing has been sent or paid. BlackArk switches the add-on on once it is paid for.",
                  )}
                </p>
                <textarea
                  className="mt-2 h-48 w-full rounded-md border border-input bg-transparent p-2 font-mono text-xs"
                  readOnly
                  value={summary}
                />
                <Button
                  className="mt-2"
                  onClick={() => void navigator.clipboard?.writeText(summary)}
                  size="sm"
                  variant="outline"
                >
                  <IconCopy aria-hidden="true" className="size-4" />
                  {t("Copy")}
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
