import { IconBell, IconBellRinging } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import type { DeviceSupport } from "@/lib/push/device";
import {
  disablePushMutationOptions,
  enablePushMutationOptions,
  testPushMutationOptions,
} from "@/lib/push/mutations";
import {
  type PushTestResult,
  pushDeviceQueryOptions,
  pushStatusQueryOptions,
} from "@/lib/push/queries";
import { queryClient } from "@/query-client";

/** What a row says when this browser cannot be switched on, and why. Only for the states that cannot. */
const CANNOT: Record<Exclude<DeviceSupport, "ready">, string> = {
  unsupported: "This browser cannot show notifications.",
  "needs-install":
    "On an iPhone or iPad, add Ark to your Home Screen first (Share, then Add to Home Screen), then open it from there and come back here.",
  blocked:
    "Notifications are blocked for this site. Allow them in your browser's settings, then come back here.",
};

/** What the test said, in the words a person wants: did it arrive, and if not, why not. */
export function testOutcome(result: PushTestResult): string {
  if (result.sent > 0) {
    return result.sent === 1
      ? "Sent. It should arrive in a moment."
      : `Sent to ${result.sent} devices. It should arrive in a moment.`;
  }
  if (result.removed > 0) {
    return "That device no longer accepts notifications, so it was removed. Switch them on again.";
  }
  if (result.failed > 0) {
    return "The notification service did not accept it. Try again in a minute.";
  }
  return "No device is registered, so nothing was sent.";
}

/**
 * Whether this device is told when a routine finishes, fails or is switched off.
 *
 * Per device, not per account: a person who wants their phone buzzed does not necessarily want the
 * same on a work laptop, and only the browser can be asked for permission, so the switch is the
 * browser's. The messages never say what a routine was or what it produced, because a lock screen is
 * read by whoever is standing next to the phone.
 */
export function NotificationSettings() {
  const status = useQuery(pushStatusQueryOptions());
  const device = useQuery(pushDeviceQueryOptions());
  const enable = useMutation(enablePushMutationOptions(queryClient));
  const disable = useMutation(disablePushMutationOptions(queryClient));
  const test = useMutation(testPushMutationOptions());

  const publicKey = status.data?.publicKey ?? null;
  const busy = enable.isPending || disable.isPending;
  const failure = enable.error ?? disable.error ?? test.error;

  return (
    <PageSection
      description="Ark can tell you on this device when a routine finishes or needs you, even when Ark is closed. A notification says that something happened, never what it was."
      title="Notifications"
    >
      {status.isPending || device.isPending ? null : status.error ||
        device.error ? (
        <p className="text-destructive text-sm" role="alert">
          Could not load notification settings.
        </p>
      ) : (
        <PageRows>
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconBell />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>Notify this device</ItemTitle>
              <ItemDescription className="line-clamp-none">
                {!status.data.enabled || publicKey === null
                  ? "Not set up on this server. An administrator has to switch notifications on first."
                  : device.data.support !== "ready"
                    ? CANNOT[device.data.support]
                    : device.data.subscribed
                      ? "This device is told when a routine finishes."
                      : "Off. Nothing is sent to this device."}
              </ItemDescription>
            </ItemContent>
            {/* A read-only row where nothing can be switched, and a switch where something can. */}
            {status.data.enabled &&
            publicKey !== null &&
            device.data.support === "ready" ? (
              <ItemActions>
                <Switch
                  aria-label="Notify this device"
                  checked={device.data.subscribed}
                  disabled={busy}
                  onCheckedChange={(on) => {
                    test.reset();
                    if (on) {
                      enable.mutate(publicKey);
                    } else {
                      disable.mutate();
                    }
                  }}
                />
              </ItemActions>
            ) : null}
          </Item>
          {device.data.subscribed ? (
            <>
              <Separator />
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconBellRinging />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>Send a test</ItemTitle>
                  <ItemDescription className="line-clamp-none">
                    {test.data
                      ? testOutcome(test.data)
                      : "Sends a notification to your devices now, to see that it arrives."}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Button
                    disabled={test.isPending}
                    onClick={() => test.mutate()}
                    size="sm"
                    variant="outline"
                  >
                    {test.isPending ? "Sending…" : "Send"}
                  </Button>
                </ItemActions>
              </Item>
            </>
          ) : null}
        </PageRows>
      )}
      {failure ? (
        <p className="mt-3 text-destructive text-sm" role="alert">
          {failure.message}
        </p>
      ) : null}
    </PageSection>
  );
}
