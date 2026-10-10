/**
 * This browser's side of notifications: whether it can show them, whether it has been allowed to, and
 * whether it is subscribed. Nothing here talks to the server; `mutations.ts` does that with what this
 * returns.
 *
 * Why it is separate: the browser's answers depend on the platform, and the platform is the part that
 * differs from phone to phone. On an iPhone or iPad a web page can receive notifications only after
 * it has been added to the Home Screen, and before that the browser does not even have the API, so
 * "unsupported" would be the wrong thing to tell somebody who only needs to install it.
 */

export type DeviceSupport =
  /** This browser can be subscribed now. */
  | "ready"
  /** No notification support at all in this browser. */
  | "unsupported"
  /** iPhone or iPad, and not yet opened from the Home Screen. */
  | "needs-install"
  /** The person said no to this site in the browser. Only they can undo that, in its settings. */
  | "blocked";

export type DeviceState = {
  support: DeviceSupport;
  /** Whether this browser holds a subscription now. */
  subscribed: boolean;
};

type Environment = {
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
  standalone: boolean;
  hasServiceWorker: boolean;
  hasPush: boolean;
  hasNotification: boolean;
  permission: NotificationPermission | undefined;
};

function environment(): Environment {
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  const win = typeof window === "undefined" ? undefined : window;
  return {
    userAgent: nav?.userAgent ?? "",
    platform: nav?.platform ?? "",
    maxTouchPoints: nav?.maxTouchPoints ?? 0,
    standalone:
      win?.matchMedia?.("(display-mode: standalone)").matches === true ||
      (nav as { standalone?: boolean } | undefined)?.standalone === true,
    hasServiceWorker: nav !== undefined && "serviceWorker" in nav,
    hasPush: win !== undefined && "PushManager" in win,
    hasNotification: win !== undefined && "Notification" in win,
    permission:
      win !== undefined && "Notification" in win
        ? Notification.permission
        : undefined,
  };
}

/** An iPad that says it is a Mac is told apart from a Mac by having a touch screen. */
function isApplePhoneOrTablet(env: Environment): boolean {
  return (
    /iPad|iPhone|iPod/.test(env.userAgent) ||
    (env.platform === "MacIntel" && env.maxTouchPoints > 1)
  );
}

/** Pure, so each platform's answer can be tested without that platform. */
export function supportFrom(env: Environment): DeviceSupport {
  if (isApplePhoneOrTablet(env) && !env.standalone) return "needs-install";
  if (!env.hasServiceWorker || !env.hasPush || !env.hasNotification) {
    return "unsupported";
  }
  if (env.permission === "denied") return "blocked";
  return "ready";
}

export async function readDevice(): Promise<DeviceState> {
  const env = environment();
  const support = supportFrom(env);
  if (support === "unsupported" || support === "needs-install") {
    return { support, subscribed: false };
  }
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    return { support, subscribed: subscription != null };
  } catch {
    return { support, subscribed: false };
  }
}

/** The key as a browser wants it: bytes, from the URL-safe text the server serves. */
export function applicationServerKey(
  publicKey: string,
): Uint8Array<ArrayBuffer> {
  const padded = publicKey
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(publicKey.length / 4) * 4, "=");
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index += 1) {
    bytes[index] = raw.charCodeAt(index);
  }
  return bytes;
}

/** What the server needs to know about a subscription, and nothing the browser would not share. */
export type SubscriptionRecord = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

function recordOf(subscription: PushSubscription): SubscriptionRecord {
  const json = subscription.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!json.endpoint || !p256dh || !auth) {
    throw new Error(
      "This browser gave notification details that are not usable",
    );
  }
  return { endpoint: json.endpoint, keys: { p256dh, auth } };
}

/**
 * Ask permission and subscribe this browser. Must run from a click: browsers refuse the prompt
 * otherwise, and an iPhone refuses it silently.
 */
export async function subscribeDevice(
  publicKey: string,
): Promise<{ record: SubscriptionRecord; unsubscribe: () => Promise<void> }> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error(
      permission === "denied"
        ? "Notifications are blocked for this site. Allow them in the browser's settings and try again."
        : "Notifications were not allowed.",
    );
  }
  const registration =
    (await navigator.serviceWorker.getRegistration()) ??
    (await navigator.serviceWorker.register("/sw.js"));
  await navigator.serviceWorker.ready;
  let subscription: PushSubscription;
  try {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: applicationServerKey(publicKey),
    });
  } catch {
    // The browser's own sentence ("Registration failed - push service error") says nothing a person
    // can act on, and differs between browsers.
    throw new Error(
      "This browser could not register with its notification service. Check your connection and the browser's notification settings, then try again.",
    );
  }
  return {
    record: recordOf(subscription),
    unsubscribe: async () => {
      await subscription.unsubscribe();
    },
  };
}

/** This browser's current subscription, for the server to be told to forget it. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.getRegistration();
  return (await registration?.pushManager.getSubscription()) ?? null;
}
