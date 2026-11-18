import {
  IconChevronRight,
  IconDeviceMobile,
  IconPlugConnected,
  IconQrcode,
  IconServer,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { QrImage } from "@/components/settings/qr-image";
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
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import {
  confirmPhoneMutationOptions,
  refusePhoneMutationOptions,
  removePhoneMutationOptions,
  saveArkLinkMutationOptions,
  startPairingMutationOptions,
} from "@/lib/ark-link/mutations";
import {
  type ArkLinkDevice,
  type ArkLinkState,
  arkLinkQueryOptions,
} from "@/lib/ark-link/queries";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { dateLocale, useT } from "@/lib/i18n";
import { queryClient } from "@/query-client";

export const Route = createFileRoute("/_authed/settings/phones")({
  component: PhonesPage,
});

/** The relay BlackArk runs. An administrator can name another. */
const DEFAULT_RELAY = "https://link.blackark.uk";

const when = (iso: string) =>
  new Date(iso).toLocaleString(dateLocale(), {
    dateStyle: "medium",
    timeStyle: "short",
  });

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString(dateLocale(), { timeStyle: "short" });

/**
 * Settings → Phones (#149): reach this computer's ArkAgent from a phone, through BlackArk's relay
 * (Ark Link). Off until an administrator switches it on. Pairing a phone takes a code from here, the
 * phone's name confirmed here, and nothing else; removing a phone cuts it at once.
 */
export function PhonesPage() {
  const t = useT();
  const { data: user } = useQuery(currentUserQueryOptions());
  const isAdmin = user?.role === "admin";
  const link = useQuery({ ...arkLinkQueryOptions(), enabled: isAdmin });

  return (
    <PageShell
      description={t(
        "Open this computer's ArkAgent on your phone, wherever you are. The phone connects through BlackArk's relay; you still see your own computer's app.",
      )}
      title={t("Phones")}
    >
      {!isAdmin ? (
        <PageEmpty>{t("Only an administrator can pair phones.")}</PageEmpty>
      ) : link.isPending ? null : link.isError ? (
        <PageEmpty>{link.error.message}</PageEmpty>
      ) : (
        <>
          {/*
           * No sign-in here, no pairing (Amgad, 18 Nov 06:40): every request on such an install is its
           * one administrator, so a phone would be that administrator. The server refuses as well.
           */}
          {link.data.noSignIn ? (
            <PageSection title={t("Connection")}>
              <PageEmpty>
                {t(
                  "Phones can be paired only where people sign in. Switch sign-in on for this install first (Google, Microsoft or your company's directory); then pair a phone here.",
                )}
              </PageEmpty>
            </PageSection>
          ) : (
            <ConnectionSection state={link.data} />
          )}
          {link.data.enabled && !link.data.noSignIn ? (
            <PairSection state={link.data} />
          ) : null}
          <DevicesSection devices={link.data.devices} />
        </>
      )}
    </PageShell>
  );
}

function statusSentence(
  state: ArkLinkState,
  t: ReturnType<typeof useT>,
): string {
  if (!state.configured)
    return t("Not set up. BlackArk gives you an install token.");
  if (!state.enabled) return t("Off. No phone can reach this computer.");
  if (state.status === "connected")
    return t("On. Paired phones can reach this computer.");
  return state.problem ? t(state.problem) : t("Connecting to the relay…");
}

function ConnectionSection({ state }: { state: ArkLinkState }) {
  const t = useT();
  const save = useMutation(saveArkLinkMutationOptions(queryClient));
  const [open, setOpen] = useState(false);
  const [relayUrl, setRelayUrl] = useState(state.relayUrl ?? DEFAULT_RELAY);
  const [installToken, setInstallToken] = useState("");

  return (
    <PageSection
      description={t(
        "Pairing is not signing in: on the phone you still sign in with your own ArkAgent account.",
      )}
      title={t("Connection")}
    >
      <PageRows>
        <Item size="sm">
          <ItemMedia variant="icon">
            <IconPlugConnected />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>{t("Phone access")}</ItemTitle>
            <ItemDescription className="line-clamp-none">
              {statusSentence(state, t)}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Switch
              aria-label={t("Phone access")}
              checked={state.enabled}
              disabled={save.isPending}
              onCheckedChange={(enabled) => {
                if (!state.configured) {
                  setOpen(true);
                  return;
                }
                save.mutate({ relayUrl: state.relayUrl ?? relayUrl, enabled });
              }}
            />
          </ItemActions>
        </Item>
        <Separator />
        <Item
          render={<button onClick={() => setOpen(true)} type="button" />}
          size="sm"
        >
          <ItemMedia variant="icon">
            <IconServer />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>{t("Relay and install token")}</ItemTitle>
            <ItemDescription>
              {state.configured ? state.relayUrl : t("Not set up")}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <IconChevronRight className="size-4 text-muted-foreground" />
          </ItemActions>
        </Item>
      </PageRows>
      {save.error && !open ? (
        <p className="mt-2 text-destructive text-sm" role="alert">
          {t(save.error.message)}
        </p>
      ) : null}

      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Relay and install token")}</DialogTitle>
            <DialogDescription>
              {t(
                "BlackArk gives you both. The token is typed here once and kept encrypted on this computer; it is never shown again.",
              )}
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              save.mutate(
                {
                  relayUrl: relayUrl.trim(),
                  enabled: true,
                  ...(installToken.trim()
                    ? { installToken: installToken.trim() }
                    : {}),
                },
                {
                  onSuccess: () => {
                    setInstallToken("");
                    setOpen(false);
                  },
                },
              );
            }}
          >
            <DialogBody className="mt-4 space-y-4 overflow-y-auto">
              <div className="space-y-1.5">
                <Label htmlFor="ark-link-relay">{t("Relay address")}</Label>
                <Input
                  id="ark-link-relay"
                  onChange={(event) => setRelayUrl(event.target.value)}
                  placeholder={DEFAULT_RELAY}
                  required
                  type="url"
                  value={relayUrl}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ark-link-token">
                  {state.configured
                    ? t("New install token (leave empty to keep it)")
                    : t("Install token")}
                </Label>
                <Input
                  autoComplete="off"
                  id="ark-link-token"
                  onChange={(event) => setInstallToken(event.target.value)}
                  placeholder="arki_…"
                  required={!state.configured}
                  type="password"
                  value={installToken}
                />
              </div>
              {save.error ? (
                <p className="text-destructive text-sm" role="alert">
                  {t(save.error.message)}
                </p>
              ) : null}
            </DialogBody>
            <DialogFooter className="mt-4">
              <Button
                onClick={() => setOpen(false)}
                size="sm"
                type="button"
                variant="outline"
              >
                {t("Cancel")}
              </Button>
              <Button disabled={save.isPending} size="sm" type="submit">
                {t("Save and switch on")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </PageSection>
  );
}

