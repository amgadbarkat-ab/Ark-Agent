/**
 * The company's computer's side of BlackArk's staff relay (remote staff, v0.1.56).
 *
 * While remote staff is switched on, this keeps one WebSocket open to the relay, presenting this
 * install's BlackArk licence, the office's host key and the hash of the staff access key. When a
 * staff computer connects through the relay, the relay says so on that socket; this then opens a
 * second WebSocket for that connection and a TCP connection to this computer's own office listener
 * on loopback, and passes bytes between them.
 *
 * What it carries is the staff computer's TLS connection to the office listener, encrypted end to
 * end: the relay never sees inside it, and this side never looks inside it either. The office
 * listener does everything it does for the office network: its certificate, the Host check, the
 * sign-in limits counted as the office network's, and each person's own sign-in.
 */
import { createHash } from "node:crypto";
import net from "node:net";

export type RemoteHostStatus = {
  connected: boolean;
  error: string | null;
};

/** At most this many relayed connections are opened at once, whatever the relay asks. */
export const MAX_CARRIED = 128;

/** The relay's own address for plain requests, from its WebSocket address. */
export function relayHttpUrl(relayUrl: string): string {
  return relayUrl.replace(/\/+$/, "").replace(/^ws(s?):/, "http$1:");
}

/**
 * Tells the relay to forget this office: its keys' hashes and its customer id. Done when remote
 * staff is switched off and before a new join code starts a new office. Never fatal: the relay may
 * be unreachable, and then it keeps no more than it already had.
 */
export async function forgetOffice(
  relayUrl: string,
  office: string,
  hostKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const answer = await fetchImpl(
      `${relayHttpUrl(relayUrl)}/v1/forget?office=${encodeURIComponent(office)}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${hostKey}` },
        signal: AbortSignal.timeout(10_000),
      },
    );
    return answer.ok;
  } catch {
    return false;
  }
}

type Socketish = WebSocket;
type MakeSocket = (url: string, headers: Record<string, string>) => Socketish;

const PING_MS = 30_000;
const MAX_BACKOFF_MS = 60_000;

/** What the relay's refusal codes mean to the administrator. */
export function relayRefusal(code: number): string | null {
  switch (code) {
    case 4401:
      return "BlackArk's relay did not accept this ArkAgent's licence. Remote staff needs a licence key or trial activation code that is still valid.";
    case 4403:
      return "BlackArk's relay refused this ArkAgent. Make a new join code, then give it to your staff again.";
    case 4400:
      return "BlackArk's relay refused the connection. Update ArkAgent, then switch remote staff on again.";
    default:
      return null;
  }
}

export function startRemoteHost(options: {
  relayUrl: string;
  office: string;
  hostKey: string;
  accessKey: string;
  /** This install's `ARK1-` licence key or trial activation code, or null when it has none. */
  licence: () => Promise<string | null>;
  /** The office listener's port on loopback, or null while it is closed. */
  listenerPort: () => number | null;
  /** Called once the relay has accepted this computer as its office's own. */
  onWelcome?: () => void;
  makeSocket?: MakeSocket;
  log?: (line: string) => void;
}) {
  const makeSocket: MakeSocket =
    options.makeSocket ??
    ((url, headers) => new WebSocket(url, { headers } as never));
  const log = options.log ?? (() => {});
  const accessHash = createHash("sha256")
    .update(options.accessKey)
    .digest("hex");
  const base = options.relayUrl.replace(/\/+$/, "");
  const query = `office=${encodeURIComponent(options.office)}`;
  let control: Socketish | null = null;
  let stopped = false;
  let connected = false;
  let error: string | null = null;
  let backoff = 1000;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let ping: ReturnType<typeof setInterval> | null = null;
  const streams = new Set<{ close: () => void }>();

  function carry(stream: string) {
    const port = options.listenerPort();
    if (port === null || streams.size >= MAX_CARRIED) return;
    const up = makeSocket(
      `${base}/v1/stream?${query}&stream=${encodeURIComponent(stream)}`,
      { authorization: `Bearer ${options.hostKey}` },
    );
    up.binaryType = "arraybuffer";
    const local = net.connect({ host: "127.0.0.1", port });
    const held: Buffer[] = [];
    let open = false;
    const entry = {
      close: () => {
        local.destroy();
        try {
          up.close();
        } catch {}
      },
    };
    streams.add(entry);
    const done = () => {
      streams.delete(entry);
      entry.close();
    };
    local.on("data", (chunk: Buffer) => {
      if (open) up.send(chunk);
      else held.push(chunk);
    });
    local.on("error", done);
    local.on("close", done);
    up.onopen = () => {
      open = true;
      for (const chunk of held.splice(0)) up.send(chunk);
    };
    up.onmessage = (event) => {
      if (typeof event.data === "string") return done();
      local.write(Buffer.from(event.data as ArrayBuffer));
    };
    up.onclose = done;
    up.onerror = done;
  }

  async function connect() {
    retry = null;
    if (stopped) return;
    const licence = await options.licence().catch(() => null);
    if (stopped) return;
    if (!licence) {
      error =
        "Remote staff needs this ArkAgent's licence key or trial activation code. Activate ArkAgent first.";
      schedule(MAX_BACKOFF_MS);
      return;
    }
    const socket = makeSocket(`${base}/v1/host?${query}`, {
      authorization: `Bearer ${options.hostKey}`,
      "x-ark-licence": licence,
      "x-ark-access": accessHash,
    });
    control = socket;
    socket.onopen = () => {
      if (control !== socket) return;
      connected = true;
      backoff = 1000;
      log("remote staff: connected to BlackArk's relay");
      ping = setInterval(() => {
        try {
          socket.send("ping");
        } catch {}
      }, PING_MS);
    };
    socket.onmessage = (event) => {
      if (control !== socket || typeof event.data !== "string") return;
      if (event.data === "pong") {
        error = null;
        return;
      }
      if (event.data === "welcome") {
        error = null;
        options.onWelcome?.();
        return;
      }
      try {
        const message = JSON.parse(event.data) as { open?: unknown };
        if (typeof message.open === "string") carry(message.open);
      } catch {}
    };
    socket.onclose = (event) => {
      if (control !== socket) return;
      control = null;
      connected = false;
      if (ping) clearInterval(ping);
      ping = null;
      if (stopped) return;
      const refused = relayRefusal(event.code);
      error =
        refused ??
        (event.code === 1000
          ? null
          : "BlackArk's relay cannot be reached from this computer. Staff on the office network are not affected.");
      if (event.code !== 1000)
        log(`remote staff: relay closed the connection (${event.code})`);
      schedule(refused ? MAX_BACKOFF_MS : backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    };
    socket.onerror = () => {};
  }

  function schedule(ms: number) {
    if (stopped || retry) return;
    retry = setTimeout(() => void connect(), ms);
  }

  void connect();

  return {
    status: (): RemoteHostStatus => ({ connected, error }),
    stop() {
      stopped = true;
      if (retry) clearTimeout(retry);
      if (ping) clearInterval(ping);
      const socket = control;
      control = null;
      connected = false;
      try {
        socket?.close(1000);
      } catch {}
      for (const stream of streams) stream.close();
      streams.clear();
    },
  };
}

export type RemoteHost = ReturnType<typeof startRemoteHost>;
