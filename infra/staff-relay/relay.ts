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
import {
  SELF_SERVE_TRIAL_PUBLIC_KEYS,
  selfServeTrialShapeOk,
  TRIAL_PUBLIC_KEYS,
} from "../../shared/trial-public-key";
import type {
  CfWebSocket,
  DurableObjectNamespace,
  DurableObjectState,
} from "../phone-relay/worker/types";

export type Env = {
  OFFICE: DurableObjectNamespace;
  /**
   * Customer ids BlackArk has cut off (a refund, a leaked key), comma-separated. Not a secret: set in
   * `wrangler.toml` and deployed. Their offices are refused at once, whatever their licence says.
   */
  REVOKED_CUSTOMERS?: string;
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
  keys?: {
    license: readonly string[];
    trial: readonly string[];
    selfServe?: readonly string[];
  };
};

export const PING = "ping";
export const PONG = "pong";
export const READY = "ready";
/** Sent to a host once the relay has accepted it as its office's own. */
export const WELCOME = "welcome";
/**
 * At most this many offices per customer (Amgad, 26 Nov 2026: "at least 5 per licence or more"). An
 * office is one company computer offering remote staff, not a person: any number of staff join it.
 */
export const MAX_OFFICES = 10;
/** A carried connection is closed after this many bytes either way, or this long. */
export const MAX_STREAM_BYTES = 4 * 1024 * 1024 * 1024;
export const MAX_STREAM_MS = 12 * 60 * 60 * 1000;
/** An office whose computer has not connected for this long gives up its place in the count. */
export const IDLE_OFFICE_MS = 30 * 24 * 60 * 60 * 1000;
/** An office counted in this recently is never asked whether it is still in use. */
const RECENT_OFFICE_MS = 5 * 60 * 1000;
/** Requests per minute from one internet address, per relay instance. */
export const PER_ADDRESS_PER_MINUTE = 240;
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
  /** BlackArk cut this customer off. */
  revoked: 4410,
  /** A connection carried its most bytes or ran its longest. */
  spent: 4413,
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
  keys: {
    license: readonly string[];
    trial: readonly string[];
    /** blackark.uk's self-serve trial keys (v0.1.58): only for a 7-day Ark Team trial code. */
    selfServe?: readonly string[];
  } = {
    license: LICENSE_PUBLIC_KEYS,
    trial: TRIAL_PUBLIC_KEYS,
    selfServe: SELF_SERVE_TRIAL_PUBLIC_KEYS,
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
  ) {
    // A self-serve trial: signed by blackark.uk's own trial key, and only ever a short Ark Team trial.
    const selfServe =
      !isLicence &&
      (keys.selfServe?.length ?? 0) > 0 &&
      selfServeTrialShapeOk(
        {
          action: String(raw.action),
          plan: String(raw.plan ?? ""),
          issuedAt: String(raw.issuedAt ?? ""),
          until: String(raw.until ?? ""),
          ...(Array.isArray(raw.addons)
            ? { addons: raw.addons.map(String) }
            : {}),
        },
        now,
      ) &&
      (await signedBy(keys.selfServe ?? [], payload, signature));
    if (!selfServe) return null;
  }
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

export function revoked(env: Env, customer: string): boolean {
  return (env.REVOKED_CUSTOMERS ?? "")
    .split(",")
    .map((one) => one.trim())
    .includes(customer);
}

