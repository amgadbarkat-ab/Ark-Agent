import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type RunAgentInput,
} from "@ag-ui/client";
import { Observable } from "rxjs";
import { formatEur, nextPlanUp } from "../../../shared/plans";
import type { CloudGate } from "../cloud/gate";
import type { CloudMeter } from "../cloud/meter";
import type { AccountStore, Entitlement } from "./store";
import type { RunSlots } from "./run-slots";

export type RunGateOptions = {
  accounts: Pick<AccountStore, "entitlementFor">;
  slots: RunSlots;
  /** How long a run waits for a place before giving up. */
  queueTimeoutMs?: number;
  /** How often a waiting run looks again. */
  pollMs?: number;
  /** How often a working run renews its place. */
  heartbeatMs?: number;
  /** The page where a customer changes plan, as the app serves it. */
  upgradePath?: string;
  /**
   * Whether this run may use the cloud (docs/ark/17-cloud-runtime.md), and the record of the time it
   * uses. Absent means neither is asked or kept, which is how every deployment worked before.
   */
  cloud?: { gate: CloudGate; meter: CloudMeter };
};

const DEFAULT_QUEUE_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_POLL_MS = 1_500;
const DEFAULT_HEARTBEAT_MS = 30_000;

/** What the person is told when every place is taken, with the way to get more. */
export function queuedNotice(
  entitlement: Entitlement,
  active: number,
  upgradePath: string,
): string {
  const limit = entitlement.maxActiveBots ?? active;
  const up = nextPlanUp(entitlement.planId);
  const offer = up
    ? ` To run more at once, [upgrade to ${up.name}](${upgradePath}) (${formatEur(up.priceEurCents)} a month, up to ${up.maxActiveBots} at the same time).`
    : "";
  return `${entitlement.planName} lets ${limit === 1 ? "1 digital employee" : `${limit} digital employees`} work at the same time, and ${active === 1 ? "1 is" : `${active} are`} working now. I'll start as soon as one finishes.${offer}`;
}

export function timedOutNotice(
  entitlement: Entitlement,
  minutes: number,
  upgradePath: string,
): string {
  const up = nextPlanUp(entitlement.planId);
  return `Still waiting for a free place after ${minutes} minutes, so this was not started. Try again when another digital employee has finished${up ? `, or [upgrade to ${up.name}](${upgradePath}) to run more at once` : ""}.`;
}

/**
 * Stands in front of one coworker and enforces the plan on every run it makes.
 *
 * It is the single place the quota is applied, and it is placed around the agent rather than inside
 * the chat endpoint so that a routine at three in the morning and a hand-off from another coworker
 * are held to the same limit as a person typing.
 *
 * A run waits its turn instead of being refused: while it waits, the conversation says so and says
 * how to get more places, and it starts the moment one frees. Only an account that may not run at
 * all (suspended, no plan, ended) is refused, with the reason.
 */
export class RunGateAgent extends AbstractAgent {
  private inner: AbstractAgent;
  private actorId: string;
  private botId: string;
  private options: RunGateOptions;
  private abort?: AbortController;

  constructor(
    inner: AbstractAgent,
    who: { actorId: string; botId: string },
    options: RunGateOptions,
  ) {
    super({ agentId: inner.agentId, description: inner.description });
    this.inner = inner;
    this.actorId = who.actorId;
    this.botId = who.botId;
    this.options = options;
  }

  getCapabilities() {
    return this.inner.getCapabilities?.() ?? Promise.resolve({});
  }

  clone(): RunGateAgent {
    const cloned = super.clone() as RunGateAgent;
    // The base clone copies only its own fields; the runtime clones before every run.
    cloned.inner = this.inner.clone();
    cloned.actorId = this.actorId;
    cloned.botId = this.botId;
    cloned.options = this.options;
    cloned.abort = undefined;
    return cloned;
  }

  abortRun(): void {
    this.abort?.abort();
    this.inner.abortRun();
    super.abortRun();
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    const { accounts, slots } = this.options;
    const pollMs = this.options.pollMs ?? DEFAULT_POLL_MS;
    const heartbeatMs = this.options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    const timeoutMs = this.options.queueTimeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS;
    const upgradePath = this.options.upgradePath ?? "/settings/plan";
    const actorId = this.actorId;
    const botId = this.botId;
    const controller = new AbortController();
    this.abort = controller;

    return new Observable<BaseEvent>((subscriber) => {
      let tenantId: string | undefined;
      let held = false;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let innerSubscription: { unsubscribe: () => void } | undefined;
      let announced = false;

      const sleep = (ms: number) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, ms);
          controller.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });

