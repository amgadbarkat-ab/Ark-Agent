import {
  chargeCents,
  type CloudRates,
  type CloudUsage,
} from "../../../shared/cloud-pricing";
import type { RunLocation } from "../agents/profile-types";
import type { CloudConfig } from "../config";
import { periodOf } from "./intervals";
import type { CloudMeter } from "./meter";
import type { CloudStore } from "./store";

/**
 * Whether a run may use the cloud, and what a person is shown about it.
 *
 * The rules are D5's. A coworker set to run on the person's computer is not run in the cloud behind
 * their back. Where cloud running is an add-on (`metered`), it runs only for an account that has
 * switched it on having seen the prices, and only until the month's limit they set. Where it is
 * `included`, it is not asked about at all, so a deployment that has not decided to charge for it
 * behaves exactly as it always has.
 *
 * Every refusal says what to do next, as a link, because a person who is turned away from something
 * they pay for should never have to guess.
 */

export type CloudDecision =
  | { ok: true }
  | {
      ok: false;
      code: "off" | "on_device" | "no_rates" | "not_enabled" | "cap_reached";
      reason: string;
    };

export type CloudStatus = {
  mode: CloudConfig["mode"];
  /** Whether this account has to opt in at all. */
  addOn: boolean;
  /** Whether it can be switched on yet: there are prices to agree to. */
  priced: boolean;
  rates: CloudRates | null;
  enabled: boolean;
  monthlyCapCents: number;
  defaultCapCents: number;
  period: string;
  usage: CloudUsage;
  hours: number;
  /** What this month would be charged if it ended now. */
  chargeSoFarCents: number;
  /** At or over four fifths of the limit. */
  nearCap: boolean;
  atCap: boolean;
};

export type CloudGate = {
  check: (input: { tenantId: string; botId: string }) => Promise<CloudDecision>;
  status: (tenantId: string) => Promise<CloudStatus>;
};

export function createCloudGate(deps: {
  config: CloudConfig;
  /** A hosted service with customers (`subscriptions`), as against a company's own deployment. */
  hosted: boolean;
  store: CloudStore;
  meter: CloudMeter;
  runLocationOf: (botId: string) => Promise<RunLocation | null>;
  planPath?: string;
  now?: () => Date;
}): CloudGate {
  const { config, hosted, store, meter } = deps;
  const planPath = deps.planPath ?? "/settings/plan";
  const now = deps.now ?? (() => new Date());
  const addOn = hosted && config.mode === "metered";

  async function status(tenantId: string): Promise<CloudStatus> {
    const [rates, account] = await Promise.all([
      store.rates(),
      store.account(tenantId),
    ]);
    // What is held against the limit starts when the person agreed to the prices, not before.
    const usage = await meter.usageFor(tenantId, periodOf(now()), {
      ...(addOn && account.consentedAt ? { since: account.consentedAt } : {}),
    });
    const cap = account.monthlyCapCents ?? config.defaultCapCents;
    const charge = rates ? chargeCents(usage, rates) : 0;
    return {
      mode: config.mode,
      addOn,
      priced: rates !== null,
      rates,
      enabled: account.enabled,
      monthlyCapCents: cap,
      defaultCapCents: config.defaultCapCents,
      period: periodOf(now()),
      usage,
      hours: usage.computeSeconds / 3600,
      chargeSoFarCents: charge,
      nearCap: addOn && cap > 0 && charge >= cap * 0.8,
      atCap: addOn && charge >= cap,
    };
  }

  return {
    status,

    async check({ tenantId, botId }) {
      if (config.mode === "off") {
        return {
          ok: false,
          code: "off",
          reason:
            "Running in the cloud is switched off on this service, so this was not started.",
        };
      }
      if (hosted) {
        const where = await deps.runLocationOf(botId);
        if (where === "device") {
          return {
            ok: false,
            code: "on_device",
            reason: `This digital employee is set to run on your own computer, so it was not started here. Open the Ark desktop app to run it, or [let it run in Ark's cloud](${planPath}).`,
          };
        }
      }
      if (!addOn) return { ok: true };

      const rates = await store.rates();
      if (!rates) {
        return {
          ok: false,
          code: "no_rates",
          reason:
            "Running in Ark's cloud is not available yet. Run this digital employee on your own computer for now.",
        };
      }
      const account = await store.account(tenantId);
      if (!account.enabled) {
        return {
          ok: false,
          code: "not_enabled",
          reason: `Running in Ark's cloud is an add-on, priced at what it costs. [See the prices and switch it on](${planPath}), or run this digital employee on your own computer.`,
        };
      }
      const cap = account.monthlyCapCents ?? config.defaultCapCents;
      const charge = chargeCents(
        await meter.usageFor(tenantId, periodOf(now()), {
          ...(account.consentedAt ? { since: account.consentedAt } : {}),
        }),
        rates,
      );
      if (charge >= cap) {
        return {
          ok: false,
          code: "cap_reached",
          reason: `This month's limit for cloud running has been reached, so this was not started. [Raise the limit](${planPath}) or wait for next month.`,
        };
      }
      return { ok: true };
    },
  };
}
