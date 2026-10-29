/**
 * The person's own browser as a digital employee's computer (device control, phase 1; desk #27).
 *
 * WHAT DECIDES IT. Two switches, held by two different parties, and both must be on:
 *
 *  1. The desktop app's "Let digital employees use my browser", OFF BY DEFAULT and only ever switched
 *     in the desktop app itself (a native menu item, not a page this server serves). When it is on,
 *     the desktop starts the person's Chrome or Edge with a dedicated ArkAgent profile, starts an
 *     `agent-computer` on loopback to drive it, and keeps announcing that address here. When it goes
 *     off, or the announcements stop, there is no own browser.
 *  2. The person choosing "my own browser" for a particular digital employee, here. Without that an
 *     employee stays in its sandboxed browser exactly as before.
 *
 * WHY THE CHOICES DO NOT OUTLIVE THE SWITCH. Switching off, closing the browser, or restarting
 * ArkAgent forgets every choice, so the person's browser is never driven on the strength of a choice
 * made last week. Like folder grants (host-access/), this is per session and held in memory: the
 * desktop is one person's computer and one server.
 *
 * THE SAME GATEWAY. Choosing changes nothing but WHERE `locate` points. Every action still goes
 * through `ComputerGateway`: the element resolved from the server's own snapshot, the policy with its
 * approve rules (#5), the audit row, then the action. There is no other route to the person's browser
 * from this server; see `withOwnBrowser` below.
 */
import { randomUUID } from "node:crypto";
import { ProviderError, type ComputerProvider } from "./provider";
import type { ComputerStatus } from "./schema";

/** How long an announcement holds. The desktop repeats it every few seconds. */
export const OWN_BROWSER_LEASE_MS = 20_000;

/** A digital employee that has been pointed at the person's browser. */
export type OwnBrowserChoice = {
  botId: string;
  /** Who chose it, for the trail and for the person looking at the indicator. */
  actorId: string;
  since: string;
  /** When an action last reached the person's browser for this employee, or null. */
  activeAt: string | null;
};

export type OwnBrowserStatus = {
  /** Switched on in the desktop app, and announced recently enough to believe. */
  available: boolean;
  employees: OwnBrowserChoice[];
};

export type OwnBrowser = ReturnType<typeof createOwnBrowser>;

export function createOwnBrowser(
  options: { now?: () => number; leaseMs?: number } = {},
) {
  const now = options.now ?? Date.now;
  const leaseMs = options.leaseMs ?? OWN_BROWSER_LEASE_MS;
  let announced: { url: string; session: string; until: number } | null = null;
  const chosen = new Map<string, OwnBrowserChoice>();

  const available = () => announced !== null && announced.until > now();

  return {
    /**
     * The desktop saying where the person's browser is, or that it is off (null).
     *
     * Off forgets every choice. A new address is a new browser process, so it is a new session: refs
     * from the one before must not resolve against it (see the gateway's `resolve`).
     */
    announce(url: string | null): { switched: "on" | "off" | null } {
      const wasAvailable = available();
      if (url === null) {
        announced = null;
        chosen.clear();
        return { switched: wasAvailable ? "off" : null };
      }
      const session =
        announced?.url === url
          ? announced.session
          : `own-browser:${randomUUID()}`;
      announced = { url, session, until: now() + leaseMs };
      return { switched: wasAvailable ? null : "on" };
    },

    available,

    /** Where the person's browser is driven from, while it is switched on. */
    address(): string | undefined {
      return available() ? announced?.url : undefined;
    },

    /** Which run of the person's browser this is, so refs from another computer never resolve. */
    session(): string | undefined {
      return available() ? announced?.session : undefined;
    },

    /** Has the person pointed this employee at their own browser? */
    chosen(botId: string): boolean {
      return chosen.has(botId);
    },

    choose(botId: string, actorId: string): OwnBrowserChoice {
      const existing = chosen.get(botId);
      if (existing) return existing;
      const choice: OwnBrowserChoice = {
        botId,
        actorId,
        since: new Date(now()).toISOString(),
        activeAt: null,
      };
      chosen.set(botId, choice);
      return choice;
    },

    release(botId: string): boolean {
      return chosen.delete(botId);
    },

    releaseAll(): string[] {
      const released = [...chosen.keys()];
      chosen.clear();
      return released;
    },

    /** Noted on every action routed to the person's browser, for the "driving now" indicator. */
    touch(botId: string): void {
      const choice = chosen.get(botId);
      if (choice) choice.activeAt = new Date(now()).toISOString();
    },

    status(): OwnBrowserStatus {
      return {
        available: available(),
        employees: [...chosen.values()].map((choice) => ({ ...choice })),
      };
    },
  };
}

