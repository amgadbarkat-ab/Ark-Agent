/**
 * Loaded into the server process under test (`bun --preload`). Writes down, and refuses, every attempt
 * to reach a CopilotKit host, by any route a process has to the network: `fetch`, a web socket, a raw
 * socket and a name lookup.
 *
 * Why it exists: Ark was built from an upstream product that talked to its maker's hosted services
 * (conversation storage, telemetry, an announcements feed). Independence from them (docs/ark/05-build-plan.md,
 * Phase 1) is not a thing you can read off the code, because the calls live in libraries. So the
 * server is started with this in front of the network, the suite drives it, and the file it writes
 * must be empty. Refused rather than only logged, so what the server does when those hosts are
 * unreachable is exercised too.
 */
import dns from "node:dns";
import net from "node:net";
import { appendFileSync } from "node:fs";

const FORBIDDEN = /(^|\.)copilotkit\.(ai|com|dev|app)$/i;
const log = process.env.ARK_TRIPWIRE_LOG;

function trip(how: string, host: string | undefined): void {
  if (!host || !FORBIDDEN.test(host)) return;
  if (log) appendFileSync(log, `${how} ${host}\n`);
  throw new Error(`The tripwire refused a connection to ${host} (${how}).`);
}

const hostOfUrl = (input: unknown): string | undefined => {
  try {
    const value =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as { url?: string } | undefined)?.url;
    return value ? new URL(value).hostname : undefined;
  } catch {
    return undefined;
  }
};

const realFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    trip("fetch", hostOfUrl(input));
    return realFetch(input, init);
  },
  realFetch,
) as typeof fetch;

const RealWebSocket = globalThis.WebSocket;
globalThis.WebSocket = new Proxy(RealWebSocket, {
  construct(target, args, newTarget) {
    trip("websocket", hostOfUrl(args[0]));
    return Reflect.construct(target, args, newTarget);
  },
}) as typeof WebSocket;

const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
  const first = args[0] as { host?: string } | number | string | undefined;
  if (first && typeof first === "object") trip("socket", first.host);
  else if (typeof args[1] === "string") trip("socket", args[1]);
  return (realConnect as (...a: unknown[]) => net.Socket).apply(this, args);
} as typeof net.Socket.prototype.connect;

const realLookup = dns.lookup;
dns.lookup = ((hostname: string, ...rest: unknown[]) => {
  try {
    trip("dns", hostname);
  } catch (error) {
    const callback = rest.find((value) => typeof value === "function") as
      | ((error: Error) => void)
      | undefined;
    if (callback) {
      queueMicrotask(() => callback(error as Error));
      return;
    }
    throw error;
  }
  return (realLookup as (...a: unknown[]) => unknown)(hostname, ...rest);
}) as typeof dns.lookup;
