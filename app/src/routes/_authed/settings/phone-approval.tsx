import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { PageSection, PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { useT } from "@/lib/i18n";
import {
  phoneSettingsQueryOptions,
  savePhoneSettingsMutationOptions,
} from "@/lib/phone/queries";
import { queryClient } from "@/query-client";

export const Route = createFileRoute("/_authed/settings/phone-approval")({
  component: PhoneApprovalPage,
});

/**
 * Approving by phone (P2 idea 10): the number to ring, the PIN that proves it is you, and which of
 * your digital employees may ring. Off for a deployment until an administrator turns it on, and
 * off for a person until they save this.
 */
function PhoneApprovalPage() {
  const t = useT();
  const settings = useQuery(phoneSettingsQueryOptions());
  const agents = useQuery(agentListQueryOptions());
  const save = useMutation(savePhoneSettingsMutationOptions(queryClient));
  const [phone, setPhone] = useState("");
  const [pin, setPin] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!settings.data) return;
    setPhone(settings.data.phone ?? "");
    setPicked(settings.data.agentIds);
  }, [settings.data]);

  const mine = (agents.data ?? []).filter((agent) => agent.mine);

  return (
    <PageShell
      description={t(
        "A digital employee waiting for your approval can ring you. You answer with your PIN and the keypad.",
      )}
      title={t("Phone approval")}
    >
      {settings.isPending ? null : !settings.data ? (
        <p className="text-muted-foreground text-sm">
          {t(
            "Phone approval is off for this deployment. An administrator turns it on.",
          )}
        </p>
      ) : (
        <form
          className="flex flex-col gap-6"
          onSubmit={(event) => {
            event.preventDefault();
            setSaved(false);
            save.mutate(
              { phone, agentIds: picked, ...(pin ? { pin } : {}) },
              {
                onSuccess: () => {
                  setPin("");
                  setSaved(true);
                },
              },
            );
          }}
        >
          <PageSection
            description={
              settings.data.provider === "simulated"
                ? "Calls ring inside ArkAgent for now, not on your phone: a real phone line needs a separate yes."
                : undefined
            }
            title={t("How to reach you")}
          >
            <Field>
              <FieldLabel htmlFor="phone-number">
                {t("Phone number")}
              </FieldLabel>
              <Input
                id="phone-number"
                inputMode="tel"
                onChange={(event) => setPhone(event.target.value)}
                placeholder="+30 69 1234 5678"
                value={phone}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="phone-pin">
                {settings.data.hasPin
                  ? "New PIN (leave empty to keep it)"
                  : "PIN"}
              </FieldLabel>
              <Input
                autoComplete="new-password"
                id="phone-pin"
                inputMode="numeric"
                maxLength={8}
                onChange={(event) =>
                  setPin(event.target.value.replace(/\D/g, "").slice(0, 8))
                }
                placeholder={t("4 to 8 digits")}
                type="password"
                value={pin}
              />
            </Field>
          </PageSection>
          <PageSection
            description={t(
              "Browser and computer actions, and anything that moves money, are never approved by phone, whoever asks.",
            )}
            title={t("Who may ring you")}
          >
            <div className="flex flex-col gap-1">
              {mine.map((agent) => (
                <div className="flex items-center gap-2 text-sm" key={agent.id}>
                  <Checkbox
                    checked={picked.includes(agent.id)}
                    id={`phone-agent-${agent.id}`}
                    onCheckedChange={() =>
                      setPicked((current) =>
                        current.includes(agent.id)
                          ? current.filter((id) => id !== agent.id)
                          : [...current, agent.id],
                      )
                    }
                  />
                  <label htmlFor={`phone-agent-${agent.id}`}>
                    {agent.name}
                  </label>
                </div>
              ))}
            </div>
          </PageSection>
          {save.error ? (
            <p className="text-destructive text-sm" role="alert">
              {save.error.message}
            </p>
          ) : null}
          {saved ? (
            <p className="text-muted-foreground text-sm" role="status">
              {t("Saved.")}
            </p>
          ) : null}
          <div>
            <Button disabled={save.isPending} size="sm" type="submit">
              {t("Save")}
            </Button>
          </div>
        </form>
      )}
    </PageShell>
  );
}
