/**
 * The business's phone line (#109), for an administrator, on Settings, then Connect your Data.
 *
 * Calls to the business's number are forwarded to a Twilio number, which BlackArk's relay passes to
 * this computer. One digital employee answers, in the speech service the customer chose, with the
 * customer's own key. The line token and the speech key are typed into masked fields once and stored
 * encrypted on this computer; neither is shown again. Below the form: the call log and callbacks.
 */
import { IconPhone } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { useT } from "@/lib/i18n";
import {
  callbackDoneMutationOptions,
  removePhoneLineMutationOptions,
  savePhoneLineMutationOptions,
} from "@/lib/phone-line/mutations";
import {
  type PhoneLine,
  type PhoneLineHours,
  phoneCallsQueryOptions,
  phoneLineQueryOptions,
} from "@/lib/phone-line/queries";
import { queryClient } from "@/query-client";
import { PhoneEstimator } from "./phone-estimator";

type Form = {
  relayUrl: string;
  lineToken: string;
  speechKey: string;
  agentId: string;
  speechModel: string;
  voice: string;
  greeting: string;
  weekdayFrom: string;
  weekdayTo: string;
  saturdayFrom: string;
  saturdayTo: string;
  enabled: boolean;
};

const EMPTY: Form = {
  relayUrl: "",
  lineToken: "",
  speechKey: "",
  agentId: "",
  speechModel: "gpt-realtime",
  voice: "marin",
  greeting: "",
  weekdayFrom: "",
  weekdayTo: "",
  saturdayFrom: "",
  saturdayTo: "",
  enabled: true,
};

function formFrom(line: PhoneLine): Form {
  const weekday = line.hours?.["1"];
  const saturday = line.hours?.["6"];
  return {
    ...EMPTY,
    relayUrl: line.relayUrl,
    agentId: line.agentId,
    speechModel: line.speechModel,
    voice: line.voice,
    greeting: line.greeting,
    weekdayFrom: weekday?.from ?? "",
    weekdayTo: weekday?.to ?? "",
    saturdayFrom: saturday?.from ?? "",
    saturdayTo: saturday?.to ?? "",
    enabled: line.enabled,
  };
}

/** Monday to Friday share one span, Saturday has its own, Sunday is closed. Both empty: always open. */
function hoursFrom(form: Form): PhoneLineHours | null {
  const hours: PhoneLineHours = {};
  if (form.weekdayFrom && form.weekdayTo) {
    for (const day of ["1", "2", "3", "4", "5"] as const) {
      hours[day] = { from: form.weekdayFrom, to: form.weekdayTo };
    }
  }
  if (form.saturdayFrom && form.saturdayTo) {
    hours["6"] = { from: form.saturdayFrom, to: form.saturdayTo };
  }
  return Object.keys(hours).length > 0 ? hours : null;
}

const OUTCOMES: Record<string, string> = {
  answered: "Answered",
  callback: "Callback",
  handed_over: "Put through",
  after_hours: "After hours",
  failed: "Failed",
  in_progress: "In progress",
};

/**
 * The setup where BlackArk switched the paid phone add-on on for this business (MD, 15 Nov);
 * everywhere else the cost estimate, so the business can see the price before ordering it.
 */
export function PhoneLineSection() {
  const line = useQuery(phoneLineQueryOptions());
  if (!line.data) return null;
  return line.data.allowed ? <PhoneLineSettings /> : <PhoneEstimator />;
}

