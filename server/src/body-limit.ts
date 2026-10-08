import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";

/**
 * How much a JSON request may say before it is refused.
 *
 * Without a cap, the server read whatever it was sent: a signed-in customer posting a fifty megabyte
 * "agent" had all of it read and parsed before the first check on its contents, and the platform's own
 * ceiling (128 MB a request) was the only limit. A few of those at once is an outage for everybody.
 * The largest legitimate JSON this API takes is a coworker's instructions or a component's page, a
 * few kilobytes to a few hundred, so four megabytes is generous.
 *
 * NOT FOR EVERYTHING. File uploads and audio are not JSON and have their own, larger limits (an image
 * 8 MB, dictation 10 MB, enforced where they are read). The model gateway and the agent runtime carry
 * a whole conversation, with attachments inlined, from a Bot's own computer or the browser: those
 * legitimately run to tens of megabytes and are bounded by the server-wide ceiling in `index.ts`.
 */

export const JSON_BODY_LIMIT_BYTES = 4 * 1024 * 1024;

/** Carries whole conversations, and is bounded by the server-wide ceiling instead. */
const LARGE_PREFIXES = [
  "/api/model-gateway/",
  "/api/copilotkit/",
  "/api/agent-tools/",
];

export function jsonBodyLimit(
  maxSize: number = JSON_BODY_LIMIT_BYTES,
): MiddlewareHandler {
  const limit = bodyLimit({
    maxSize,
    onError: (context) =>
      context.json({ error: "That request is too large." }, 413),
  });
  return async (context, next) => {
    const type = context.req.header("content-type") ?? "";
    if (
      /multipart|audio|octet-stream|^image\//i.test(type) ||
      LARGE_PREFIXES.some((prefix) => context.req.path.startsWith(prefix))
    ) {
      return next();
    }
    return limit(context, next);
  };
}
