import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { agentProfiles } from "../db/schema";
import type { ComputerProvider } from "../computer/provider";
import type { CloudMeter } from "./meter";

/**
 * The account a coworker belongs to, or null for the platform's own, which nobody is billed for.
 */
export function tenantOfBot(
  database: Database,
): (botId: string) => Promise<string | null> {
  return async (botId) => {
    const [row] = await database
      .select({ tenantId: agentProfiles.tenantId })
      .from(agentProfiles)
      .where(eq(agentProfiles.agentId, botId))
      .limit(1);
    return row?.tenantId ?? null;
  };
}

export type MeteredProviderDeps = {
  meter: CloudMeter;
  tenantOf: (botId: string) => Promise<string | null>;
  /** How often the same computer is written down as still up, at most, per process. */
  refreshMs?: number;
  now?: () => number;
};

/**
 * A computer provider that notes down when a coworker's computer is up and when it is not.
 *
 * It changes nothing about what the provider does and can never make it fail: recording is done
 * after the fact, off the request, and an error in it is swallowed, because losing a few seconds of
 * a record is a rounding error and failing a person's action because a ledger was unavailable is not.
 *
 * `locate` is asked for on every action a coworker takes, so it is written down at most every
 * `refreshMs` per process (the record only needs to be fresh enough that a crash is bounded to a
 * minute or so), and not on every call.
 */
export function meteredComputerProvider(
  inner: ComputerProvider,
  deps: MeteredProviderDeps,
): ComputerProvider {
  const refreshMs = deps.refreshMs ?? 30_000;
  const now = deps.now ?? Date.now;
  const lastWritten = new Map<string, number>();

  const note = async (
    botId: string,
    work: (tenantId: string) => Promise<void>,
  ) => {
    try {
      const tenantId = await deps.tenantOf(botId);
      if (tenantId) await work(tenantId);
    } catch {
      // Never into the caller.
    }
  };

  const wrapped: ComputerProvider = {
    name: inner.name,
    isolation: inner.isolation,
    status: (botId) => inner.status(botId),
    list: () => inner.list(),
    async locate(botId) {
      const address = await inner.locate(botId);
      const last = lastWritten.get(botId) ?? 0;
      if (now() - last >= refreshMs) {
        lastWritten.set(botId, now());
        void note(botId, (tenantId) =>
          deps.meter.computerSeen({ tenantId, botId }),
        );
      }
      return address;
    },
    async stop(botId) {
      const result = await inner.stop(botId);
      lastWritten.delete(botId);
      void note(botId, () => deps.meter.computerStopped(botId));
      return result;
    },
    async reset(botId) {
      const result = await inner.reset(botId);
      lastWritten.delete(botId);
      void note(botId, async () => {
        await deps.meter.computerStopped(botId);
        await deps.meter.storageCleared(botId);
      });
      return result;
    },
  };
  if (inner.warm) wrapped.warm = () => (inner.warm as () => Promise<void>)();
  if (inner.sessionOf) {
    wrapped.sessionOf = (botId) =>
      (inner.sessionOf as (botId: string) => Promise<string | undefined>)(
        botId,
      );
  }
  return wrapped;
}

/**
 * Bring the record into line with what the provider says exists.
 *
 * Run from the sweep that suspends idle computers (`scripts/cull-idle-computers.ts`), which is already
 * the one place that looks at the whole fleet on a schedule. A computer that is up is written down as
 * up, whoever noticed; one that is recorded as up and is not, ended when it was last seen, which is
 * what makes a computer that was evicted or crashed a short charge. Storage is recorded for every
 * coworker that has a computer at all, up or suspended, because a suspended computer still holds its
 * disks, and costs for them.
 */
export async function reconcileCloudComputers(deps: {
  provider: ComputerProvider;
  meter: CloudMeter;
  tenantOf: (botId: string) => Promise<string | null>;
  /** Bytes of storage each coworker's computer holds. Zero means storage is not metered. */
  volumeBytes: number;
  staleAfterMs?: number;
}): Promise<{ up: number; closed: number }> {
  const computers = await deps.provider.list();
  const running = new Set<string>();
  const existing = new Set<string>();
  for (const computer of computers) {
    existing.add(computer.botId);
    const tenantId = await deps.tenantOf(computer.botId).catch(() => null);
    if (!tenantId) continue;
    if (computer.status === "running") {
      running.add(computer.botId);
      await deps.meter.computerSeen({ tenantId, botId: computer.botId });
    }
    if (deps.volumeBytes > 0) {
      await deps.meter.storageSeen({
        tenantId,
        botId: computer.botId,
        bytes: deps.volumeBytes,
      });
    }
  }
  let closed = 0;
  for (const botId of await deps.meter.openBots("computer")) {
    if (!running.has(botId)) {
      await deps.meter.computerStopped(botId);
      closed += 1;
    }
  }
  for (const botId of await deps.meter.openBots("storage")) {
    if (!existing.has(botId)) {
      await deps.meter.storageCleared(botId);
      closed += 1;
    }
  }
  closed += await deps.meter.closeStale(deps.staleAfterMs ?? 15 * 60_000);
  return { up: running.size, closed };
}