export function createWorker(platform: RelayPlatform) {
  const now = platform.now ?? (() => Date.now());
  /*
   * Per internet address, in this instance's memory: a rough limit, not an exact one (Cloudflare
   * runs many instances), but it turns a flood from one address into refusals before any office's
   * object is reached and billed.
   */
  const seen = new Map<string, { minute: number; count: number }>();
  function tooMany(address: string): boolean {
    const minute = Math.floor(now() / 60_000);
    const entry = seen.get(address);
    if (!entry || entry.minute !== minute) {
      if (seen.size > 50_000) seen.clear();
      seen.set(address, { minute, count: 1 });
      return false;
    }
    entry.count += 1;
    return entry.count > PER_ADDRESS_PER_MINUTE;
  }
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const url = new URL(request.url);
      const path = url.pathname;
      if (path === "/health") return new Response("ok");
      const route = /^\/v1\/(host|stream|connect|forget)$/.exec(path)?.[1];
      if (!route) return new Response("Not found", { status: 404 });
      if (tooMany(request.headers.get("cf-connecting-ip") ?? "unknown"))
        return new Response("Too many requests.", { status: 429 });
      if (route === "forget") {
        if (request.method !== "POST")
          return new Response("Not found", { status: 404 });
      } else if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
        return new Response("Expected a WebSocket.", { status: 426 });
      const office = url.searchParams.get("office") ?? "";
      const key = bearer(request);
      if (!OFFICE_ID.test(office) || !KEY.test(key))
        return route === "forget"
          ? new Response("Not a known office.", { status: 403 })
          : refuse(platform, CLOSE.refused, "Not a known office.");

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
        if (revoked(env, licence.customer))
          return refuse(platform, CLOSE.revoked, "Cut off by BlackArk.");
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
      verified.office = office;
      // Only what was checked above reaches the object: never a header from outside.
      return env.OFFICE.get(env.OFFICE.idFromName(`office:${office}`)).fetch(
        new Request(`https://office/${route}`, {
          ...(route === "forget" ? { method: "POST" } : {}),
          headers: {
            ...(route === "forget" ? {} : { upgrade: "websocket" }),
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
  bytes?: number;
};
type StreamAttachment = {
  kind: "stream";
  stream: string;
  at?: number;
  bytes?: number;
};
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
  /** While this office waits for its customer's object to count it in. */
  private registering = false;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Partial<Env>,
    private readonly platform: RelayPlatform,
  ) {
    this.now = platform.now ?? (() => Date.now());
    this.pairingMs = platform.pairingMs ?? PAIRING_MS;
    // Nothing is stored until a licensed host registers: a request for an office nobody holds
    // leaves no trace and costs no storage.
    state.setWebSocketAutoResponse(platform.autoResponse(PING, PONG));
  }

  /**
   * Offices registered before v0.1.57 have no `office` column (the Security Engineer's review,
   * F-F): added once, so they keep working and their 30-day forget can name them. Nothing happens
   * when there is no table or the column is there.
   */
  private upgraded = false;
  private upgrade() {
    if (this.upgraded) return;
    this.upgraded = true;
    try {
      const columns = this.state.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(office)")
        .toArray()
        .map((row) => row.name);
      if (columns.length > 0 && !columns.includes("office"))
        this.state.storage.sql.exec(
          "ALTER TABLE office ADD COLUMN office TEXT",
        );
    } catch {}
  }

  private held():
    | {
        customer: string;
        host_hash: string;
        access_hash: string;
        office: string | null;
      }
    | undefined {
    this.upgrade();
    try {
      return this.state.storage.sql
        .exec<{
          customer: string;
          host_hash: string;
          access_hash: string;
          office: string | null;
        }>(
          "SELECT customer, host_hash, access_hash, office FROM office WHERE id = 1",
        )
        .toArray()[0];
    } catch {
      return undefined; // No table: nobody registered this office.
    }
  }

  /** The customer's list of offices, kept in that customer's own object. */
  private customerOffices(): string[] {
    try {
      return this.state.storage.sql
        .exec<{ office: string }>("SELECT office FROM offices")
        .toArray()
        .map((row) => row.office);
    } catch {
      return [];
    }
  }

  /** Asks the customer's object to count this office in, or out. */
  private async customer(
    customer: string,
    office: string,
    add: boolean,
  ): Promise<boolean> {
    const namespace = this.env.OFFICE;
    if (!namespace) return true;
    const answer = await namespace
      .get(namespace.idFromName(`customer:${customer}`))
      .fetch(
        new Request("https://office/offices", {
          method: "POST",
          headers: {
            [VERIFIED]: JSON.stringify({ route: "offices", office, add }),
          },
        }),
      );
    return answer.ok;
  }

  /** When this office's computer was last connected, kept so an abandoned office can expire. */
  private seen() {
    try {
      this.state.storage.sql.exec(
        "UPDATE office SET last_seen = ? WHERE id = 1",
        this.now(),
      );
    } catch {}
  }

  private lastSeen(): number {
    try {
      return (
        this.state.storage.sql
          .exec<{ last_seen: number }>(
            "SELECT last_seen FROM office WHERE id = 1",
          )
          .toArray()[0]?.last_seen ?? 0
      );
    } catch {
      return 0;
    }
  }

  private forgetAll() {
    for (const socket of this.state.getWebSockets())
      socket.close(1000, "This office was closed by its ArkAgent.");
    try {
      this.state.storage.sql.exec("DROP TABLE IF EXISTS office");
    } catch {}
  }

  private accept(tags: string[], attachment: Attachment): Response {
    return this.acceptSocket(tags, attachment).response;
  }

  private acceptSocket(
    tags: string[],
    attachment: Attachment,
  ): { response: Response; socket: CfWebSocket } {
    const { client, server } = this.platform.socketPair();
    this.state.acceptWebSocket(server, tags);
    server.serializeAttachment(attachment);
    return { response: this.platform.upgraded(client), socket: server };
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
    // A customer's own object: which offices are theirs, at most MAX_OFFICES.
    if (verified.route === "offices") {
      this.state.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS offices (office TEXT PRIMARY KEY, at INTEGER NOT NULL DEFAULT 0)",
      );
      const office = String(verified.office);
      const held = this.customerOffices();
      if (!verified.add) {
        this.state.storage.sql.exec(
          "DELETE FROM offices WHERE office = ?",
          office,
        );
        return new Response("ok");
      }
      if (!held.includes(office) && held.length >= MAX_OFFICES) {
        // Offices whose computer has not been back for IDLE_OFFICE_MS make room, and are forgotten.
        const namespace = this.env.OFFICE;
        const recent = new Set(
          this.state.storage.sql
            .exec<{ office: string }>(
              "SELECT office FROM offices WHERE at > ?",
              this.now() - RECENT_OFFICE_MS,
            )
            .toArray()
            .map((row) => row.office),
        );
        for (const other of held) {
          if (!namespace) break;
          if (recent.has(other)) continue;
          const answer = await namespace
            .get(namespace.idFromName(`office:${other}`))
            .fetch(
              new Request("https://office/alive", {
                method: "POST",
                headers: { [VERIFIED]: JSON.stringify({ route: "alive" }) },
              }),
            );
          const { inUse } = (await answer
            .json()
            .catch(() => ({ inUse: true }))) as {
            inUse?: boolean;
          };
          if (!inUse)
            this.state.storage.sql.exec(
              "DELETE FROM offices WHERE office = ?",
              other,
            );
        }
        if (this.customerOffices().length >= MAX_OFFICES)
          return new Response("Too many offices.", { status: 409 });
      }
      this.state.storage.sql.exec(
        "INSERT OR IGNORE INTO offices (office, at) VALUES (?, ?)",
        office,
        this.now(),
      );
      return new Response("ok");
    }

    const keyHash = String(verified.keyHash ?? "");
    const kept = this.held();

    if (verified.route === "forget") {
      if (!kept || kept.host_hash !== keyHash)
        return new Response("Not this office's ArkAgent.", { status: 403 });
      await this.customer(kept.customer, String(verified.office), false);
      this.forgetAll();
      this.platform.log("office forgotten");
      return new Response("ok");
    }

    // Asked by the customer's own object, when its offices are full: is this one still in use?
    if (verified.route === "alive") {
      // Being registered right now (its customer's object is the one asking): in use.
      if (this.registering) return Response.json({ inUse: true });
      if (!kept) return Response.json({ inUse: false });
      const hosted = this.host() !== undefined;
      const lastSeen = this.lastSeen();
      if (!hosted && this.now() - lastSeen > IDLE_OFFICE_MS) {
        this.forgetAll();
        return Response.json({ inUse: false });
      }
      return Response.json({ inUse: true });
    }

    if (kept && revoked(this.env as Env, kept.customer)) {
      await this.customer(kept.customer, String(verified.office), false);
      this.forgetAll();
      return this.refuse(CLOSE.revoked, "Cut off by BlackArk.");
    }

    if (verified.route === "host") {
      const customer = String(verified.customer);
      const accessHash = String(verified.accessHash);
      if (!kept) {
        this.registering = true;
        const counted = await this.customer(
          customer,
          String(verified.office),
          true,
        ).finally(() => {
          this.registering = false;
        });
        if (!counted)
          return this.refuse(
            CLOSE.busy,
            `This licence already has ${MAX_OFFICES} offices at the relay. Ask BlackArk.`,
          );
        this.state.storage.sql.exec(
          "CREATE TABLE IF NOT EXISTS office (id INTEGER PRIMARY KEY CHECK (id = 1), customer TEXT NOT NULL, host_hash TEXT NOT NULL, access_hash TEXT NOT NULL, last_seen INTEGER NOT NULL DEFAULT 0, office TEXT)",
        );
        this.state.storage.sql.exec(
          "INSERT INTO office (id, customer, host_hash, access_hash, office) VALUES (1, ?, ?, ?, ?)",
          customer,
          keyHash,
          accessHash,
          String(verified.office),
        );
      } else if (kept.host_hash !== keyHash || kept.customer !== customer) {
        return this.refuse(
          CLOSE.refused,
          "This office is held by another ArkAgent.",
        );
      } else if (kept.access_hash !== accessHash || kept.office === null) {
        if (kept.office === null)
          this.state.storage.sql.exec(
            "UPDATE office SET office = ? WHERE id = 1",
            String(verified.office),
          );
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
      this.seen();
      const { response, socket } = this.acceptSocket(["host"], {
        kind: "host",
        validUntil: Number(verified.validUntil),
      });
      // Said only now, once this host is the office's own, on the socket just accepted: the app
      // gives out a join code that names the relay only after hearing it.
      socket.send(WELCOME);
      return response;
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
        at: this.now(),
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
    await this.alarmBy(this.now() + this.pairingMs);
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
    // Each connection carries at most so many bytes, for at most so long: a licence is not a
    // free tunnel for anything else.
    const sent = (attachment?.bytes ?? 0) + size;
    const started = attachment?.at ?? this.now();
    if (sent > MAX_STREAM_BYTES || this.now() - started > MAX_STREAM_MS) {
      socket.close(CLOSE.spent, "Connection closed; open a new one.");
      partner.close(CLOSE.spent, "Connection closed; open a new one.");
      return;
    }
    socket.serializeAttachment({ ...attachment, bytes: sent });
    partner.send(raw);
  }

  webSocketClose(socket: CfWebSocket, code: number, reason: string) {
    const attachment = socket.deserializeAttachment() as Attachment | null;
    if (attachment?.kind === "host") {
      this.seen();
      this.platform.log("host disconnected");
      // The closing socket may still be listed here, so the alarm is set whatever `host()` says;
      // the alarm itself checks whether the computer came back.
      if (this.held()) void this.alarmBy(this.now() + IDLE_OFFICE_MS);
      return;
    }
    const safe = code >= 1000 && code < 5000 && code !== 1005 && code !== 1006;
    this.partner(socket)?.close(safe ? code : 1000, reason.slice(0, 120));
  }

  webSocketError(socket: CfWebSocket) {
    this.webSocketClose(socket, 1011, "");
  }

  /** The one alarm, moved earlier when `at` is sooner than the one already set. */
  private async alarmBy(at: number) {
    const set = await this.state.storage.getAlarm();
    if (set === null || set === undefined || set > at)
      await this.state.storage.setAlarm(at);
  }

  /**
   * While an office's computer is away, an alarm for IDLE_OFFICE_MS after it was last seen: then the
   * office is forgotten, its customer id and keys' hashes deleted (v0.1.57; the privacy notice).
   */
  private async armIdle() {
    if (!this.held() || this.host()) return;
    await this.alarmBy(this.lastSeen() + IDLE_OFFICE_MS);
  }

  /**
   * Staff connections the company's computer never took up are closed, and an office whose
   * computer has not been back for IDLE_OFFICE_MS is forgotten.
   */
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
    const kept = this.held();
    if (kept && !this.host() && now - this.lastSeen() >= IDLE_OFFICE_MS) {
      if (kept.office) await this.customer(kept.customer, kept.office, false);
      this.forgetAll();
      this.platform.log("idle office forgotten");
      return;
    }
    await this.armIdle();
  }
}
