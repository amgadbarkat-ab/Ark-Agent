import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { readDevice, type DeviceState } from "@/lib/push/device";

/**
 * What the server says about notifications, and what this browser says about itself.
 *
 * They are two reads because they are two facts: whether the server can send at all (it needs keys an
 * operator generated) is the server's, and whether this browser has been given permission and holds a
 * subscription is the browser's. Neither can answer for the other.
 */

export type PushStatus = {
  /** False where the operator has not set the server's push keys. Nothing else here works then. */
  enabled: boolean;
  /** What a browser needs to subscribe. Absent where the server cannot send. */
  publicKey: string | null;
  /** How many of this person's devices are registered, this one or not. */
  devices: number;
};

export type PushTestResult = {
  sent: number;
  removed: number;
  failed: number;
};

export const pushKeys = {
  all: ["push"] as const,
  status: () => [...pushKeys.all, "status"] as const,
  device: () => [...pushKeys.all, "device"] as const,
};

export function pushStatusQueryOptions() {
  return queryOptions({
    queryKey: pushKeys.status(),
    queryFn: async (): Promise<PushStatus> =>
      (
        await client("/api/push", {
          fallback: "Could not load notification settings",
        })
      ).json(),
  });
}

/** This browser's own state. A read like any other, so enabling and disabling can invalidate it. */
export function pushDeviceQueryOptions() {
  return queryOptions({
    queryKey: pushKeys.device(),
    queryFn: (): Promise<DeviceState> => readDevice(),
  });
}
