/**
 * BlackArk's staff relay (Amgad, 25 Nov 2026: remote staff, v0.1.56). A staff member working away
 * from the office reaches the company's ArkAgent through this Cloudflare Worker, the same way they
 * would on the office network.
 *
 *   company's computer ── wss /v1/host (licence + host key) ──▶ Worker ──▶ that office's object
 *   staff computer ────── wss /v1/connect (access key) ──────▶ Worker ──▶ the object asks the host
 *   company's computer ── wss /v1/stream (host key) ─────────▶ Worker ──▶ paired with that staff stream
 *
 * IT CARRIES BYTES IT CANNOT READ. Each staff connection is one TLS connection from the staff
 * computer to the company's computer's own office listener. The staff computer checks that
 * listener's certificate by the fingerprint in its join code, before it sends a byte, exactly as on
 * the office network. This relay only moves the encrypted bytes between two WebSockets: it never
 * holds a key, and it cannot see passwords, cookies, pages or chats.
 *
 * WHO MAY USE IT.
 * - A host must present a BlackArk licence key or trial activation code, signed by BlackArk, that
 *   has not run out. The signature is checked here with BlackArk's public keys.
 * - The first host to register an office id holds it: the object keeps the SHA-256 of its host
 *   key, and refuses any other host key for that office afterwards. Office ids are random.
 * - A staff computer must present the office's access key, which only the join code carries. The
 *   object keeps the SHA-256 the host gave it. The access key admits nobody to ArkAgent itself:
 *   each person still signs in with their own email and password, over that TLS connection.
 *
 * Hibernation: the object sleeps between messages, and the host's keep-alive ping is answered by
 * the runtime without waking it, so an idle office costs nothing.
 */

import { LICENSE_PUBLIC_KEYS } from "../../shared/license-public-key";
import { TRIAL_PUBLIC_KEYS } from "../../shared/trial-public-key";
import type {
  CfWebSocket,
  DurableObjectNamespace,
  DurableObjectState,
} from "../phone-relay/worker/types";

export type Env = {
  OFFICE: DurableObjectNamespace;
};

/** What differs between the Workers runtime and the one the tests run on. */
export type RelayPlatform = {
  socketPair(): { client: CfWebSocket; server: CfWebSocket };
  autoResponse(request: string, response: string): unknown;
  upgraded(client: CfWebSocket): Response;
  now?: () => number;
  log(line: string): void;
  /** How long a staff connection may wait for the host; PAIRING_MS unless a test says. */
  pairingMs?: number;
  /** BlackArk's public keys, base64 of 32 bytes each. The tests give their own. */
  keys?: { license: readonly string[]; trial: readonly string[] };
};

export const PING = "ping";
export const PONG = "pong";
export const READY = "ready";
/** At most this many staff connections open at once per office. */
export const MAX_STREAMS = 96;
/** A staff connection the company's computer has not taken up by then is closed. */
export const PAIRING_MS = 15_000;
/** Cloudflare refuses a WebSocket message above 1 MiB; nothing here sends one near it. */
const MAX_MESSAGE = 1024 * 1024;

/** Random ids and keys: base64url, 22 to 64 characters (128 to 384 bits). */
export const OFFICE_ID = /^[A-Za-z0-9_-]{22,64}$/;
const KEY = /^[A-Za-z0-9_-]{22,128}$/;
const STREAM_ID = /^[A-Za-z0-9_-]{16,32}$/;
const HASH = /^[0-9a-f]{64}$/;
const CUSTOMER = /^[a-z0-9][a-z0-9-]{1,63}$/;

/** Headers only the Worker sets on its requests to the object, after checking what they say. */
const VERIFIED = "x-staff-relay-verified";

