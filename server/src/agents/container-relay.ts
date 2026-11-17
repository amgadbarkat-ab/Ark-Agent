/**
 * Whether the containers can still reach this server (#109, DT item 3).
 *
 * On Linux with Docker Engine the desktop app relays the Docker bridge's address to the server on
 * loopback (desktop/src-tauri/src/bridge.rs), and tells the server where in ARK_CONTAINER_RELAY.
 * Closing the app takes the relay with it, while the server keeps running: an employee in a
 * container then failed with nothing but "Connection error". This checks the relay before such an
 * employee runs, so it can say to open ArkAgent instead.
 *
 * Unset (every other machine, and every deployment that is not the desktop app): always reachable.
 */
import { connect } from "node:net";

export const RELAY_DOWN_MESSAGE =
  "ArkAgent is not open, so {name} cannot work right now. Open ArkAgent on this computer, then send your message again.";

/** How long one answer is trusted, so a burst of loads costs one connection. */
const FRESH_MS = 5_000;

function parse(
  value: string | undefined,
): { host: string; port: number } | null {
  const match = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(
    value?.trim() ?? "",
  );
  if (!match?.[1] || !match[2]) return null;
  const port = Number(match[2]);
  return port > 0 && port < 65_536 ? { host: match[1], port } : null;
}

function answers(host: string, port: number, timeoutMs: number) {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

export function containerRelayCheck(
  value: string | undefined,
  options: { timeoutMs?: number; now?: () => number } = {},
): () => Promise<boolean> {
  const target = parse(value);
  if (!target) return async () => true;
  const now = options.now ?? Date.now;
  let last: { at: number; up: boolean } | null = null;
  return async () => {
    if (last && now() - last.at < FRESH_MS) return last.up;
    const up = await answers(
      target.host,
      target.port,
      options.timeoutMs ?? 1_000,
    );
    last = { at: now(), up };
    return up;
  };
}
