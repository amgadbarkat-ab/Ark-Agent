import webpush from "web-push";
import type { PushStore, StoredSubscription } from "./store";

/** The keys that say a message really came from this server. Generated once, by the operator. */
export type VapidConfig = {
  publicKey: string;
  privateKey: string;
  /** A `mailto:` or `https:` address the push service can reach the operator at. */
  subject: string;
};

export type PushMessage = {
  title: string;
  body: string;
  /** A path in the app. The worker refuses anything that is not one. */
  url?: string;
  /** A second message with the same tag replaces the first rather than stacking. */
  tag?: string;
};

/** What the push service answered, as far as it matters here. */
export type PushSend = (
  subscription: StoredSubscription,
  payload: string,
) => Promise<{ statusCode: number }>;

export type PushSender = {
  /** Tell every device a person registered. Never throws: a notification is a courtesy. */
  notify: (
    userId: string,
    message: PushMessage,
  ) => Promise<{ sent: number; removed: number; failed: number }>;
};

const MOST_TITLE = 80;
const MOST_BODY = 200;

const clip = (text: string, most: number) => {
  const points = Array.from(text);
  return points.length <= most
    ? text
    : `${points.slice(0, most - 1).join("")}…`;
};

/** The real send: encrypts for the device and posts to its push service. */
export function webPushSend(vapid: VapidConfig): PushSend {
  const details = {
    vapidDetails: {
      subject: vapid.subject,
      publicKey: vapid.publicKey,
      privateKey: vapid.privateKey,
    },
    // A notification nobody can receive for a day is not worth showing, and the service keeps one for
    // this long at most.
    TTL: 24 * 60 * 60,
    timeout: 10_000,
  };
  return async (subscription, payload) => {
    const response = await webpush.sendNotification(
      {
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      },
      payload,
      details,
    );
    return { statusCode: response.statusCode };
  };
}

export function createPushSender(options: {
  store: PushStore;
  send: PushSend;
}): PushSender {
  const { store, send } = options;
  return {
    async notify(userId, message) {
      const result = { sent: 0, removed: 0, failed: 0 };
      let devices: StoredSubscription[];
      try {
        devices = await store.forUser(userId);
      } catch {
        return result;
      }
      const payload = JSON.stringify({
        title: clip(message.title, MOST_TITLE),
        body: clip(message.body, MOST_BODY),
        ...(message.url ? { url: message.url } : {}),
        ...(message.tag ? { tag: message.tag } : {}),
      });
      await Promise.all(
        devices.map(async (device) => {
          try {
            await send(device, payload);
            result.sent += 1;
          } catch (error) {
            // 404 and 410 are the push service saying this device will never receive anything again:
            // the app was removed or permission was withdrawn. Anything else may pass.
            const status = (error as { statusCode?: number }).statusCode;
            if (status === 404 || status === 410) {
              await store
                .removeEverywhere(device.endpoint)
                .catch(() => undefined);
              result.removed += 1;
            } else {
              result.failed += 1;
              // The kind of failure and nothing of the device: an endpoint is a credential.
              console.error(
                JSON.stringify({
                  type: "push-send-failed",
                  status: status ?? null,
                  reason: error instanceof Error ? error.name : "unknown",
                }),
              );
            }
          }
        }),
      );
      return result;
    },
  };
}
