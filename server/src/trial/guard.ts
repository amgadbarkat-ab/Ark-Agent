/**
 * Where the trial reaches the rest of the server (#109): the block on making employees, and the plan.
 *
 * THE BLOCK SITS ON THE STORE, NOT ON EACH ROUTE. Every way a person gets a new employee ends in
 * `create` or `duplicate` here: hiring from the marketplace, the New form, Duplicate, and an employee
 * proposing one in a conversation (`save_bot`, which the app sends to `POST /api/agents`). A route
 * added later goes through the same two doors, so it is blocked without anybody remembering to.
 *
 * Bringing back a hidden employee is blocked too, unless it is one of the roster: under the block the
 * customer has exactly the employees the profile names.
 *
 * THE PROFILE'S EMPLOYEES KEEP THE PROFILE'S INSTRUCTION (#116). Every change to an employee ends in
 * `update`: the edit screen, and an approved request from a colleague to rewrite its instructions.
 * For an employee the signed profile set up, an update that would change its role description or
 * standing instruction is refused while the profile owns them; its name, title, picture and the rest
 * still change. An employee the customer made is never touched by this.
 */
import type { AccountStore } from "../accounts/store";
import type { AgentProfileStore } from "../agents/profile-store";
import type { AgentProfile, CreateAgentInput } from "../agents/profile-types";
import type { AgentLimit } from "./agent-limit";
import {
  TrialCreateBlockedError,
  TrialInstructionsLockedError,
  type TrialService,
} from "./service";

/** Whether this edit would change what the employee runs on: its role or standing instruction. */
export function changesInstructions(
  before: Pick<AgentProfile, "roleDescription" | "persona">,
  input: Pick<CreateAgentInput, "roleDescription" | "persona">,
): boolean {
  if (input.roleDescription.trim() !== before.roleDescription.trim()) {
    return true;
  }
  if (input.persona === undefined) return false;
  return (input.persona?.trim() || null) !== (before.persona?.trim() || null);
}

export function guardProfiles(
  store: AgentProfileStore,
  trial: Pick<
    TrialService,
    "refuseCreate" | "createBlocked" | "onRoster" | "instructionsLocked"
  >,
  /**
   * Ark Team's agent limit (v0.1.49, agent-limit.ts). Absent: no limit, as before. Bringing back a
   * hidden employee is not checked against it: a hidden one is still counted.
   */
  limit?: Pick<AgentLimit, "refuseAdd">,
): AgentProfileStore {
  /*
   * One add at a time on this server, so two made at the same moment cannot both pass a count of
   * one less than the limit. A desktop install is one server process.
   */
  let adding: Promise<unknown> = Promise.resolve();
  function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
    const next = adding.then(work, work);
    adding = next.catch(() => undefined);
    return next;
  }
  return {
    ...store,
    async update(actor, id, input) {
      if (await trial.instructionsLocked(id)) {
        const before = await store.get(actor, id);
        if (before && changesInstructions(before, input)) {
          throw new TrialInstructionsLockedError();
        }
      }
      return store.update(actor, id, input);
    },
    async create(actor, input) {
      await trial.refuseCreate();
      return oneAtATime(async () => {
        await limit?.refuseAdd(actor, "create");
        return store.create(actor, input);
      });
    },
    async duplicate(actor, id) {
      await trial.refuseCreate();
      return oneAtATime(async () => {
        await limit?.refuseAdd(actor, "duplicate");
        return store.duplicate(actor, id);
      });
    },
    async setHidden(actor, id, hidden) {
      if (
        !hidden &&
        (await trial.createBlocked()) &&
        !(await trial.onRoster(id))
      ) {
        throw new TrialCreateBlockedError();
      }
      return store.setHidden(actor, id, hidden);
    },
  };
}

/** The account's plan and whether it may run, with the trial's say added. */
export function withTrialEntitlement(
  accounts: AccountStore,
  trial: {
    entitlement: TrialService["entitlement"];
    /** The trial setup file's trial, for the period end shown. */
    trialCurrent: TrialService["current"];
  },
): AccountStore {
  return {
    ...accounts,
    async entitlementFor(userId) {
      return trial.entitlement(await accounts.entitlementFor(userId));
    },
    async summaryFor(userId) {
      const summary = await accounts.summaryFor(userId);
      const entitlement = await trial.entitlement(summary);
      const current = await trial.trialCurrent();
      return {
        ...summary,
        ...entitlement,
        ...(current &&
        current.status !== "paid" &&
        entitlement.subscriptionStatus === "trialing"
          ? { currentPeriodEnd: current.endsAt }
          : {}),
      };
    },
  };
}
