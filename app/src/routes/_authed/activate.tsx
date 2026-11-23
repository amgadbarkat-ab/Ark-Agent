import { IconLifebuoy } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  ActivationForm,
  useActivationLine,
} from "@/components/activation/activation-form";
import {
  BuyLicence,
  PaymentReceived,
} from "@/components/activation/buy-licence";
import { ArkAgentPortrait } from "@/components/brand/arkagent-portrait";
import { PageRows } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";
import { supportStateQueryOptions } from "@/lib/support/queries";
import { activationQueryOptions } from "@/lib/trial/queries";
import { RequestRow, WriteDialog } from "./settings/help";

/**
 * The Activate screen (#109, v0.1.42). On a desktop install that has no trial activation code, no
 * paid licence key and no trial profile, or whose trial or licence has ended, this is the only
 * screen: nothing else opens until one of them is entered. Nothing is deleted while it shows.
 *
 * Help & support is here too (Amgad, 23 Nov 2026): somebody stuck before activation can still write
 * to BlackArk. The request goes unverified, with an email address if they give one.
 */
export const Route = createFileRoute("/_authed/activate")({
  beforeLoad: async ({ context }) => {
    const activation = await context.queryClient
      .fetchQuery(activationQueryOptions())
      .catch(() => null);
    // Activated, or nothing to activate: this screen has nothing to ask.
    if (!activation || activation.allowed) {
      throw redirect({ to: "/" });
    }
  },
  component: Activate,
});

function Activate() {
  const t = useT();
  const navigate = useNavigate();
  // Read again by itself (v0.1.49): a key fetched after payment opens the app with nothing typed.
  const activation = useQuery({
    ...activationQueryOptions(),
    refetchInterval: 10_000,
  });
  const line = useActivationLine();
  const opened = activation.data?.allowed === true;
  // After a payment, long enough to read the notice; otherwise straight on.
  const pause = activation.data?.paymentReceivedAt ? 3_000 : 0;
  useEffect(() => {
    if (!opened) return;
    const next = setTimeout(() => void navigate({ to: "/" }), pause);
    return () => clearTimeout(next);
  }, [opened, pause, navigate]);

  if (opened && activation.data) {
    return (
      <div className="flex h-dvh w-full flex-col items-center justify-center p-6">
        <div className="flex w-full max-w-md flex-col items-center gap-6 text-center">
          <ArkAgentPortrait size={56} />
          <PaymentReceived activation={activation.data} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-dvh w-full flex-col items-center justify-center p-6">
      <div className="flex w-full max-w-md flex-col items-center gap-6 text-center">
        <ArkAgentPortrait size={56} />
        <h1 className="font-medium text-2xl tracking-tight">
          {t("Activate ArkAgent")}
        </h1>
        <p className="text-muted-foreground text-sm">
          {activation.data ? line(activation.data) : null}{" "}
          {t(
            "To use ArkAgent, enter your trial activation code or the licence key you received after paying.",
          )}
        </p>
        {activation.data ? <BuyLicence activation={activation.data} /> : null}
        <ActivationForm
          onActivated={() => {
            void navigate({ to: "/" });
          }}
        />
        <ActivateHelp />
      </div>
    </div>
  );
}

/** "Write to BlackArk" on the Activate screen, and what was sent from here. */
export function ActivateHelp() {
  const t = useT();
  const state = useQuery(supportStateQueryOptions());
  const [writing, setWriting] = useState(false);
  if (!state.data?.available) return null;
  const requests = state.data.requests.slice(0, 3);
  return (
    <div className="flex w-full flex-col items-center gap-3">
      <Button
        onClick={() => setWriting(true)}
        size="sm"
        type="button"
        variant="ghost"
      >
        <IconLifebuoy />
        {t("Need help? Write to BlackArk")}
      </Button>
      {requests.length > 0 ? (
        <div className="w-full text-left">
          <p className="sr-only">{t("Your requests")}</p>
          <PageRows>
            {requests.map((request, index) => (
              <RequestRow
                first={index === 0}
                key={request.id}
                request={request}
              />
            ))}
          </PageRows>
        </div>
      ) : null}
      {writing ? (
        <WriteDialog
          onOpenChange={setWriting}
          unverified={state.data.verified === false}
        />
      ) : null}
    </div>
  );
}
