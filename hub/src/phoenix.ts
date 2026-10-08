/**
 * The Phoenix channels wire format (serializer 2.0.0), which the CopilotKit SDK's runner and
 * browser client both speak. A frame is a five-element JSON array:
 *
 *   [join_ref, ref, topic, event, payload]
 */

export type Frame = [
  joinRef: string | null,
  ref: string | null,
  topic: string,
  event: string,
  payload: unknown,
];

export function decodeFrame(raw: string | Buffer): Frame | null {
  let value: unknown;
  try {
    value = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
  } catch {
    return null;
  }
  if (!Array.isArray(value) || value.length !== 5) return null;
  const [joinRef, ref, topic, event, payload] = value;
  if (typeof topic !== "string" || typeof event !== "string") return null;
  if (joinRef !== null && typeof joinRef !== "string") return null;
  if (ref !== null && typeof ref !== "string") return null;
  return [joinRef, ref, topic, event, payload];
}

export const encodeFrame = (frame: Frame) => JSON.stringify(frame);

/** An answer to a client's message, matched to it by `ref`. */
export function replyFrame(
  joinRef: string | null,
  ref: string | null,
  topic: string,
  status: "ok" | "error",
  response: unknown = {},
): string {
  return encodeFrame([joinRef, ref, topic, "phx_reply", { status, response }]);
}

/** A message the server starts, to everyone on a topic. */
export const pushFrame = (topic: string, event: string, payload: unknown) =>
  encodeFrame([null, null, topic, event, payload]);

/** The subprotocol token the SDK's runner sends its bearer credential in. */
const AUTH_PREFIX = "base64url.bearer.phx.";

/**
 * The bearer token a Phoenix client offered in `Sec-WebSocket-Protocol`, if any.
 *
 * The client sends `phoenix, base64url.bearer.phx.<token>` with the token base64-encoded and its
 * padding removed.
 */
export function bearerFromProtocols(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(",").map((p) => p.trim())) {
    if (part.startsWith(AUTH_PREFIX)) {
      try {
        const encoded = part.slice(AUTH_PREFIX.length);
        const padded = encoded + "=".repeat((4 - (encoded.length % 4)) % 4);
        return Buffer.from(padded, "base64").toString("utf8");
      } catch {
        return null;
      }
    }
  }
  return null;
}