/** What an employee pointed at the person's browser is told while that browser is switched off. */
export const OWN_BROWSER_OFF =
  "This digital employee is set to use your own browser, which is switched off in the ArkAgent desktop app or was closed. Switch it on there, or set the employee back to its own browser.";

export const OWN_BROWSER_NO_RESET =
  "This digital employee is using your own browser. ArkAgent never deletes that browser's profile; sign out of sites in the browser itself.";

type CallOptions = {
  token?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

async function callOwnBrowser(
  address: string,
  botId: string,
  path: string,
  method: "GET" | "POST",
  options: CallOptions,
): Promise<Record<string, unknown> | null> {
  const response = await (options.fetchImpl ?? fetch)(`${address}${path}`, {
    method,
    headers: {
      "x-openbot-bot-id": botId,
      ...(options.token ? { "x-openbot-computer-token": options.token } : {}),
    },
    signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
  });
  const body = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!response.ok) {
    throw new ProviderError(
      typeof body?.error === "string"
        ? body.error
        : `Your own browser answered ${response.status}.`,
    );
  }
  return body;
}

/**
 * Close one employee's tab in the person's browser, if it has one.
 *
 * Used when the person sets the employee back to its own computer, and by Stop. Never closes the
 * browser itself, which the person may be using.
 */
export async function closeOwnBrowserTab(
  own: OwnBrowser,
  botId: string,
  options: CallOptions,
): Promise<boolean> {
  const address = own.address();
  if (!address) return false;
  const body = await callOwnBrowser(
    address,
    botId,
    "/computers/stop",
    "POST",
    options,
  ).catch(() => null);
  return body?.wasRunning === true;
}

/**
 * The computer provider, with the person's own browser in front of it for the employees pointed there.
 *
 * Wrapping the provider, not the gateway, is the whole design: the gateway asks `locate` for every
 * action and then decides, records and acts as it always does, so an action on the person's browser
 * cannot take a path an action on the sandbox would not. An employee pointed at a browser that is
 * switched off is refused, not quietly sent back to the sandbox: it would carry on in a browser the
 * person is not watching, signed in to nothing they expect.
 */
export function withOwnBrowser(
  base: ComputerProvider,
  own: OwnBrowser,
  options: CallOptions = {},
): ComputerProvider {
  const ownAddress = (botId: string): string => {
    const address = own.address();
    if (!address) throw new ProviderError(OWN_BROWSER_OFF);
    own.touch(botId);
    return address;
  };

  return {
    name: base.name,
    isolation: base.isolation,

    async locate(botId) {
      return own.chosen(botId) ? ownAddress(botId) : base.locate(botId);
    },

    async sessionOf(botId) {
      return own.chosen(botId) ? own.session() : base.sessionOf?.(botId);
    },

    personsBrowser(botId) {
      return own.chosen(botId);
    },

    async status(botId): Promise<ComputerStatus> {
      if (!own.chosen(botId)) return base.status(botId);
      const address = own.address();
      if (!address) {
        return { botId, state: "unreachable", reason: OWN_BROWSER_OFF };
      }
      try {
        await callOwnBrowser(address, botId, "/health", "GET", options);
        return { botId, state: "ready" };
      } catch (error) {
        return {
          botId,
          state: "unreachable",
          reason: error instanceof Error ? error.message : OWN_BROWSER_OFF,
        };
      }
    },

    async stop(botId) {
      if (!own.chosen(botId)) return base.stop(botId);
      return { wasRunning: await closeOwnBrowserTab(own, botId, options) };
    },

    async reset(botId) {
      if (own.chosen(botId)) throw new ProviderError(OWN_BROWSER_NO_RESET);
      return base.reset(botId);
    },

    list: () => base.list(),
    ...(base.warm ? { warm: () => base.warm?.() ?? Promise.resolve() } : {}),
  };
}

/**
 * Is this the address the desktop's own-browser computer may be announced at?
 *
 * Loopback over http and nothing else. The desktop starts that process on this computer and binds it
 * there; anything else in an announcement is a mistake, and accepting it would point employees, with
 * this deployment's computer token, at whatever was named.
 */
export function ownBrowserAddress(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") return null;
  if (!url.port || url.pathname !== "/" || url.search || url.username) {
    return null;
  }
  return `http://127.0.0.1:${url.port}`;
}
