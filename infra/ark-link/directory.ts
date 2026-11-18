/**
 * Who is routed where, and the pairings in progress (#149), over a store the platform provides: maps
 * in memory (and `devices.json`) for the Bun relay, SQLite in a Durable Object for the Workers relay.
 * Everything here is the same on both.
 *
 * Holds only routing and hashes. A device token is held once, between the desktop confirming a phone
 * and the phone collecting it, then dropped.
 */
import {
  type DeskMessage,
  newPairingCode,
  PAIRING_CONFIRM_TTL_MS,
  PAIRING_TTL_MS,
  type PairRefusal,
  tokenHash,
} from "../../shared/ark-link";
import { type DeviceRoute, randomId } from "./desk-link";

export type Waiting = { installId: string; deskId: string; expiresAt: number };
export type Pairing = {
  installId: string;
  deviceName: string;
  expiresAt: number;
  state: "claimed" | "confirmed" | "refused";
  token?: string;
};

/** Synchronous on purpose: both maps and a Durable Object's SQLite answer at once. */
export type DirectoryStore = {
  route(hash: string): DeviceRoute | undefined;
  routesOf(installId: string): DeviceRoute[];
  setRoute(route: DeviceRoute): void;
  deleteRoute(hash: string): void;
  allRoutes(): DeviceRoute[];
  code(code: string): Waiting | undefined;
  setCode(code: string, waiting: Waiting): void;
  deleteCode(code: string): void;
  codesOf(installId: string): string[];
  pairing(id: string): Pairing | undefined;
  setPairing(id: string, pairing: Pairing): void;
  deletePairing(id: string): void;
  /** Codes and pairings whose time ran out. */
  expired(now: number): { codes: string[]; pairings: [string, Pairing][] };
};

export function memoryDirectoryStore(
  initial: DeviceRoute[] = [],
  onRoutesChanged?: (routes: DeviceRoute[]) => void,
): DirectoryStore {
  const routes = new Map(initial.map((route) => [route.tokenSha256, route]));
  const codes = new Map<string, Waiting>();
  const pairings = new Map<string, Pairing>();
  const changed = () => onRoutesChanged?.([...routes.values()]);
  return {
    route: (hash) => routes.get(hash),
    routesOf: (installId) =>
      [...routes.values()].filter((route) => route.installId === installId),
    setRoute: (route) => {
      routes.set(route.tokenSha256, route);
      changed();
    },
    deleteRoute: (hash) => {
      if (routes.delete(hash)) changed();
    },
    allRoutes: () => [...routes.values()],
    code: (code) => codes.get(code),
    setCode: (code, waiting) => codes.set(code, waiting),
    deleteCode: (code) => codes.delete(code),
    codesOf: (installId) =>
      [...codes].filter(([, w]) => w.installId === installId).map(([c]) => c),
    pairing: (id) => pairings.get(id),
    setPairing: (id, pairing) => pairings.set(id, pairing),
    deletePairing: (id) => pairings.delete(id),
    expired: (now) => ({
      codes: [...codes].filter(([, w]) => w.expiresAt <= now).map(([c]) => c),
      pairings: [...pairings].filter(([, p]) => p.expiresAt <= now),
    }),
  };
}

export type ClaimAnswer =
  | { ok: true; pairingId: string; installId: string; expiresAt: number }
  | { ok: false; reason: PairRefusal; status: number };

export type StatusAnswer =
  | { status: "pending" }
  | { status: "confirmed"; deviceToken: string; deviceName: string }
  | {
      status: "refused";
      reason: PairRefusal;
      httpStatus: number;
      /** A pairing that ended here, which its desktop is told about. */
      ended?: { installId: string; pairingId: string; reason: PairRefusal };
    };

export class Directory {
  constructor(
    private store: DirectoryStore,
    private now: () => number = Date.now,
  ) {}

  lookup(hash: string): DeviceRoute | undefined {
    return this.store.route(hash);
  }

  get routes(): DeviceRoute[] {
    return this.store.allRoutes();
  }

  /** A new code for this desktop; any earlier one of its codes stops working. */
  startPairing(installId: string, deskId: string) {
    for (const code of this.store.codesOf(installId))
      this.store.deleteCode(code);
    let code = newPairingCode();
    while (this.store.code(code)) code = newPairingCode();
    const expiresAt = this.now() + PAIRING_TTL_MS;
    this.store.setCode(code, { installId, deskId, expiresAt });
    return { code, expiresAt };
  }

