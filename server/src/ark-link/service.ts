/**
 * Ark Link on this install (#149): the settings an administrator gives in Settings → Phones, the
 * phones paired with this install, and the connector that carries them.
 *
 * OFF BY DEFAULT. Nothing connects until an administrator enters BlackArk's relay address and the
 * install token BlackArk issued, and switches it on. The token goes into the vault, encrypted; the row
 * holds a pointer.
 *
 * PAIRING. An administrator asks for a code (8 characters, once, 5 minutes); a phone claims it on the
 * relay; this install shows the phone's name and a person here confirms it. Only then is a device
 * token made. This install keeps its SHA-256 and the name, and hands the token to the relay once to
 * pass to the phone.
 *
 * REMOVING a phone deletes it here, ends its open requests and sockets at once, and tells the relay.
 * The connector checks every request against this list, so a removed phone is refused here even if
 * the relay were behind.
 *
 * ONE PROCESS per database holds the relay connection (a Postgres advisory lock), as the phone line
 * does.
 */
import { eq } from "drizzle-orm";
import {
  cleanDeviceName,
  formatPairingCode,
  newDeviceToken,
  pairUrl,
  tokenHash,
} from "../../../shared/ark-link";
import { type AuditStore, recordAuditEvent } from "../audit";
import {
  type CredentialSecretReader,
  type CredentialStore,
  decryptCredentialForUse,
  encryptSecret,
} from "../credentials";
import type { Database } from "../db/client";
import { arkLink, arkLinkDevices } from "../db/schema";
import {
  type ArkLinkConnector,
  type ConnectorOptions,
  type ConnectorStatus,
  createArkLinkConnector,
  deskSocketUrl,
} from "./connector";

const LINK_ID = "link";
const LOCK_KEY = 7_149_000_001;
/** How often a device's "last used" is written, at most. */
const USED_EVERY_MS = 60_000;

export class ArkLinkRefusedError extends Error {}

/**
 * Amgad, 18 Nov 06:40 (option b): a phone can be paired only on an install where people sign in. On
 * one that runs with no sign-in, every request is its one administrator, so a paired phone would be
 * that administrator with nothing but a device token in the way.
 */
export const NEEDS_SIGN_IN =
  "Phones can be paired only where people sign in. Switch sign-in on for this install first (Google, Microsoft or your company's directory); then pair a phone here.";

export type ArkLinkInput = {
  relayUrl: string;
  installToken?: string;
  enabled: boolean;
};

export type ArkLinkDeviceView = {
  id: string;
  name: string;
  pairedAt: string;
  lastUsedAt: string | null;
};

export type ArkLinkPairingView = {
  code: string;
  /** `ABCD-EFGH`, as shown. */
  display: string;
  /** What the QR code holds. */
  url: string;
  expiresAt: string;
  /** Phones that claimed the code and wait for a person here. */
  claims: { pairingId: string; deviceName: string; expiresAt: string }[];
};

export type ArkLinkView = {
  configured: boolean;
  relayUrl: string | null;
  enabled: boolean;
  status: ConnectorStatus;
  problem: string | null;
  /** True on an install with no sign-in: phones cannot be paired, and Ark Link does not connect. */
  noSignIn: boolean;
  pairing: ArkLinkPairingView | null;
  devices: ArkLinkDeviceView[];
};