function PairSection({ state }: { state: ArkLinkState }) {
  const t = useT();
  const start = useMutation(startPairingMutationOptions(queryClient));
  const refuse = useMutation(refusePhoneMutationOptions(queryClient));
  const [confirming, setConfirming] = useState<{
    pairingId: string;
    deviceName: string;
  } | null>(null);
  const pairing = state.pairing;
  const connected = state.status === "connected";

  return (
    <PageSection
      action={
        <Button
          disabled={!connected || start.isPending}
          onClick={() => start.mutate()}
          size="sm"
          variant={pairing ? "outline" : "default"}
        >
          <IconQrcode />
          {pairing ? t("New code") : t("Pair a phone")}
        </Button>
      }
      description={t(
        "On the phone, open the ArkAgent app (or the address below) and enter the code, or scan the QR code with the camera. The code works once, for 5 minutes.",
      )}
      title={t("Pair a phone")}
    >
      {start.error ? (
        <p className="mt-2 text-destructive text-sm" role="alert">
          {t(start.error.message)}
        </p>
      ) : null}
      {pairing ? (
        <PageRows>
          {/* A code and a picture rather than rows: the one thing on this screen a phone reads off it. */}
          <div className="flex flex-col items-center gap-4 p-4 sm:flex-row sm:items-start">
            <QrImage
              label={t("QR code for pairing a phone")}
              text={pairing.url}
            />
            <div className="flex min-w-0 flex-col gap-2 text-center sm:text-left">
              <p className="text-muted-foreground text-sm">{t("Code")}</p>
              <p
                className="font-mono font-semibold text-3xl tracking-widest"
                data-testid="pairing-code"
              >
                {pairing.display}
              </p>
              <p className="break-all text-muted-foreground text-sm">
                {pairing.url}
              </p>
              <p className="text-muted-foreground text-sm">
                {t("Valid until {time}.", { time: clock(pairing.expiresAt) })}
              </p>
              {/*
               * The iPhone's Camera opens a scanned address in Safari, which would pair Safari rather
               * than the app. Until the app claims the link host (universal links), the code is typed.
               */}
              <p className="text-muted-foreground text-sm">
                {t(
                  "On an iPhone, type the code in the ArkAgent app. Scanning it with the Camera opens Safari, which would pair Safari instead of the app.",
                )}
              </p>
            </div>
          </div>
        </PageRows>
      ) : null}
      {pairing && pairing.claims.length > 0 ? (
        <PageRows>
          {pairing.claims.map((claim, index) => (
            <div key={claim.pairingId}>
              {index > 0 ? <Separator /> : null}
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconDeviceMobile />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{claim.deviceName}</ItemTitle>
                  <ItemDescription>
                    {t("Wants to pair. Is this your phone?")}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Button
                    disabled={refuse.isPending}
                    onClick={() => refuse.mutate(claim.pairingId)}
                    size="sm"
                    variant="outline"
                  >
                    {t("Decline")}
                  </Button>
                  <Button
                    onClick={() =>
                      setConfirming({
                        pairingId: claim.pairingId,
                        deviceName: claim.deviceName,
                      })
                    }
                    size="sm"
                  >
                    {t("Confirm")}
                  </Button>
                </ItemActions>
              </Item>
            </div>
          ))}
        </PageRows>
      ) : null}
      {confirming ? (
        <ConfirmDialog claim={confirming} onClose={() => setConfirming(null)} />
      ) : null}
    </PageSection>
  );
}

