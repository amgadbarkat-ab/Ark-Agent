/**
 * Ark Link on this install (#149): the one outgoing WebSocket to BlackArk's relay, and what comes
 * over it.
 *
 * Each phone request the relay hands over is checked against this install's own list of paired
 * devices (by the token's SHA-256), then made again on this computer, to this server's own address,
 * exactly as the phone sent it, and the answer streamed back. So the phone gets this install's own app
 * and its own sign-in, and nothing about routes or versions lives on the relay.
 *
 * Knows nothing about the database: {@link ArkLinkDevices} answers who is paired. The service in
 * `service.ts` owns the settings and the device list; this file is the protocol.
 */
import {
  ARK_LINK_LIMITS,
  ARK_LINK_PATHS,
  ARK_LINK_PROTOCOL_VERSION,
  ARK_LINK_VERSION_HEADER,
  DATA_KIND,
  DESK_CLOSE,
  type DeskMessage,
  decodeData,
  decodeRelayMessage,
  encodeControl,
  encodeData,
  type HeaderList,
  type PairRefusal,
  type RelayMessage,
  tokenHash,
} from "../../../shared/ark-link";

export type ArkLinkDevices = {
  /** Whether this device id is paired here with a token of this SHA-256. */
  verify(deviceId: string, tokenSha256: string): Promise<boolean>;
  /** Every paired device, for the relay's routing list. */
  list(): Promise<{ id: string; tokenSha256: string }[]>;
  /** A request from this device was let through. */
  used(deviceId: string): void;
};

export type ArkLinkEvent =
  | {
      type: "claimed";
      pairingId: string;
      deviceName: string;
      expiresAt: string;
    }
  | { type: "ended"; pairingId: string; reason: PairRefusal };

export type ConnectorStatus = "off" | "connecting" | "connected" | "refused";

export type ConnectorOptions = {
  /** `https://link.blackark.uk`. Its host is what the phone sees, and what this server is told. */
  relayUrl: string;
  installToken: string;
  /** This server, on this computer: `http://127.0.0.1:<port>`. */
  localOrigin: string;
  devices: ArkLinkDevices;
  onEvent?: (event: ArkLinkEvent) => void;
  onStatus?: (status: ConnectorStatus, problem: string | null) => void;
  /** Tests only: a relay on http://localhost. */
  allowInsecureRelay?: boolean;
  openSocket?: (url: string, headers: Record<string, string>) => WebSocket;
  maxRequestBytes?: number;
};

/** The relay's desktop socket address, from its https address, or null when it is not one. */
export function deskSocketUrl(
  relayUrl: string,
  allowInsecure = false,
): string | null {
  let url: URL;
  try {
    url = new URL(relayUrl);
  } catch {
    return null;
  }
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (allowInsecure && url.protocol === "http:") url.protocol = "ws:";
  else return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  url.pathname = ARK_LINK_PATHS.desk;
  return url.href;
}

/** Answers this computer adds nothing to: the body is passed on as it came, still compressed. */
const DROP_FROM_RESPONSE = new Set([
  "content-length",
  "transfer-encoding",
  "connection",
]);

type HttpLocal = {
  kind: "http";
  deviceId: string;
  abort: AbortController;
  body: Uint8Array[];
  bytes: number;
  head: Extract<RelayMessage, { t: "req" }>;
};
type WsLocal = {
  kind: "ws";
  deviceId: string;
  socket?: WebSocket;
  queue: (string | Uint8Array)[];
};
type Local = HttpLocal | WsLocal;

const json401 = JSON.stringify({
  error: "This phone is no longer paired with this computer.",
  code: "ark_link_not_paired",
});

