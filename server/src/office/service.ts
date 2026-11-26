import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import { eq } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "../credentials";
import type { Database } from "../db/client";
import { officeNetwork } from "../db/schema";
import { makeOfficeCertificate } from "./certificate";
import { encodeJoinCode } from "./join-code";
import { type RemoteHost, startRemoteHost } from "./remote-host";

/**
 * The office network (Amgad, 24 Nov 2026, option A): the administrator's computer is the company's
 * ArkAgent, and staff computers on the same network sign in to it.
 *
 * Off until the administrator switches it on in Settings, then Team. On, this ArkAgent also answers
 * on the office network, over HTTPS only, with a certificate it made for itself; a staff computer
 * trusts that certificate by the fingerprint in the join code, so nobody on the network can stand in
 * for it. Everything else stays on this computer only, as before. Nobody gets in without signing in.
 */
export const OFFICE_ROW = "office";
export const DEFAULT_OFFICE_PORT = 52443;

export type OfficeListener = {
  stop: (closeActive?: boolean) => void;
  /** The port it actually holds, where it was asked for any. */
  port?: number;
};

export type RemoteStaffStatus = {
  /** Whether this build knows BlackArk's staff relay at all. */
  available: boolean;
  enabled: boolean;
  connected: boolean;
  error: string | null;
};

export type OfficeStatus = {
  enabled: boolean;
  listening: boolean;
  port: number;
  addresses: string[];
  fingerprint: string | null;
  joinCode: string | null;
  error: string | null;
  remote: RemoteStaffStatus;
};

/** This computer's IPv4 addresses on its networks, private ranges first; never loopback. */
export function officeAddresses(
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): string[] {
  const found = Object.values(interfaces)
    .flatMap((list) => list ?? [])
    .filter((one) => one.family === "IPv4" && !one.internal)
    .map((one) => one.address);
  const isPrivate = (address: string) =>
    /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address);
  return [...new Set(found)].sort(
    (a, b) => Number(isPrivate(b)) - Number(isPrivate(a)),
  );
}

