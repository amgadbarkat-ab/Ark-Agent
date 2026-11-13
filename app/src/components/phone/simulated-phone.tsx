import { IconPhone, IconPhoneOff } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/lib/i18n";
import {
  type PhoneCall,
  phoneCallActionMutationOptions,
  phoneCallsQueryOptions,
  phoneSettingsQueryOptions,
} from "@/lib/phone/queries";
import { queryClient } from "@/query-client";

/**
 * The simulated phone (P2 idea 10): an approval call ringing inside the app, read instead of heard,
 * answered with the keys on screen. Shown only when this deployment offers phone approval and the
 * person has set it up; a real provider rings a real phone instead, with the same steps.
 */
export function SimulatedPhone() {
  const settings = useQuery(phoneSettingsQueryOptions());
  const enabled =
    settings.data?.provider === "simulated" && settings.data.hasPin;
  const calls = useQuery(phoneCallsQueryOptions(Boolean(enabled)));
  const call = calls.data?.[0];
  if (!call) return null;
  return <CallPanel call={call} />;
}

function CallPanel({ call }: { call: PhoneCall }) {
  const t = useT();
  const act = useMutation(phoneCallActionMutationOptions(queryClient));
  const [keys, setKeys] = useState("");
  const [latest, setLatest] = useState<PhoneCall | null>(null);
  const shown = latest?.id === call.id ? latest : call;

  const send = (action: "answer" | "keys" | "hang-up", pressed?: string) =>
    act.mutate(
      { callId: call.id, action, ...(pressed ? { keys: pressed } : {}) },
      { onSuccess: (next) => setLatest(next) },
    );

  return (
    <section
      aria-label={t("Simulated phone call")}
      className="fixed right-4 bottom-4 z-50 w-80 rounded-lg border bg-background p-3 shadow-lg"
    >
      <p className="flex items-center gap-2 font-medium text-sm">
        <IconPhone className="size-4" />
        {shown.step === "ringing"
          ? t("ArkAgent is calling (simulated)")
          : t("On a call with ArkAgent (simulated)")}
      </p>
      {shown.said ? (
        <p className="mt-2 text-muted-foreground text-sm" role="status">
          {shown.said}
        </p>
      ) : null}
      {shown.step === "ringing" ? (
        <div className="mt-3 flex gap-2">
          <Button onClick={() => send("answer")} size="sm">
            {t("Answer")}
          </Button>
          <Button onClick={() => send("hang-up")} size="sm" variant="ghost">
            <IconPhoneOff />
            {t("Decline call")}
          </Button>
        </div>
      ) : (
        <form
          className="mt-3 flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!keys) return;
            send("keys", keys);
            setKeys("");
          }}
        >
          <div className="grid grid-cols-3 gap-1">
            {["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"].map(
              (key) => (
                <Button
                  key={key}
                  onClick={() =>
                    setKeys((current) => `${current}${key}`.slice(0, 9))
                  }
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {key}
                </Button>
              ),
            )}
          </div>
          <div className="flex gap-2">
            <Input
              aria-label={t("Keys pressed")}
              inputMode="numeric"
              onChange={(event) =>
                setKeys(event.target.value.replace(/[^0-9#*]/g, "").slice(0, 9))
              }
              type={shown.step === "pin" ? "password" : "text"}
              value={keys}
            />
            <Button disabled={!keys || act.isPending} size="sm" type="submit">
              {t("Send")}
            </Button>
          </div>
          <Button
            onClick={() => send("hang-up")}
            size="sm"
            type="button"
            variant="ghost"
          >
            <IconPhoneOff />
            {t("Hang up")}
          </Button>
        </form>
      )}
      {act.error ? (
        <p className="mt-2 text-destructive text-xs" role="alert">
          {act.error.message}
        </p>
      ) : null}
    </section>
  );
}