export function createArkLinkConnector(options: ConnectorOptions) {
  const maxRequestBytes =
    options.maxRequestBytes ?? ARK_LINK_LIMITS.maxRequestBytes;
  const relayHost = new URL(options.relayUrl).host;
  const localOrigin = options.localOrigin.replace(/\/+$/, "");
  const openSocket =
    options.openSocket ??
    ((url: string, headers: Record<string, string>) =>
      new WebSocket(url, { headers } as never));

  let socket: WebSocket | null = null;
  let stopped = true;
  let status: ConnectorStatus = "off";
  let problem: string | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let backoff = 1000;
  const locals = new Map<number, Local>();
  const starts = new Map<
    string,
    {
      resolve: (value: { code: string; expiresAt: string }) => void;
      reject: (error: Error) => void;
    }
  >();

  function setStatus(next: ConnectorStatus, sentence: string | null) {
    status = next;
    problem = sentence;
    options.onStatus?.(next, sentence);
  }

  function send(message: DeskMessage) {
    if (socket?.readyState === WebSocket.OPEN)
      socket.send(encodeControl(message));
  }

  async function sendData(
    kind: (typeof DATA_KIND)[keyof typeof DATA_KIND],
    s: number,
    bytes: Uint8Array,
  ) {
    for (
      let at = 0;
      at < bytes.byteLength;
      at += ARK_LINK_LIMITS.maxChunkBytes
    ) {
      // Wait while the socket is backed up, rather than hold a whole answer in memory.
      while (socket && socket.bufferedAmount > 8 * 1024 * 1024)
        await Bun.sleep(10);
      if (socket?.readyState !== WebSocket.OPEN) return;
      socket.send(
        encodeData(
          kind,
          s,
          bytes.subarray(at, at + ARK_LINK_LIMITS.maxChunkBytes),
        ),
      );
    }
  }

  function refuse(s: number) {
    send({
      t: "res",
      s,
      status: 401,
      headers: [["content-type", "application/json"]],
    });
    void sendData(DATA_KIND.body, s, new TextEncoder().encode(json401)).then(
      () => send({ t: "end", s }),
    );
  }

  /** The phone's headers, told where it came from, the way any reverse proxy tells it. */
  function localHeaders(list: HeaderList): Headers {
    const headers = new Headers();
    for (const [name, value] of list) headers.append(name, value);
    headers.set("x-forwarded-host", relayHost);
    headers.set("x-forwarded-proto", "https");
    return headers;
  }

  async function allowed(
    message: Extract<RelayMessage, { t: "req" }>,
  ): Promise<boolean> {
    try {
      const ok = await options.devices.verify(
        message.device.id,
        await tokenHash(message.device.token),
      );
      if (ok) options.devices.used(message.device.id);
      return ok;
    } catch {
      return false;
    }
  }

  async function onRequest(message: Extract<RelayMessage, { t: "req" }>) {
    if (message.ws) {
      const local: WsLocal = {
        kind: "ws",
        deviceId: message.device.id,
        queue: [],
      };
      locals.set(message.s, local);
      if (!(await allowed(message))) {
        locals.delete(message.s);
        send({ t: "ws.close", s: message.s, code: 4401, reason: "not paired" });
        void syncDevices();
        return;
      }
      openLocalSocket(message, local);
      return;
    }
    const local: HttpLocal = {
      kind: "http",
      deviceId: message.device.id,
      abort: new AbortController(),
      body: [],
      bytes: 0,
      head: message,
    };
    locals.set(message.s, local);
    if (!message.body) await respond(message.s, local);
  }

  async function respond(s: number, local: HttpLocal) {
    if (!(await allowed(local.head))) {
      locals.delete(s);
      refuse(s);
      void syncDevices();
      return;
    }
    const head = local.head;
    let response: Response;
    try {
      response = await fetch(`${localOrigin}${head.path}`, {
        method: head.method,
        headers: localHeaders(head.headers),
        body: local.body.length ? Buffer.concat(local.body) : undefined,
        redirect: "manual",
        signal: local.abort.signal,
        decompress: false,
      } as RequestInit);
    } catch {
      if (locals.get(s) !== local) return;
      locals.delete(s);
      send({
        t: "res",
        s,
        status: 502,
        headers: [["content-type", "text/plain; charset=utf-8"]],
      });
      await sendData(
        DATA_KIND.body,
        s,
        new TextEncoder().encode("ArkAgent on this computer did not answer."),
      );
      send({ t: "end", s });
      return;
    }
    if (locals.get(s) !== local) {
      void response.body?.cancel();
      return;
    }
    const headers: HeaderList = [];
    response.headers.forEach((value, name) => {
      if (!DROP_FROM_RESPONSE.has(name.toLowerCase()))
        headers.push([name, value]);
    });
    for (const cookie of response.headers.getSetCookie?.() ?? [])
      if (!headers.some(([n, v]) => n === "set-cookie" && v === cookie))
        headers.push(["set-cookie", cookie]);
    send({ t: "res", s, status: response.status, headers });
    try {
      if (response.body)
        for await (const chunk of response.body) {
          if (locals.get(s) !== local) return;
          await sendData(DATA_KIND.body, s, chunk);
        }
    } catch {
      // The phone went away, or this server stopped mid-answer: end it either way.
    }
    if (locals.get(s) === local) {
      locals.delete(s);
      send({ t: "end", s });
    }
  }

  function openLocalSocket(
    message: Extract<RelayMessage, { t: "req" }>,
    local: WsLocal,
  ) {
    const headers: Record<string, string> = {};
    localHeaders(message.headers).forEach((value, name) => {
      headers[name] = value;
    });
    let upstream: WebSocket;
    try {
      upstream = new WebSocket(
        `${localOrigin.replace(/^http/, "ws")}${message.path}`,
        {
          headers,
          ...(message.ws?.protocols.length
            ? { protocols: message.ws.protocols }
            : {}),
        } as never,
      );
    } catch {
      locals.delete(message.s);
      send({ t: "ws.close", s: message.s, code: 1011, reason: "no answer" });
      return;
    }
    upstream.binaryType = "arraybuffer";
    local.socket = upstream;
    let opened = false;
    upstream.onopen = () => {
      opened = true;
      if (locals.get(message.s) !== local) return upstream.close();
      send({ t: "ws.accept", s: message.s, protocol: upstream.protocol ?? "" });
      for (const queued of local.queue) upstream.send(queued);
      local.queue = [];
    };
    upstream.onmessage = (event) => {
      if (locals.get(message.s) !== local) return;
      if (typeof event.data === "string")
        void sendData(
          DATA_KIND.wsText,
          message.s,
          new TextEncoder().encode(event.data),
        );
      else
        void sendData(
          DATA_KIND.wsBinary,
          message.s,
          new Uint8Array(event.data as ArrayBuffer),
        );
    };
    upstream.onclose = (event) => {
      if (locals.get(message.s) !== local) return;
      locals.delete(message.s);
      const code =
        event.code >= 1000 &&
        event.code <= 4999 &&
        event.code !== 1005 &&
        event.code !== 1006
          ? event.code
          : 1011;
      send({
        t: "ws.close",
        s: message.s,
        code: opened ? code : 1011,
        reason: (event.reason ?? "").slice(0, 123),
      });
    };
    upstream.onerror = () => undefined;
  }

  function onData(raw: ArrayBuffer) {
    const frame = decodeData(raw);
    if (!frame) return;
    const local = locals.get(frame.stream);
    if (!local) return;
    if (local.kind === "http") {
      if (frame.kind !== DATA_KIND.body) return;
      local.bytes += frame.payload.byteLength;
      if (local.bytes > maxRequestBytes) {
        locals.delete(frame.stream);
        send({ t: "res", s: frame.stream, status: 413, headers: [] });
        send({ t: "end", s: frame.stream });
        return;
      }
      local.body.push(frame.payload.slice());
      return;
    }
    const payload =
      frame.kind === DATA_KIND.wsText
        ? new TextDecoder().decode(frame.payload)
        : frame.payload.slice();
    if (local.socket?.readyState === WebSocket.OPEN) local.socket.send(payload);
    else local.queue.push(payload);
  }

  function closeLocal(s: number, code = 1000, reason = "") {
    const local = locals.get(s);
    if (!local) return;
    locals.delete(s);
    if (local.kind === "http") local.abort.abort();
    else
      local.socket?.close(code >= 3000 || code === 1000 ? code : 1000, reason);
  }

  function onMessage(text: string) {
    const message = decodeRelayMessage(text);
    if (!message) return;
    switch (message.t) {
      case "hello":
        if (message.v !== ARK_LINK_PROTOCOL_VERSION) return;
        backoff = 1000;
        setStatus("connected", null);
        void syncDevices();
        return;
      case "req":
        void onRequest(message);
        return;
      case "end": {
        const local = locals.get(message.s);
        if (local?.kind === "http") void respond(message.s, local);
        return;
      }
      case "cancel":
        closeLocal(message.s);
        return;
      case "ws.close":
        closeLocal(message.s, message.code, message.reason);
        return;
      case "pair.started": {
        const waiting = starts.get(message.id);
        starts.delete(message.id);
        waiting?.resolve({ code: message.code, expiresAt: message.expiresAt });
        return;
      }
      case "pair.claimed":
        options.onEvent?.({
          type: "claimed",
          pairingId: message.pairingId,
          deviceName: message.deviceName,
          expiresAt: message.expiresAt,
        });
        return;
      case "pair.ended":
        options.onEvent?.({
          type: "ended",
          pairingId: message.pairingId,
          reason: message.reason,
        });
        return;
      case "ping":
        send({ t: "pong", at: message.at });
        return;
    }
  }

  async function syncDevices() {
    try {
      send({ t: "devices", devices: await options.devices.list() });
    } catch {
      // The next change or reconnect sends it again.
    }
  }

  function schedule() {
    if (stopped) return;
    if (retry) clearTimeout(retry);
    retry = setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 60_000);
  }

  function connect() {
    if (stopped) return;
    const url = deskSocketUrl(options.relayUrl, options.allowInsecureRelay);
    if (!url) {
      setStatus(
        "refused",
        "The relay address must be https://<host>, with nothing after it.",
      );
      return;
    }
    setStatus("connecting", problem);
    let opened: WebSocket;
    try {
      opened = openSocket(url, {
        authorization: `Bearer ${options.installToken}`,
        [ARK_LINK_VERSION_HEADER]: String(ARK_LINK_PROTOCOL_VERSION),
      });
    } catch {
      setStatus("connecting", "The relay could not be reached. Trying again.");
      return schedule();
    }
    opened.binaryType = "arraybuffer";
    socket = opened;
    opened.onmessage = (event) => {
      if (socket !== opened) return;
      if (typeof event.data === "string") onMessage(event.data);
      else onData(event.data as ArrayBuffer);
    };
    opened.onclose = (event) => {
      if (socket !== opened) return;
      socket = null;
      for (const s of [...locals.keys()]) closeLocal(s, 1001, "relay gone");
      for (const waiting of starts.values())
        waiting.reject(new Error("The relay connection dropped."));
      starts.clear();
      if (stopped) return;
      if (event.code === DESK_CLOSE.replaced) {
        setStatus(
          "refused",
          "Another computer connected to the relay with this install token.",
        );
        return;
      }
      if (event.code === DESK_CLOSE.removed) {
        setStatus("refused", "BlackArk's relay no longer knows this install.");
        return;
      }
      if (event.code === DESK_CLOSE.version) {
        setStatus(
          "refused",
          "The relay speaks a different version of Ark Link. Update ArkAgent.",
        );
        return;
      }
      setStatus(
        "connecting",
        status === "connected"
          ? "The relay connection dropped. Trying again."
          : "The relay could not be reached, or it refused this install token. Trying again.",
      );
      schedule();
    };
    opened.onerror = () => undefined;
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      backoff = 1000;
      connect();
    },
    stop() {
      stopped = true;
      if (retry) clearTimeout(retry);
      retry = null;
      const old = socket;
      socket = null;
      for (const s of [...locals.keys()]) closeLocal(s, 1001, "stopping");
      old?.close(1000);
      setStatus("off", null);
    },
    get status() {
      return status;
    },
    get problem() {
      return problem;
    },
    /** Asks the relay for a pairing code. */
    startPairing(
      timeoutMs = 10_000,
    ): Promise<{ code: string; expiresAt: string }> {
      if (status !== "connected")
        return Promise.reject(new Error("The relay is not connected."));
      const id = crypto.randomUUID().replace(/-/g, "");
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          starts.delete(id);
          reject(new Error("The relay did not answer."));
        }, timeoutMs);
        starts.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        send({ t: "pair.start", id });
      });
    },
    confirm(
      pairingId: string,
      device: { id: string; name: string; tokenSha256: string },
      token: string,
    ) {
      send({ t: "pair.confirm", pairingId, device, token });
    },
    refuse(pairingId: string) {
      send({ t: "pair.refuse", pairingId });
    },
    syncDevices,
    /** Ends every open request and socket of a device that was just removed. */
    cut(deviceId: string) {
      for (const [s, local] of [...locals])
        if (local.deviceId === deviceId) {
          closeLocal(s, 4401, "removed");
          if (local.kind === "ws")
            send({ t: "ws.close", s, code: 4401, reason: "removed" });
          else refuse(s);
        }
    },
  };
}

export type ArkLinkConnector = ReturnType<typeof createArkLinkConnector>;
