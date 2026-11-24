/**
 * The team's EUR 15 sub-profiles, through blackark.uk/checkin/team/ (Amgad, 24 Nov 2026).
 *
 * WHAT IS SENT: the customer id, this install's random id and BlackArk's own proof of it (as for Help &
 * support), the number of sub-profiles the administrator now wants, and the team as the board shows it
 * (each person's name, email, role, status, when they were added, and how many employees they have).
 * WHAT COMES BACK: how many are paid for, and a Stripe checkout address when they must be paid first.
 */
import type { Database } from "../db/client";
import { installIdentity } from "../trial/install-proof";
import type { TeamBilling, TeamRosterEntry } from "./team";

export const DEFAULT_TEAM_URL = "https://blackark.uk/checkin/team/";

export class NotActivatedError extends Error {
  override name = "NotActivatedError";
}

export function blackarkTeamBilling(
  database: Database,
  options: { url?: string; send?: typeof fetch } = {},
): TeamBilling {
  const url = options.url ?? DEFAULT_TEAM_URL;
  const send = options.send ?? fetch;
  async function ask(extra: Record<string, unknown>) {
    const who = await installIdentity(database);
    if (!who) throw new NotActivatedError("not activated");
    const response = await send(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        customerId: who.customerId,
        installId: who.installId,
        proof: who.proof,
        ...extra,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await response.json().catch(() => null)) as {
      paid?: unknown;
      checkoutUrl?: unknown;
    } | null;
    if (!response.ok || typeof body?.paid !== "number")
      throw new Error(`BlackArk answered ${response.status}`);
    return {
      paidQuantity: Math.max(0, Math.floor(body.paid)),
      checkoutUrl:
        typeof body.checkoutUrl === "string" &&
        body.checkoutUrl.startsWith("https://checkout.stripe.com/")
          ? body.checkoutUrl
          : null,
    };
  }
  return {
    request: (quantity: number, members?: TeamRosterEntry[]) =>
      ask({ quantity, ...(members ? { members } : {}) }),
    paid: async (members?: TeamRosterEntry[]) =>
      (await ask(members ? { members } : {})).paidQuantity,
  };
}