export const CLOSE = {
  /** No licence, an unsigned one, or one that has run out. */
  licence: 4401,
  /** The office id is held by another host key, or the access key is wrong. */
  refused: 4403,
  /** The company's computer is not connected to the relay. */
  noHost: 4404,
  /** Too many staff connections at once. */
  busy: 4429,
  /** The company's computer did not take the connection up in time. */
  timeout: 4408,
  /** Something sent that this relay does not carry. */
  protocol: 4400,
} as const;

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const normal = text.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normal + "=".repeat((4 - (normal.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function signedBy(
  keys: readonly string[],
  payload: string,
  signature: string,
): Promise<boolean> {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = fromBase64(signature);
  } catch {
    return false;
  }
  if (bytes.length !== 64) return false;
  const data = new TextEncoder().encode(payload);
  for (const encoded of keys) {
    try {
      const raw = fromBase64(encoded);
      if (raw.length !== 32) continue;
      const key = await crypto.subtle.importKey(
        "raw",
        raw,
        { name: "Ed25519" },
        false,
        ["verify"],
      );
      if (await crypto.subtle.verify("Ed25519", key, bytes, data)) return true;
    } catch {
      // A key this runtime cannot read is no key.
    }
  }
  return false;
}

export type CheckedLicence = { customer: string; validUntil: number };

/**
 * The customer and end of a BlackArk licence key or trial activation code (`ARK1-<payload>.<sig>`),
 * or null unless BlackArk signed it and it has not run out. The same rules as the app's own
 * activation (`shared/activation.ts`): a licence key with the licence keys, a trial code with the
 * trial keys.
 */
export async function checkLicence(
  typed: string,
  now: number,
  keys: { license: readonly string[]; trial: readonly string[] } = {
    license: LICENSE_PUBLIC_KEYS,
    trial: TRIAL_PUBLIC_KEYS,
  },
): Promise<CheckedLicence | null> {
  const compact = typed.replace(/\s+/g, "");
  if (!compact.startsWith("ARK1-") || compact.length > 8192) return null;
  const [payload, signature, extra] = compact.slice(5).split(".");
  if (!payload || !signature || extra !== undefined) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(new TextDecoder().decode(fromBase64(payload))) ?? {};
  } catch {
    return null;
  }
  const customer = typeof raw.customer === "string" ? raw.customer : "";
  if (raw.v !== 1 || !CUSTOMER.test(customer)) return null;
  const isLicence = raw.action === "license";
  if (!isLicence && raw.action !== "trial") return null;
  const end = Date.parse(String(isLicence ? raw.validUntil : raw.until) || "");
  if (!Number.isFinite(end) || end <= now) return null;
  if (
    !(await signedBy(isLicence ? keys.license : keys.trial, payload, signature))
  )
    return null;
  return { customer, validUntil: end };
}

function bearer(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

/** A socket opened only to be closed with a reason the other end can read. */
function refuse(
  platform: RelayPlatform,
  code: number,
  reason: string,
): Response {
  const { client, server } = platform.socketPair();
  server.accept?.();
  server.close(code, reason);
  return platform.upgraded(client);
}

export function createWorker(platform: RelayPlatform) {
  const now = platform.now ?? (() => Date.now());
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const url = new URL(request.url);
      const path = url.pathname;
      if (path === "/health") return new Response("ok");
      const route = /^\/v1\/(host|stream|connect)$/.exec(path)?.[1];
      if (!route) return new Response("Not found", { status: 404 });
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
        return new Response("Expected a WebSocket.", { status: 426 });
      const office = url.searchParams.get("office") ?? "";
      const key = bearer(request);
      if (!OFFICE_ID.test(office) || !KEY.test(key))
        return refuse(platform, CLOSE.refused, "Not a known office.");

      const verified: Record<string, unknown> = {
        route,
        keyHash: await sha256Hex(key),
      };
      if (route === "host") {
        const licence = await checkLicence(
          request.headers.get("x-ark-licence") ?? "",
          now(),
          platform.keys,
        );
        if (!licence)
          return refuse(
            platform,
            CLOSE.licence,
            "This ArkAgent has no BlackArk licence that is still valid.",
          );
        const access = (
          request.headers.get("x-ark-access") ?? ""
        ).toLowerCase();
        if (!HASH.test(access))
          return refuse(platform, CLOSE.protocol, "No access key given.");
        Object.assign(verified, licence, { accessHash: access });
      }
      if (route === "stream") {
        const stream = url.searchParams.get("stream") ?? "";
        if (!STREAM_ID.test(stream))
          return refuse(platform, CLOSE.protocol, "Not a known connection.");
        verified.stream = stream;
      }
      // Only what was checked above reaches the object: never a header from outside.
      return env.OFFICE.get(env.OFFICE.idFromName(office)).fetch(
        new Request(`https://office/${route}`, {
          headers: {
            upgrade: "websocket",
            [VERIFIED]: JSON.stringify(verified),
          },
        }),
      );
    },
  };
}