function PhoneLineSettings() {
  const t = useT();
  const id = useId();
  const line = useQuery(phoneLineQueryOptions());
  const calls = useQuery(phoneCallsQueryOptions());
  const employees = useQuery(agentListQueryOptions());
  const save = useMutation(savePhoneLineMutationOptions(queryClient));
  const remove = useMutation(removePhoneLineMutationOptions(queryClient));
  const done = useMutation(callbackDoneMutationOptions(queryClient));
  const [form, setForm] = useState<Form>(EMPTY);
  const [editing, setEditing] = useState(false);
  const held = line.data?.line ?? null;

  useEffect(() => {
    if (held && !editing) setForm(formFrom(held));
  }, [held, editing]);

  const set = (field: keyof Form) => (value: string | boolean) =>
    setForm((current) => ({ ...current, [field]: value }));

  const text = (
    name: keyof Form,
    label: string,
    options: { type?: string; placeholder?: string } = {},
  ) => (
    <div className="flex flex-col gap-1">
      <Label htmlFor={`${id}-${name}`}>{label}</Label>
      <Input
        autoComplete={options.type === "password" ? "new-password" : "off"}
        id={`${id}-${name}`}
        onChange={(event) => set(name)(event.target.value)}
        placeholder={options.placeholder}
        spellCheck={false}
        type={options.type ?? "text"}
        value={String(form[name])}
      />
    </div>
  );

  const statusText = !held
    ? t("Not set up.")
    : held.status === "connected"
      ? t("Answering calls.")
      : held.status === "connecting"
        ? t("Connecting to the relay…")
        : held.status === "refused"
          ? t("Not answering.")
          : t("Switched off.");

  const showForm = !held || editing;

  return (
    <section aria-label={t("Phone line")} className="mt-8">
      <h2 className="px-2 text-xs font-medium text-muted-foreground">
        {t("Phone line")}
      </h2>
      <div className="mt-3 rounded-lg border border-border p-4">
        <div className="flex items-start gap-3">
          <IconPhone aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-sm" role="status">
              {statusText}
            </p>
            {held?.problem ? (
              <p className="mt-1 text-destructive text-xs">{t(held.problem)}</p>
            ) : null}
            <p className="mt-1 text-muted-foreground text-xs">
              {t(
                "One digital employee answers the business's line: it greets the caller, answers within its instructions, takes callbacks and puts the caller through to a person. It makes no calls, and nothing is recorded.",
              )}
            </p>
          </div>
          {held && !editing ? (
            <div className="flex shrink-0 gap-2">
              <Button
                onClick={() => setEditing(true)}
                size="sm"
                variant="outline"
              >
                {t("Change")}
              </Button>
              <Button
                disabled={remove.isPending}
                onClick={() => remove.mutate()}
                size="sm"
                variant="ghost"
              >
                {t("Remove")}
              </Button>
            </div>
          ) : null}
        </div>

        {showForm ? (
          <form
            className="mt-4 grid grid-cols-1 gap-3 @min-[36rem]:grid-cols-2"
            onSubmit={(event) => {
              event.preventDefault();
              save.mutate(
                {
                  relayUrl: form.relayUrl.trim(),
                  ...(form.lineToken.trim()
                    ? { lineToken: form.lineToken.trim() }
                    : {}),
                  ...(form.speechKey.trim()
                    ? { speechKey: form.speechKey.trim() }
                    : {}),
                  agentId: form.agentId,
                  speechModel: form.speechModel.trim(),
                  voice: form.voice.trim(),
                  greeting: form.greeting.trim(),
                  hours: hoursFrom(form),
                  enabled: form.enabled,
                },
                {
                  onSuccess: () => {
                    setForm((current) => ({
                      ...current,
                      lineToken: "",
                      speechKey: "",
                    }));
                    setEditing(false);
                  },
                },
              );
            }}
          >
            {text("relayUrl", t("Relay address"), {
              placeholder: "https://phone.blackark.uk",
            })}
            {text(
              "lineToken",
              held ? t("Line token (leave empty to keep)") : t("Line token"),
              {
                type: "password",
              },
            )}
            {text(
              "speechKey",
              held
                ? t("Speech key (leave empty to keep)")
                : t("Speech key (OpenAI)"),
              {
                type: "password",
              },
            )}
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${id}-agent`}>{t("Who answers")}</Label>
              <select
                className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
                id={`${id}-agent`}
                onChange={(event) => set("agentId")(event.target.value)}
                value={form.agentId}
              >
                <option value="">{t("Choose a digital employee")}</option>
                {(employees.data ?? []).map((employee) => (
                  <option key={employee.id} value={employee.id}>
                    {employee.name}
                  </option>
                ))}
              </select>
            </div>
            {text("speechModel", t("Speech model"), {
              placeholder: "gpt-realtime",
            })}
            {text("voice", t("Voice"), { placeholder: "marin" })}
            <div className="@min-[36rem]:col-span-2">
              {text("greeting", t("Greeting"), {
                placeholder: "Καλημέρα σας. Πώς μπορώ να βοηθήσω;",
              })}
            </div>
            {text("weekdayFrom", t("Monday to Friday, from"), {
              placeholder: "09:00",
            })}
            {text("weekdayTo", t("Monday to Friday, until"), {
              placeholder: "17:00",
            })}
            {text("saturdayFrom", t("Saturday, from"), { placeholder: "" })}
            {text("saturdayTo", t("Saturday, until"), { placeholder: "" })}
            <label className="flex items-center gap-2 text-sm @min-[36rem]:col-span-2">
              <input
                checked={form.enabled}
                onChange={(event) => set("enabled")(event.target.checked)}
                type="checkbox"
              />
              {t("Answer calls")}
            </label>
            <div className="flex items-end gap-2">
              <Button disabled={save.isPending} size="sm" type="submit">
                {t("Save")}
              </Button>
              {editing ? (
                <Button
                  onClick={() => setEditing(false)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  {t("Cancel")}
                </Button>
              ) : null}
            </div>
            <p className="text-muted-foreground text-xs @min-[36rem]:col-span-2">
              {t(
                "Outside the hours, the employee says the business is closed and takes a callback. Leave the hours empty to answer at any time. The line token comes from BlackArk; the speech key is the business's own.",
              )}
            </p>
            {save.error ? (
              <p
                className="text-destructive text-sm @min-[36rem]:col-span-2"
                role="alert"
              >
                {save.error.message}
              </p>
            ) : null}
          </form>
        ) : null}

        {held ? (
          <div className="mt-6">
            <h3 className="text-xs font-medium text-muted-foreground">
              {t("Calls")}
            </h3>
            {(calls.data ?? []).length === 0 ? (
              <p className="mt-2 text-muted-foreground text-sm">
                {t("No calls yet.")}
              </p>
            ) : (
              <ul aria-label={t("Calls")} className="mt-2 flex flex-col gap-2">
                {(calls.data ?? []).map((call) => (
                  <li
                    className="rounded-md border border-border p-3 text-sm"
                    key={call.id}
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="font-medium">
                        {call.fromNumber || t("Unknown number")}
                      </span>
                      <span className="text-muted-foreground text-xs">
                        {new Date(call.startedAt).toLocaleString()} ·{" "}
                        {t(OUTCOMES[call.outcome] ?? call.outcome)}
                        {call.durationSeconds
                          ? ` · ${call.durationSeconds} s`
                          : ""}
                      </span>
                    </div>
                    {call.summary ? (
                      <p className="mt-1">{call.summary}</p>
                    ) : null}
                    {call.callback ? (
                      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded bg-muted p-2">
                        <span>
                          {t("Call back {name} on {number}: {reason}", {
                            name: call.callback.name,
                            number: call.callback.number,
                            reason: call.callback.reason,
                          })}
                        </span>
                        {call.callback.done ? (
                          <span className="text-muted-foreground text-xs">
                            {t("Done")}
                          </span>
                        ) : (
                          <Button
                            disabled={done.isPending}
                            onClick={() => done.mutate(call.id)}
                            size="sm"
                            variant="outline"
                          >
                            {t("Mark as done")}
                          </Button>
                        )}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
        {remove.error ? (
          <p className="mt-2 text-destructive text-sm" role="alert">
            {remove.error.message}
          </p>
        ) : null}
      </div>
    </section>
  );
}