function ConfirmDialog({
  claim,
  onClose,
}: {
  claim: { pairingId: string; deviceName: string };
  onClose: () => void;
}) {
  const t = useT();
  const confirm = useMutation(confirmPhoneMutationOptions(queryClient));
  const [name, setName] = useState(claim.deviceName);
  return (
    <Dialog onOpenChange={(open) => (open ? undefined : onClose())} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Confirm this phone")}</DialogTitle>
          <DialogDescription>
            {t(
              "Only confirm a phone you are holding, or one you were just told about by its owner. You can rename it.",
            )}
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            confirm.mutate(
              { pairingId: claim.pairingId, deviceName: name.trim() },
              { onSuccess: onClose },
            );
          }}
        >
          <DialogBody className="mt-4 space-y-1.5">
            <Label htmlFor="ark-link-device-name">{t("Phone's name")}</Label>
            <Input
              id="ark-link-device-name"
              maxLength={60}
              onChange={(event) => setName(event.target.value)}
              required
              value={name}
            />
            {confirm.error ? (
              <p className="text-destructive text-sm" role="alert">
                {t(confirm.error.message)}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button onClick={onClose} size="sm" type="button" variant="outline">
              {t("Cancel")}
            </Button>
            <Button disabled={confirm.isPending} size="sm" type="submit">
              {t("Pair this phone")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DevicesSection({ devices }: { devices: ArkLinkDevice[] }) {
  const t = useT();
  const remove = useMutation(removePhoneMutationOptions(queryClient));
  const [removing, setRemoving] = useState<ArkLinkDevice | null>(null);
  return (
    <PageSection title={t("Paired phones")}>
      {devices.length === 0 ? (
        <PageEmpty>{t("No phone is paired with this computer.")}</PageEmpty>
      ) : (
        <PageRows>
          {devices.map((device, index) => (
            <div key={device.id}>
              {index > 0 ? <Separator /> : null}
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconDeviceMobile />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{device.name}</ItemTitle>
                  <ItemDescription>
                    {device.lastUsedAt
                      ? t("Paired {paired}. Last used {used}.", {
                          paired: when(device.pairedAt),
                          used: when(device.lastUsedAt),
                        })
                      : t("Paired {paired}. Not used yet.", {
                          paired: when(device.pairedAt),
                        })}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Button
                    onClick={() => setRemoving(device)}
                    size="sm"
                    variant="outline"
                  >
                    {t("Remove")}
                  </Button>
                </ItemActions>
              </Item>
            </div>
          ))}
        </PageRows>
      )}
      <Dialog
        onOpenChange={(open) => (open ? undefined : setRemoving(null))}
        open={removing !== null}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("Remove {name}?", { name: removing?.name ?? "" })}
            </DialogTitle>
            <DialogDescription>
              {t(
                "It stops reaching this computer at once, even with ArkAgent open on it. To use it again, pair it again.",
              )}
            </DialogDescription>
          </DialogHeader>
          {remove.error ? (
            <p className="mt-4 text-destructive text-sm" role="alert">
              {t(remove.error.message)}
            </p>
          ) : null}
          <DialogFooter className="mt-4">
            <Button
              onClick={() => setRemoving(null)}
              size="sm"
              type="button"
              variant="outline"
            >
              {t("Cancel")}
            </Button>
            <Button
              disabled={remove.isPending}
              onClick={() =>
                removing &&
                remove.mutate(removing.id, {
                  onSuccess: () => setRemoving(null),
                })
              }
              size="sm"
              variant="destructive"
            >
              {t("Remove")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageSection>
  );
}