export function createArkLinkService(
  database: Database,
  dependencies: {
    credentials: CredentialStore & CredentialSecretReader;
    encryptionKey: string;
    auditStore: AuditStore;
    /** This server, on this computer, e.g. `http://127.0.0.1:3001`. */
    localOrigin: string;
    /** Whether this install runs with no sign-in (`OPENBOT_SINGLE_USER`). Then Ark Link stays off. */
    noSignIn: boolean;
    /** Tests only. */
    allowInsecureRelay?: boolean;
    openSocket?: ConnectorOptions["openSocket"];
    /** Tests only: skip the advisory lock. */
    skipLock?: boolean;
  },
) {
  const { credentials, encryptionKey, auditStore } = dependencies;
  let connector: ArkLinkConnector | null = null;
  let stopped = true;
  let releaseLock: (() => Promise<void>) | null = null;
  let pairing: ArkLinkPairingView | null = null;
  let deviceCache: Map<string, string> | null = null;
  const lastWritten = new Map<string, number>();

  async function load() {
    const [row] = await database
      .select()
      .from(arkLink)
      .where(eq(arkLink.id, LINK_ID));
    return row ?? null;
  }

  async function deviceHashes(): Promise<Map<string, string>> {
    if (deviceCache) return deviceCache;
    const rows = await database
      .select({
        id: arkLinkDevices.id,
        tokenSha256: arkLinkDevices.tokenSha256,
      })
      .from(arkLinkDevices);
    deviceCache = new Map(rows.map((row) => [row.id, row.tokenSha256]));
    return deviceCache;
  }

  const devices: ConnectorOptions["devices"] = {
    async verify(id, hash) {
      return (await deviceHashes()).get(id) === hash;
    },
    async list() {
      return [...(await deviceHashes())].map(([id, tokenSha256]) => ({
        id,
        tokenSha256,
      }));
    },
    used(id) {
      const now = Date.now();
      if (now - (lastWritten.get(id) ?? 0) < USED_EVERY_MS) return;
      lastWritten.set(id, now);
      void database
        .update(arkLinkDevices)
        .set({ lastUsedAt: new Date(now) })
        .where(eq(arkLinkDevices.id, id))
        .catch(() => undefined);
    },
  };

  function onEvent(
    event: Parameters<NonNullable<ConnectorOptions["onEvent"]>>[0],
  ) {
    if (!pairing) return;
    if (event.type === "claimed") {
      pairing.claims = [
        ...pairing.claims.filter(
          (claim) => claim.pairingId !== event.pairingId,
        ),
        {
          pairingId: event.pairingId,
          deviceName: event.deviceName,
          expiresAt: event.expiresAt,
        },
      ];
    } else {
      pairing.claims = pairing.claims.filter(
        (claim) => claim.pairingId !== event.pairingId,
      );
    }
  }

  async function takeLock(): Promise<boolean> {
    if (dependencies.skipLock || releaseLock) return true;
    const client = database.$client as unknown as {
      reserve?: () => Promise<{
        (
          strings: TemplateStringsArray,
          ...values: unknown[]
        ): Promise<{ locked: boolean }[]>;
        release: () => void;
      }>;
    };
    if (!client.reserve) return true;
    const reserved = await client.reserve();
    const [row] =
      await reserved`select pg_try_advisory_lock(${LOCK_KEY}) as locked`;
    if (!row?.locked) {
      reserved.release();
      return false;
    }
    releaseLock = async () => {
      await reserved`select pg_advisory_unlock(${LOCK_KEY})`.catch(
        () => undefined,
      );
      reserved.release();
    };
    return true;
  }

  async function connect() {
    connector?.stop();
    connector = null;
    pairing = null;
    if (stopped || dependencies.noSignIn) return;
    const row = await load();
    if (!row?.enabled) return;
    if (!(await takeLock())) {
      setTimeout(() => void connect(), 30_000);
      return;
    }
    const installToken = await decryptCredentialForUse(
      encryptionKey,
      credentials,
      row.installCredentialId,
    );
    connector = createArkLinkConnector({
      relayUrl: row.relayUrl,
      installToken,
      localOrigin: dependencies.localOrigin,
      devices,
      onEvent,
      allowInsecureRelay: dependencies.allowInsecureRelay,
      ...(dependencies.openSocket
        ? { openSocket: dependencies.openSocket }
        : {}),
    });
    connector.start();
  }

  async function listDevices(): Promise<ArkLinkDeviceView[]> {
    const rows = await database
      .select()
      .from(arkLinkDevices)
      .orderBy(arkLinkDevices.pairedAt);
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      pairedAt: row.pairedAt.toISOString(),
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    }));
  }

  function livePairing(): ArkLinkPairingView | null {
    if (!pairing) return null;
    const now = Date.now();
    pairing.claims = pairing.claims.filter(
      (claim) => Date.parse(claim.expiresAt) > now,
    );
    if (Date.parse(pairing.expiresAt) <= now && pairing.claims.length === 0)
      pairing = null;
    return pairing;
  }

  async function view(): Promise<ArkLinkView> {
    const row = await load();
    const enabled = row?.enabled ?? false;
    return {
      configured: Boolean(row),
      relayUrl: row?.relayUrl ?? null,
      enabled,
      status: enabled && connector ? connector.status : "off",
      problem: enabled && connector ? connector.problem : null,
      noSignIn: dependencies.noSignIn,
      pairing: enabled ? livePairing() : null,
      devices: await listDevices(),
    };
  }

  async function save(
    actorUserId: string,
    input: ArkLinkInput,
  ): Promise<ArkLinkView> {
    if (input.enabled && dependencies.noSignIn)
      throw new ArkLinkRefusedError(NEEDS_SIGN_IN);
    if (!deskSocketUrl(input.relayUrl, dependencies.allowInsecureRelay))
      throw new ArkLinkRefusedError(
        "The relay address must be https://<host>, with nothing after it.",
      );
    const existing = await load();
    if (!existing && !input.installToken)
      throw new ArkLinkRefusedError(
        "Enter the install token BlackArk gave you.",
      );
    let installCredentialId = existing?.installCredentialId as string;
    if (input.installToken) {
      const key = {
        kind: "connector" as const,
        provider: "ark-link",
        keyId: "install-token",
      };
      const stored = {
        ...key,
        metadata: { purpose: "install-token" },
        encryptedValue: await encryptSecret(encryptionKey, input.installToken),
      };
      const live = await credentials.findLiveByKey(key);
      installCredentialId = (
        live
          ? await credentials.rotate({
              ...stored,
              previousCredentialId: live.id,
            })
          : await credentials.create(stored)
      ).id;
    }
    const values = {
      id: LINK_ID,
      relayUrl: input.relayUrl.replace(/\/+$/, ""),
      installCredentialId,
      enabled: input.enabled,
      updatedBy: actorUserId,
      updatedAt: new Date(),
    };
    await database
      .insert(arkLink)
      .values(values)
      .onConflictDoUpdate({ target: arkLink.id, set: values });
    await recordAuditEvent(auditStore, {
      eventType: "ark_link.saved",
      targetType: "ark_link",
      targetId: LINK_ID,
      actorUserId,
      payload: {
        enabled: input.enabled,
        relay: new URL(input.relayUrl).host,
        installTokenChanged: Boolean(input.installToken),
      },
    });
    await connect();
    return view();
  }

  async function startPairing(
    actorUserId: string,
  ): Promise<ArkLinkPairingView> {
    if (dependencies.noSignIn) throw new ArkLinkRefusedError(NEEDS_SIGN_IN);
    if (connector?.status !== "connected")
      throw new ArkLinkRefusedError(
        "Phones cannot be paired while the relay is not connected.",
      );
    const row = await load();
    const started = await connector.startPairing();
    pairing = {
      code: started.code,
      display: formatPairingCode(started.code),
      url: pairUrl(row?.relayUrl ?? "", started.code),
      expiresAt: started.expiresAt,
      claims: [],
    };
    await recordAuditEvent(auditStore, {
      eventType: "ark_link.pairing_started",
      targetType: "ark_link",
      targetId: LINK_ID,
      actorUserId,
      payload: {},
    });
    return pairing;
  }

  async function confirm(
    actorUserId: string,
    pairingId: string,
    name: string,
  ): Promise<ArkLinkDeviceView> {
    if (dependencies.noSignIn) throw new ArkLinkRefusedError(NEEDS_SIGN_IN);
    const claim = livePairing()?.claims.find(
      (entry) => entry.pairingId === pairingId,
    );
    const deviceName = cleanDeviceName(name);
    if (!claim || !connector)
      throw new ArkLinkRefusedError(
        "That phone is no longer waiting. Ask for a new code.",
      );
    if (!deviceName) throw new ArkLinkRefusedError("Give the phone a name.");
    const token = newDeviceToken();
    const tokenSha256 = await tokenHash(token);
    const id = crypto.randomUUID();
    const [row] = await database
      .insert(arkLinkDevices)
      .values({ id, name: deviceName, tokenSha256, pairedBy: actorUserId })
      .returning();
    deviceCache = null;
    connector.confirm(pairingId, { id, name: deviceName, tokenSha256 }, token);
    await connector.syncDevices();
    if (pairing) {
      pairing.claims = pairing.claims.filter(
        (entry) => entry.pairingId !== pairingId,
      );
      // The code is spent: a second phone needs a new one.
      if (pairing.claims.length === 0) pairing = null;
    }
    await recordAuditEvent(auditStore, {
      eventType: "ark_link.device_paired",
      targetType: "ark_link_device",
      targetId: id,
      actorUserId,
      payload: { name: deviceName },
    });
    return {
      id,
      name: deviceName,
      pairedAt: (row?.pairedAt ?? new Date()).toISOString(),
      lastUsedAt: null,
    };
  }

  async function refuse(actorUserId: string, pairingId: string): Promise<void> {
    connector?.refuse(pairingId);
    if (pairing) {
      pairing.claims = pairing.claims.filter(
        (entry) => entry.pairingId !== pairingId,
      );
      if (
        pairing.claims.length === 0 &&
        Date.parse(pairing.expiresAt) <= Date.now()
      )
        pairing = null;
    }
    await recordAuditEvent(auditStore, {
      eventType: "ark_link.pairing_refused",
      targetType: "ark_link",
      targetId: LINK_ID,
      actorUserId,
      payload: {},
    });
  }

  async function removeDevice(
    actorUserId: string,
    id: string,
  ): Promise<boolean> {
    const removed = await database
      .delete(arkLinkDevices)
      .where(eq(arkLinkDevices.id, id))
      .returning({ id: arkLinkDevices.id, name: arkLinkDevices.name });
    if (removed.length === 0) return false;
    deviceCache = null;
    lastWritten.delete(id);
    connector?.cut(id);
    await connector?.syncDevices();
    await recordAuditEvent(auditStore, {
      eventType: "ark_link.device_removed",
      targetType: "ark_link_device",
      targetId: id,
      actorUserId,
      payload: { name: removed[0]?.name ?? "" },
    });
    return true;
  }

  return {
    view,
    save,
    /**
     * The Android app the relay vouches for, while connected. `/api/capabilities` names it, so a page
     * that app opened shows nothing to buy even though this install names no Android app of its own.
     */
    androidPackage: (): string | null => connector?.androidPackage ?? null,
    startPairing,
    confirm,
    refuse,
    removeDevice,
    /** Connects, if an administrator switched Ark Link on. Safe to call once at start. */
    start() {
      stopped = false;
      void connect().catch((error) => {
        console.error(
          "Ark Link:",
          error instanceof Error ? error.message : error,
        );
      });
    },
    async stop() {
      stopped = true;
      connector?.stop();
      connector = null;
      await releaseLock?.();
      releaseLock = null;
    },
  };
}

export type ArkLinkService = ReturnType<typeof createArkLinkService>;