type HostAttachment = { kind: "host"; validUntil: number };
type ClientAttachment = {
  kind: "client";
  stream: string;
  paired: boolean;
  at: number;
};
type StreamAttachment = { kind: "stream"; stream: string };
type Attachment = HostAttachment | ClientAttachment | StreamAttachment;

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/** One office: its host, and the staff connections paired with the host's streams. */
export class OfficeObject {
  private readonly now: () => number;
  private readonly pairingMs: number;

  constructor(
    private readonly state: DurableObjectState,
    _env: unknown,
    private readonly platform: RelayPlatform,
  ) {
    this.now = platform.now ?? (() => Date.now());
    this.pairingMs = platform.pairingMs ?? PAIRING_MS;
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS office (id INTEGER PRIMARY KEY CHECK (id = 1), customer TEXT NOT NULL, host_hash TEXT NOT NULL, access_hash TEXT NOT NULL)",
    );
    state.setWebSocketAutoResponse(platform.autoResponse(PING, PONG));
  }

  private held():
    | { customer: string; host_hash: string; access_hash: string }
    | undefined {
    return this.state.storage.sql
      .exec<{ customer: string; host_hash: string; access_hash: string }>(
        "SELECT customer, host_hash, access_hash FROM office WHERE id = 1",
      )
      .toArray()[0];
  }

  private accept(tags: string[], attachment: Attachment): Response {
    const { client, server } = this.platform.socketPair();
    this.state.acceptWebSocket(server, tags);
    server.serializeAttachment(attachment);
    return this.platform.upgraded(client);
  }

  private refuse(code: number, reason: string): Response {
    return refuse(this.platform, code, reason);
  }

  private host(): CfWebSocket | undefined {
    return this.state.getWebSockets("host")[0];
  }

  async fetch(request: Request): Promise<Response> {
    let verified: Record<string, unknown>;
    try {
      verified = JSON.parse(request.headers.get(VERIFIED) ?? "");
    } catch {
      return new Response("Not found", { status: 404 });
    }
    const keyHash = String(verified.keyHash ?? "");
    const kept = this.held();

    if (verified.route === "host") {
      const customer = String(verified.customer);
      const accessHash = String(verified.accessHash);
      if (!kept) {
        this.state.storage.sql.exec(
          "INSERT INTO office (id, customer, host_hash, access_hash) VALUES (1, ?, ?, ?)",
          customer,
          keyHash,
          accessHash,
        );
      } else if (kept.host_hash !== keyHash || kept.customer !== customer) {
        return this.refuse(
          CLOSE.refused,
          "This office is held by another ArkAgent.",
        );
      } else if (kept.access_hash !== accessHash) {
        // The company's computer made a new join code: the old one stops working.
        this.state.storage.sql.exec(
          "UPDATE office SET access_hash = ? WHERE id = 1",
          accessHash,
        );
      }
      // One host per office: a newer connection from the same computer replaces the older one.
      for (const older of this.state.getWebSockets("host"))
        older.close(1000, "Replaced by a newer connection.");
      this.platform.log("host connected");
      return this.accept(["host"], {
        kind: "host",
        validUntil: Number(verified.validUntil),
      });
    }

    if (!kept) return this.refuse(CLOSE.refused, "Not a known office.");

    if (verified.route === "stream") {
      if (keyHash !== kept.host_hash)
        return this.refuse(CLOSE.refused, "Not this office's ArkAgent.");
      const stream = String(verified.stream);
      const client = this.state.getWebSockets(`c:${stream}`)[0];
      const waiting = client?.deserializeAttachment() as
        | ClientAttachment
        | undefined;
      if (!client || !waiting || waiting.paired)
        return this.refuse(CLOSE.protocol, "Not a waiting connection.");
      const response = this.accept(["stream", `s:${stream}`], {
        kind: "stream",
        stream,
      });
      client.serializeAttachment({ ...waiting, paired: true });
      client.send(READY);
      return response;
    }

    // A staff computer.
    if (keyHash !== kept.access_hash)
      return this.refuse(CLOSE.refused, "This join code is no longer valid.");
    const host = this.host();
    const hostAttachment = host?.deserializeAttachment() as
      | HostAttachment
      | undefined;
    if (!host || !hostAttachment)
      return this.refuse(
        CLOSE.noHost,
        "The company's ArkAgent is not connected.",
      );
    if (hostAttachment.validUntil <= this.now()) {
      host.close(CLOSE.licence, "The licence has run out.");
      return this.refuse(CLOSE.licence, "The company's licence has run out.");
    }
    if (this.state.getWebSockets("client").length >= MAX_STREAMS)
      return this.refuse(CLOSE.busy, "Too many connections at once.");
    const stream = randomId();
    const response = this.accept(["client", `c:${stream}`], {
      kind: "client",
      stream,
      paired: false,
      at: this.now(),
    });
    host.send(JSON.stringify({ open: stream }));
    if (!(await this.state.storage.getAlarm()))
      await this.state.storage.setAlarm(this.now() + this.pairingMs);
    return response;
  }

  private partner(socket: CfWebSocket): CfWebSocket | undefined {
    const attachment = socket.deserializeAttachment() as Attachment | null;
    if (attachment?.kind === "client")
      return this.state.getWebSockets(`s:${attachment.stream}`)[0];
    if (attachment?.kind === "stream")
      return this.state.getWebSockets(`c:${attachment.stream}`)[0];
    return undefined;
  }

  webSocketMessage(socket: CfWebSocket, raw: string | ArrayBuffer) {
    const attachment = socket.deserializeAttachment() as Attachment | null;
    if (attachment?.kind === "host") return; // Only the ping, which the runtime answers.
    const partner = this.partner(socket);
    const size = typeof raw === "string" ? raw.length : raw.byteLength;
    if (typeof raw === "string" || !partner || size > MAX_MESSAGE) {
      // Bytes before the pair is made, text, or anything oversized: not what this relay carries.
      socket.close(CLOSE.protocol, "Not carried.");
      partner?.close(CLOSE.protocol, "Not carried.");
      return;
    }
    partner.send(raw);
  }

  webSocketClose(socket: CfWebSocket, code: number, reason: string) {
    const attachment = socket.deserializeAttachment() as Attachment | null;
    if (attachment?.kind === "host") {
      this.platform.log("host disconnected");
      return;
    }
    const safe = code >= 1000 && code < 5000 && code !== 1005 && code !== 1006;
    this.partner(socket)?.close(safe ? code : 1000, reason.slice(0, 120));
  }

  webSocketError(socket: CfWebSocket) {
    this.webSocketClose(socket, 1011, "");
  }

  /** Staff connections the company's computer never took up are closed. */
  async alarm() {
    const now = this.now();
    let waiting = false;
    for (const socket of this.state.getWebSockets("client")) {
      const attachment = socket.deserializeAttachment() as ClientAttachment;
      if (attachment.paired) continue;
      if (now - attachment.at >= this.pairingMs)
        socket.close(CLOSE.timeout, "The company's ArkAgent did not answer.");
      else waiting = true;
    }
    if (waiting) await this.state.storage.setAlarm(now + this.pairingMs);
  }
}