export function createOfficeService(dependencies: {
  database: Database;
  encryptionKey: string;
  port?: number;
  /**
   * Opens the HTTPS listener with this certificate: on every network when the office network is on,
   * on this computer's loopback only when only remote staff is (the relay connects to it there).
   * Throws when the port cannot be had.
   */
  listen: (
    tls: { cert: string; key: string },
    where: { everywhere: boolean },
  ) => OfficeListener;
  /** BlackArk's staff relay (remote staff, v0.1.56). Absent: remote staff cannot be switched on. */
  relay?: {
    url: string;
    /** This install's `ARK1-` licence key or trial activation code, or null. */
    licence: () => Promise<string | null>;
    log?: (line: string) => void;
    start?: typeof startRemoteHost;
  };
  addresses?: () => string[];
  hostname?: () => string;
  now?: () => Date;
  /**
   * Whether this ArkAgent has its administrator. The office network never opens before it does,
   * whatever was saved (security review of v0.1.54): nobody on the network meets a set-up screen.
   */
  hasAdministrator?: () => Promise<boolean>;
}) {
  const { database } = dependencies;
  const port = dependencies.port ?? DEFAULT_OFFICE_PORT;
  const addresses = dependencies.addresses ?? (() => officeAddresses());
  const now = dependencies.now ?? (() => new Date());
  let listener: OfficeListener | null = null;
  let listenerEverywhere = false;
  let lastError: string | null = null;
  let remote: RemoteHost | null = null;
  const key = () => randomBytes(32).toString("base64url");

  async function row() {
    const [found] = await database
      .select()
      .from(officeNetwork)
      .where(eq(officeNetwork.id, OFFICE_ROW));
    return found ?? null;
  }

  /** The certificate, made the first time it is needed and kept, so a join code keeps working. */
  async function certificate() {
    const existing = await row();
    if (existing) return existing;
    const made = makeOfficeCertificate(
      {
        addresses: addresses(),
        hostnames: [dependencies.hostname?.() ?? ""].filter(Boolean),
      },
      now(),
    );
    await database
      .insert(officeNetwork)
      .values({
        id: OFFICE_ROW,
        enabled: false,
        certificate: made.certificate,
        sealedKey: await encryptSecret(dependencies.encryptionKey, made.key),
        fingerprint: made.fingerprint,
      })
      .onConflictDoNothing();
    return (await row()) as NonNullable<Awaited<ReturnType<typeof row>>>;
  }

  async function open(everywhere: boolean) {
    if (listener && listenerEverywhere === everywhere) return;
    closeListener();
    const kept = await certificate();
    try {
      listener = dependencies.listen(
        {
          cert: kept.certificate,
          key: await decryptSecret(dependencies.encryptionKey, kept.sealedKey),
        },
        { everywhere },
      );
      listenerEverywhere = everywhere;
      lastError = null;
    } catch {
      listener = null;
      lastError =
        "Another program on this computer is using the office network port, so staff cannot reach it. Close that program, then switch this on again.";
    }
  }

  function closeListener() {
    listener?.stop(true);
    listener = null;
  }

  type RelayKeys = { host: string; access: string };

  async function relayKeys(): Promise<{ office: string; keys: RelayKeys }> {
    const kept = await certificate();
    if (kept.relayOffice && kept.sealedRelay)
      return {
        office: kept.relayOffice,
        keys: JSON.parse(
          await decryptSecret(dependencies.encryptionKey, kept.sealedRelay),
        ) as RelayKeys,
      };
    const office = key();
    const keys: RelayKeys = { host: key(), access: key() };
    await database
      .update(officeNetwork)
      .set({
        relayOffice: office,
        sealedRelay: await encryptSecret(
          dependencies.encryptionKey,
          JSON.stringify(keys),
        ),
        updatedAt: now(),
      })
      .where(eq(officeNetwork.id, OFFICE_ROW));
    return { office, keys };
  }

  function stopRemote() {
    remote?.stop();
    remote = null;
  }

  /** Makes what is open match what the administrator switched on. */
  async function sync() {
    const kept = await row();
    const office = kept?.enabled === true;
    const away = kept?.remoteEnabled === true && Boolean(dependencies.relay);
    const admin =
      !dependencies.hasAdministrator ||
      (office || away ? await dependencies.hasAdministrator() : false);
    if (!(office || away) || !admin) {
      stopRemote();
      closeListener();
      return;
    }
    await open(office);
    const relay = dependencies.relay;
    if (!away || !relay || !listener) {
      stopRemote();
      return;
    }
    if (remote) return;
    const { office: id, keys } = await relayKeys();
    remote = (relay.start ?? startRemoteHost)({
      relayUrl: relay.url,
      office: id,
      hostKey: keys.host,
      accessKey: keys.access,
      licence: relay.licence,
      listenerPort: () => listener?.port ?? null,
      ...(relay.log ? { log: relay.log } : {}),
    });
  }

  function close() {
    stopRemote();
    closeListener();
  }

  async function status(): Promise<OfficeStatus> {
    const kept = await row();
    const enabled = kept?.enabled === true;
    const remoteEnabled =
      kept?.remoteEnabled === true && Boolean(dependencies.relay);
    const here = addresses();
    const held = listener?.port ?? port;
    const relay =
      remoteEnabled && listener && kept?.relayOffice && dependencies.relay
        ? await relayKeys()
        : null;
    const direct = enabled && here.length > 0 ? here : [];
    const hosted = remote?.status() ?? { connected: false, error: null };
    return {
      enabled,
      listening: listener !== null,
      port: held,
      addresses: here,
      fingerprint: kept?.fingerprint ?? null,
      joinCode:
        listener && kept && (direct.length > 0 || relay)
          ? encodeJoinCode({
              addresses: direct,
              port: held,
              fingerprint: kept.fingerprint,
              ...(relay && dependencies.relay
                ? {
                    relay: {
                      url: dependencies.relay.url,
                      office: relay.office,
                      key: relay.keys.access,
                    },
                  }
                : {}),
            })
          : null,
      error: enabled || remoteEnabled ? lastError : null,
      remote: {
        available: Boolean(dependencies.relay),
        enabled: remoteEnabled,
        connected: hosted.connected,
        error: remoteEnabled ? (lastError ?? hosted.error) : null,
      },
    };
  }

  return {
    status,

    /**
     * Whether this Bun server is the office listener (security review of v0.1.55): how a request
     * came is told by which listener took it, never by a header anybody can write.
     */
    servedBy(server: unknown): boolean {
      return listener !== null && server === listener;
    },

    /**
     * The certificate staff computers check against the join code, while it is switched on. Public:
     * it proves which computer this is, and admits nobody.
     */
    async certificatePem(): Promise<string | null> {
      const kept = await row();
      return kept?.enabled || kept?.remoteEnabled ? kept.certificate : null;
    },

    /** On start: answers again on what the administrator left on (office network, remote staff). */
    start: sync,

    async setEnabled(on: boolean): Promise<OfficeStatus> {
      await certificate();
      await database
        .update(officeNetwork)
        .set({ enabled: on, updatedAt: now() })
        .where(eq(officeNetwork.id, OFFICE_ROW));
      await sync();
      return status();
    },

    /** Remote staff through BlackArk's staff relay (v0.1.56). */
    async setRemote(on: boolean): Promise<OfficeStatus> {
      if (on && !dependencies.relay)
        throw new Error("This ArkAgent does not know BlackArk's staff relay.");
      await certificate();
      await database
        .update(officeNetwork)
        .set({ remoteEnabled: on, updatedAt: now() })
        .where(eq(officeNetwork.id, OFFICE_ROW));
      await sync();
      return status();
    },

    /**
     * A new join code: the relay's access key is replaced, so the code given out before no longer
     * gets through the relay. (On the office network the code only says where to look and which
     * certificate to trust; it never admitted anybody there.)
     */
    async newJoinCode(): Promise<OfficeStatus> {
      const kept = await certificate();
      if (kept.relayOffice && kept.sealedRelay) {
        const { keys } = await relayKeys();
        await database
          .update(officeNetwork)
          .set({
            sealedRelay: await encryptSecret(
              dependencies.encryptionKey,
              JSON.stringify({ host: keys.host, access: key() }),
            ),
            updatedAt: now(),
          })
          .where(eq(officeNetwork.id, OFFICE_ROW));
        stopRemote();
        await sync();
      }
      return status();
    },

    stop: close,
  };
}

export type OfficeService = ReturnType<typeof createOfficeService>;

/**
 * A request that came in on the office listener, as the app's own: a page served from this
 * listener calls it from its own origin, which is an address the sign-in library's trusted origins
 * could not have known in advance. Only a same-origin request is renamed; one from any other site
 * keeps its origin and is refused as before.
 */
export function asOwnOrigin(request: Request, appOrigin: string): Request {
  // A socket's handshake is left as it came: Bun upgrades only the request it was handed, and the
  // origin guard already takes a same-host handshake as this site's own.
  if (request.headers.get("upgrade")?.toLowerCase() === "websocket")
    return request;
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host || origin !== `https://${host}`) return request;
  const headers = new Headers(request.headers);
  headers.set("origin", appOrigin);
  const referer = headers.get("referer");
  if (referer?.startsWith(`${origin}/`))
    headers.set("referer", appOrigin + referer.slice(origin.length));
  return new Request(request, { headers });
}
