import { useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import {
  ActivationForm,
  useActivationLine,
} from "@/components/activation/activation-form";
import {
  BuyLicence,
  PaymentReceived,
} from "@/components/activation/buy-licence";
import { ArkAgentPortrait } from "@/components/brand/arkagent-portrait";
import { useT } from "@/lib/i18n";
import { activationQueryOptions } from "@/lib/trial/queries";

/**
 * The Activate screen (#109, v0.1.42). On a desktop install that has no trial activation code, no
 * paid licence key and no trial setup file, or whose trial or licence has ended, this is the only
 * screen: nothing else opens until one of them is entered. Nothing is deleted while it shows.
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
      </div>
    </div>
  );
}
