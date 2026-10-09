import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AppVariables } from "../auth/guards";
import { isAllowedPushEndpoint } from "./endpoints";
import type { PushSender } from "./sender";
import type { PushStore } from "./store";

type Middleware = MiddlewareHandler<{ Variables: AppVariables }>;

/** How long between two test notifications to the same person, so a button cannot become a hose. */
const TEST_EVERY_MS = 10_000;

const keyField = z
  .string()
  .min(8)
  .max(512)
  // base64url, which is what a browser gives
  .regex(/^[A-Za-z0-9_-]+={0,2}$/);

const subscriptionBody = z.strictObject({
  endpoint: z.string().max(2048),
  keys: z.strictObject({ p256dh: keyField, auth: keyField }),
});

const removalBody = z.strictObject({ endpoint: z.string().max(2048) });

/**
 * A person's own devices for notifications.
 *
 * Everything is the signed-in person's: they register their own browser, remove their own, and test
 * their own. The keys a browser gives are never returned.
 */
export function pushRoutes(options: {
  requireUser: Middleware;
  store: PushStore;
  sender: PushSender;
  /** The public half of the server's push key, which the browser needs to subscribe. */
  publicKey: string;
  extraHosts?: readonly string[];
  now?: () => number;
}) {
  const { requireUser, store, sender, publicKey } = options;
  const extraHosts = options.extraHosts ?? [];
  const now = options.now ?? Date.now;
  const lastTest = new Map<string, number>();
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", requireUser);

  app.get("/", async (context) =>
    context.json({
      enabled: true,
      publicKey,
      devices: await store.count(context.var.actor.id),
    }),
  );

  app.put("/subscription", async (context) => {
    const parsed = subscriptionBody.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (!parsed.success) {
      return context.json(
        { error: "That is not a notification subscription." },
        400,
      );
    }
    if (!isAllowedPushEndpoint(parsed.data.endpoint, extraHosts)) {
      return context.json(
        {
          error: "That address is not one this server sends notifications to.",
        },
        400,
      );
    }
    await store.save(context.var.actor.id, {
      endpoint: parsed.data.endpoint,
      p256dh: parsed.data.keys.p256dh,
      auth: parsed.data.keys.auth,
    });
    return context.json({ ok: true });
  });

  app.delete("/subscription", async (context) => {
    const parsed = removalBody.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (!parsed.success) {
      return context.json(
        { error: "Say which device to stop notifying." },
        400,
      );
    }
    // The same answer whether it was theirs, someone else's or nobody's: a device is not something
    // to be found out about by asking.
    await store.remove(context.var.actor.id, parsed.data.endpoint);
    return context.json({ ok: true });
  });

  app.post("/test", async (context) => {
    const userId = context.var.actor.id;
    const last = lastTest.get(userId);
    if (last !== undefined && now() - last < TEST_EVERY_MS) {
      return context.json({ error: "Wait a few seconds and try again." }, 429);
    }
    lastTest.set(userId, now());
    const result = await sender.notify(userId, {
      title: "Notifications are on",
      body: "This is how Ark will tell you when your digital employees finish something.",
      url: "/",
      tag: "test",
    });
    return context.json(result);
  });

  return app;
}
