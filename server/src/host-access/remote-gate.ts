/**
 * Device control while the administrator's account is used from another computer (Amgad, 26 Nov
 * 2026; the Security Engineer's review of v0.1.57, F-B and F-C).
 *
 * The administrator's own Chrome or Edge on this computer is signed in as them. Whoever holds their
 * password on the office network or BlackArk's relay must not be able to watch or drive it. So while
 * their account has been used from another computer recently, EVERY action that reaches the own
 * browser for an employee they put there (a chat run, a click, a screenshot, the live screen) goes
 * ahead only under an approval given on this computer, in a native window, for a limited time.
 *
 * - "From another computer": a request or conversation message this computer's office listener
 *   took (office network or relay) for that person, in the last REMOTE_RECENT_MS.
 * - The approval lasts APPROVAL_MS, for that person and that employee, and the window says so.
 * - Prompts are limited (F-C): one at a time per person and employee, none for DENIED_QUIET_MS after
 *   a Deny, and at most PROMPTS_PER_WINDOW in PROMPT_WINDOW_MS overall, so the window cannot be raised
 *   until somebody typing presses the wrong key.
 */
import { isLoopbackPeer } from "../../../shared/local-hosts";

export const REMOTE_RECENT_MS = 15 * 60_000;
export const APPROVAL_MS = 10 * 60_000;
export const DENIED_QUIET_MS = 2 * 60_000;
export const PROMPT_WINDOW_MS = 10 * 60_000;
export const PROMPTS_PER_WINDOW = 5;

export type RemoteVia = "office network" | "relay";

export type RemoteGatePrompt = {
  botId: string;
  botName: string;
  actorId: string;
  /** The account's email, or its name, as the person at this computer knows it. */
  account: string;
  via: RemoteVia;
  minutes: number;
};

export class RemoteApprovalRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteApprovalRefusedError";
  }
}

export const REMOTE_REFUSED =
  "This needs the administrator's yes on the company's computer, and it was not given.";
export const REMOTE_QUIET =
  "This was just refused on the company's computer. Try again in a few minutes.";
export const REMOTE_TOO_MANY =
  "Too many requests to approve on the company's computer. Try again in a few minutes.";

export type RemoteGate = ReturnType<typeof createRemoteGate>;

/**
 * How a request the office listener took arrived: BlackArk's relay hands its streams to the
 * listener from this computer itself (office/remote-host.ts), the office network from another one.
 */
export function viaOf(server: unknown, request: Request): RemoteVia {
  const peer =
    (
      server as {
        requestIP?: (request: Request) => { address: string } | null;
      } | null
    )?.requestIP?.(request)?.address ?? "";
  return isLoopbackPeer(peer) ? "relay" : "office network";
}

export function createRemoteGate(options: {
  /** Asks at this computer; resolves when allowed, rejects otherwise. */
  confirm: (prompt: RemoteGatePrompt) => Promise<void>;
  describe?: (actorId: string) => Promise<string | null>;
  botName?: (botId: string, actorId: string) => Promise<string | null>;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const seen = new Map<string, { at: number; via: RemoteVia }>();
  const approved = new Map<string, number>();
  const deniedAt = new Map<string, number>();
  const pending = new Map<string, Promise<void>>();
  let prompts: number[] = [];

  const key = (actorId: string, botId: string) => `${actorId}\u0000${botId}`;

  function remoteNow(actorId: string): RemoteVia | null {
    const last = seen.get(actorId);
    return last && now() - last.at < REMOTE_RECENT_MS ? last.via : null;
  }

  return {
    /** A request for this person came over the office listener. */
    noteRemote(actorId: string, via: RemoteVia) {
      seen.set(actorId, { at: now(), via });
    },

    /** Whether this person is using ArkAgent from another computer now, and how. */
    remoteNow,

    /**
     * Resolves when this action on the own browser may go ahead; rejects with a sentence otherwise.
     * `via` asks even when the person is not otherwise seen from another computer, for a request
     * that itself came from one.
     */
    async require(input: {
      botId: string;
      actorId: string;
      via?: RemoteVia;
    }): Promise<void> {
      const via = input.via ?? remoteNow(input.actorId);
      if (!via) return;
      const id = key(input.actorId, input.botId);
      if ((approved.get(id) ?? 0) > now()) return;
      const waiting = pending.get(id);
      if (waiting) return waiting;
      const denied = deniedAt.get(id);
      if (denied !== undefined && now() - denied < DENIED_QUIET_MS)
        throw new RemoteApprovalRefusedError(REMOTE_QUIET);
      prompts = prompts.filter((at) => now() - at < PROMPT_WINDOW_MS);
      if (prompts.length >= PROMPTS_PER_WINDOW)
        throw new RemoteApprovalRefusedError(REMOTE_TOO_MANY);
      prompts.push(now());
      const ask = (async () => {
        const [account, botName] = await Promise.all([
          options.describe?.(input.actorId).catch(() => null),
          options.botName?.(input.botId, input.actorId).catch(() => null),
        ]);
        try {
          await options.confirm({
            botId: input.botId,
            botName: botName ?? input.botId,
            actorId: input.actorId,
            account: account ?? input.actorId,
            via,
            minutes: APPROVAL_MS / 60_000,
          });
        } catch {
          deniedAt.set(id, now());
          throw new RemoteApprovalRefusedError(REMOTE_REFUSED);
        }
        deniedAt.delete(id);
        approved.set(id, now() + APPROVAL_MS);
      })();
      pending.set(id, ask);
      try {
        await ask;
      } finally {
        pending.delete(id);
      }
    },

    /** Drops every approval: the own browser was switched off or an employee released. */
    forget(botId?: string) {
      if (!botId) {
        approved.clear();
        return;
      }
      for (const id of [...approved.keys()])
        if (id.endsWith(`\u0000${botId}`)) approved.delete(id);
    },
  };
}