      const letGo = async () => {
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = undefined;
        if (held && tenantId) {
          held = false;
          // Never throws into the run: a place that cannot be released simply expires.
          await slots.release(tenantId, input.runId).catch(() => undefined);
          // The record of time used. Never throws into the run: a missing end is bounded by the last
          // time the run was seen, so the worst it costs is a few seconds of accuracy.
          await this.options.cloud?.meter
            .runEnded(input.runId)
            .catch(() => undefined);
        }
      };

      const started = () => {
        subscriber.next({
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
        } as BaseEvent);
      };

      const say = (text: string) => {
        const messageId = `ark-notice-${crypto.randomUUID()}`;
        subscriber.next({
          type: EventType.TEXT_MESSAGE_START,
          messageId,
          role: "assistant",
        } as BaseEvent);
        subscriber.next({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId,
          delta: text,
        } as BaseEvent);
        subscriber.next({
          type: EventType.TEXT_MESSAGE_END,
          messageId,
        } as BaseEvent);
      };

      (async () => {
        let entitlement: Entitlement;
        try {
          entitlement = await accounts.entitlementFor(actorId);
        } catch {
          // Fail closed, and say so: a paid limit that cannot be checked is not skipped.
          subscriber.error(
            new Error(
              "Your plan could not be checked just now. Try again in a moment.",
            ),
          );
          return;
        }
        if (!entitlement.canRun) {
          subscriber.error(
            new Error(
              entitlement.blockedReason ??
                "This account cannot run digital employees.",
            ),
          );
          return;
        }
        tenantId = entitlement.tenantId;

        // Before a place is taken: a run that may not use the cloud should not hold one.
        const cloud = this.options.cloud;
        if (cloud) {
          let decision: Awaited<ReturnType<CloudGate["check"]>>;
          try {
            decision = await cloud.gate.check({ tenantId, botId });
          } catch {
            subscriber.error(
              new Error(
                "Cloud running could not be checked just now. Try again in a moment.",
              ),
            );
            return;
          }
          if (!decision.ok) {
            started();
            subscriber.next({
              type: EventType.CUSTOM,
              name: "ark.cloud_refused",
              value: { code: decision.code },
            } as BaseEvent);
            say(decision.reason);
            subscriber.next({
              type: EventType.RUN_FINISHED,
              threadId: input.threadId,
              runId: input.runId,
            } as BaseEvent);
            subscriber.complete();
            return;
          }
        }
        const limit = entitlement.maxActiveBots;
        const deadline = Date.now() + timeoutMs;

        for (;;) {
          if (controller.signal.aborted || subscriber.closed) return;
          let result: Awaited<ReturnType<RunSlots["tryAcquire"]>>;
          try {
            result = await slots.tryAcquire({
              tenantId,
              userId: actorId,
              botId,
              runId: input.runId,
              limit,
            });
          } catch {
            subscriber.error(
              new Error(
                "Your plan could not be checked just now. Try again in a moment.",
              ),
            );
            return;
          }
          if (result.ok) {
            held = true;
            void this.options.cloud?.meter
              .runStarted({ tenantId, botId, runId: input.runId })
              .catch(() => undefined);
            break;
          }
          if (!announced) {
            announced = true;
            started();
            subscriber.next({
              type: EventType.CUSTOM,
              name: "ark.queued",
              value: {
                planId: entitlement.planId,
                limit: result.limit,
                active: result.active,
                upgradePlanId: nextPlanUp(entitlement.planId)?.id ?? null,
              },
            } as BaseEvent);
            say(queuedNotice(entitlement, result.active, upgradePath));
          }
          if (Date.now() >= deadline) {
            say(
              timedOutNotice(
                entitlement,
                Math.round(timeoutMs / 60_000),
                upgradePath,
              ),
            );
            subscriber.next({
              type: EventType.RUN_FINISHED,
              threadId: input.threadId,
              runId: input.runId,
            } as BaseEvent);
            subscriber.complete();
            return;
          }
          await sleep(pollMs);
        }

        // Keep the place alive while the run works. A renewal never refuses.
        heartbeat = setInterval(() => {
          if (!tenantId) return;
          void slots
            .tryAcquire({
              tenantId,
              userId: actorId,
              botId,
              runId: input.runId,
              limit: null,
            })
            .catch(() => undefined);
          void this.options.cloud?.meter
            .runSeen(input.runId)
            .catch(() => undefined);
        }, heartbeatMs);

        innerSubscription = this.inner.run(input).subscribe({
          next: (event) => {
            // The conversation already has its RUN_STARTED if the run waited.
            if (announced && event.type === EventType.RUN_STARTED) return;
            subscriber.next(event);
          },
          error: (error) => {
            void letGo();
            subscriber.error(error);
          },
          complete: () => {
            void letGo();
            subscriber.complete();
          },
        });
      })().catch((error) => subscriber.error(error));

      return () => {
        controller.abort();
        innerSubscription?.unsubscribe();
        void letGo();
      };
    });
  }
}
