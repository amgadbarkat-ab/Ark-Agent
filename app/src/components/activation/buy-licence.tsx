/**
 * Buying a licence from the app, and the moment it arrives (#109, v0.1.49; Amgad, 19 Nov: "the
 * customer pays, and the activation code immediately reaches the app and unlocks it, with no manual
 * step").
 *
 * The button opens BlackArk's existing buy page (blackark.uk/checkin/buy/) for this install's
 * customer, in the person's own browser, and tells the server, which then asks blackark.uk for the
 * key every 20 seconds for half an hour. Once the key has come in by itself, the app says so.
 */
import { IconCircleCheck, IconCreditCard } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { openInBrowser } from "@/lib/external-links";
import { useT } from "@/lib/i18n";
import { openBuyPageMutationOptions } from "@/lib/trial/mutations";
import { type Activation, activationQueryOptions } from "@/lib/trial/queries";

/** As long as the server asks often after the buy page opens. */
const WATCH_FOR_MS = 30 * 60_000;
const WATCH_EVERY_MS = 5_000;

function openPage(address: string) {
  if (!openInBrowser(address)) {
    window.open(address, "_blank", "noopener,noreferrer");
  }
}

export function BuyLicence({ activation }: { activation: Activation }) {
  const t = useT();
  const buy = useMutation(openBuyPageMutationOptions());
  const [watching, setWatching] = useState(false);
  // Read again often while the person pays, so the app moves on by itself.
  useQuery({
    ...activationQueryOptions(),
    refetchInterval: watching ? WATCH_EVERY_MS : false,
    enabled: watching,
  });
  useEffect(() => {
    if (!watching) return;
    const stop = setTimeout(() => setWatching(false), WATCH_FOR_MS);
    return () => clearTimeout(stop);
  }, [watching]);

  if (!activation.buyUrl) return null;
  return (
    <div className="flex flex-col gap-2 text-left">
      <Button
        disabled={buy.isPending}
        onClick={() =>
          buy.mutate(undefined, {
            onSuccess: ({ buyUrl }) => {
              setWatching(true);
              openPage(buyUrl);
            },
          })
        }
        size="sm"
        variant="outline"
      >
        <IconCreditCard />
        {t("Buy a licence")}
      </Button>
      {buy.error ? (
        <p className="text-destructive text-sm" role="alert">
          {buy.error.message}
        </p>
      ) : watching ? (
        <p className="text-muted-foreground text-xs">
          {t(
            "Waiting for your payment. ArkAgent unlocks by itself as soon as it is paid; nothing needs to be typed.",
          )}
        </p>
      ) : (
        <p className="text-muted-foreground text-xs">
          {t(
            "Opens BlackArk's payment page in your browser. After you pay, ArkAgent unlocks by itself.",
          )}
        </p>
      )}
    </div>
  );
}

/** "Payment received": only when a key fetched after a payment activated this install. */
export function PaymentReceived({ activation }: { activation: Activation }) {
  const t = useT();
  if (!activation.paymentReceivedAt || activation.state !== "paid") return null;
  return (
    <p className="flex items-center gap-2 text-sm" role="status">
      <IconCircleCheck className="size-4" />
      {t("Payment received: ArkAgent is activated.")}
    </p>
  );
}
