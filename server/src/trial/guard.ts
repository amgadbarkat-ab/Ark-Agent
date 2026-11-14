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
 */
import type { AccountStore } from "../accounts/store";
import type { AgentProfileStore } from "../agents/profile-store";
import { TrialCreateBlockedError, type TrialService } from "./service";

export function guardProfiles(
  store: AgentProfileStore,
  trial: Pick<TrialService, "refuseCreate" | "createBlocked" | "onRoster">,
): AgentProfileStore {
  return {
    ...store,
    async create(actor, input) {
      await trial.refuseCreate();
      return store.create(actor, input);
    },
    async duplicate(actor, id) {
      await trial.refuseCreate();
      return store.duplicate(actor, id);
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
  trial: Pick<TrialService, "entitlement" | "current">,
): AccountStore {
  return {
    ...accounts,
    async entitlementFor(userId) {
      return trial.entitlement(await accounts.entitlementFor(userId));
    },
    async summaryFor(userId) {
      const summary = await accounts.summaryFor(userId);
      const entitlement = await trial.entitlement(summary);
      const current = await trial.current();
      return {
        ...summary,
        ...entitlement,
        ...(current && current.status !== "paid"
          ? { currentPeriodEnd: current.endsAt }
          : {}),
      };
    },
  };
}