  /** Which install a live code belongs to, without spending it. */
  peek(code: string): string | null {
    const found = this.store.code(code);
    return found && found.expiresAt > this.now() ? found.installId : null;
  }

  /** Spends the code. The caller has checked that its desktop is connected. */
  claim(code: string, deviceName: string): ClaimAnswer {
    const found = this.store.code(code);
    if (!found || found.expiresAt <= this.now())
      return { ok: false, reason: "unknown", status: 404 };
    this.store.deleteCode(code);
    const pairingId = randomId();
    const expiresAt = this.now() + PAIRING_CONFIRM_TTL_MS;
    this.store.setPairing(pairingId, {
      installId: found.installId,
      deviceName,
      expiresAt,
      state: "claimed",
    });
    return { ok: true, pairingId, installId: found.installId, expiresAt };
  }

  /** The desktop confirmed a phone. False when it is not this desktop's, or late, or does not add up. */
  async confirm(
    installId: string,
    message: Extract<DeskMessage, { t: "pair.confirm" }>,
  ): Promise<boolean> {
    const pairing = this.store.pairing(message.pairingId);
    if (
      !pairing ||
      pairing.installId !== installId ||
      pairing.state !== "claimed" ||
      pairing.expiresAt <= this.now() ||
      (await tokenHash(message.token)) !== message.device.tokenSha256
    )
      return false;
    this.store.setPairing(message.pairingId, {
      ...pairing,
      state: "confirmed",
      token: message.token,
      deviceName: message.device.name,
    });
    this.store.setRoute({
      id: message.device.id,
      installId,
      tokenSha256: message.device.tokenSha256,
    });
    return true;
  }

  refuse(installId: string, pairingId: string) {
    const pairing = this.store.pairing(pairingId);
    if (pairing?.installId === installId && pairing.state === "claimed")
      this.store.setPairing(pairingId, { ...pairing, state: "refused" });
  }

  /** What a polling phone is told. A confirmed token is handed over once, then forgotten. */
  status(pairingId: string): StatusAnswer {
    const pairing = this.store.pairing(pairingId);
    if (!pairing)
      return { status: "refused", reason: "unknown", httpStatus: 404 };
    if (pairing.state === "confirmed" && pairing.token) {
      this.store.deletePairing(pairingId);
      return {
        status: "confirmed",
        deviceToken: pairing.token,
        deviceName: pairing.deviceName,
      };
    }
    if (pairing.state === "refused") {
      this.store.deletePairing(pairingId);
      return { status: "refused", reason: "refused", httpStatus: 200 };
    }
    if (pairing.expiresAt <= this.now()) {
      this.store.deletePairing(pairingId);
      return {
        status: "refused",
        reason: "expired",
        httpStatus: 200,
        ended: {
          installId: pairing.installId,
          pairingId,
          reason: "expired",
        },
      };
    }
    return { status: "pending" };
  }

  /** The desktop's whole list replaces its routes. Returns the device ids it kept. */
  syncDevices(
    installId: string,
    devices: { id: string; tokenSha256: string }[],
  ): Set<string> {
    const kept = new Set(devices.map((d) => d.tokenSha256));
    for (const route of this.store.routesOf(installId))
      if (!kept.has(route.tokenSha256))
        this.store.deleteRoute(route.tokenSha256);
    for (const device of devices) {
      const existing = this.store.route(device.tokenSha256);
      // A hash already routed to another install stays where it is.
      if (existing && existing.installId !== installId) continue;
      if (existing?.id === device.id) continue;
      this.store.setRoute({ ...device, installId });
    }
    return new Set(devices.map((d) => d.id));
  }

  /** The desktop went away: its codes stop working. */
  forgetCodesOf(installId: string) {
    for (const code of this.store.codesOf(installId))
      this.store.deleteCode(code);
  }

  /** Drops what ran out; returns the claimed pairings whose desktops should hear they ended. */
  sweep(): { installId: string; pairingId: string; reason: PairRefusal }[] {
    const { codes, pairings } = this.store.expired(this.now());
    for (const code of codes) this.store.deleteCode(code);
    const ended: {
      installId: string;
      pairingId: string;
      reason: PairRefusal;
    }[] = [];
    for (const [id, pairing] of pairings) {
      this.store.deletePairing(id);
      if (pairing.state === "claimed")
        ended.push({
          installId: pairing.installId,
          pairingId: id,
          reason: "expired",
        });
    }
    return ended;
  }
}
