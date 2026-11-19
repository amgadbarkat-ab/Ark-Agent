/**
 * Who this install is, and BlackArk's own proof of it (#149 Help & support; v0.1.49, the licence
 * key fetched after payment): the licence key first, then the signed trial setup file, then the
 * trial activation code. Exactly as BlackArk issued them; blackark.uk checks each signature
 * (`ark_install_proof_ok` in infra/blackark-checkin/checkin/lib.php). Null when there is none.
 */
import type { Database } from "../db/client";
import { activationState, trialState } from "../db/schema";

export type InstallProof =
  | { kind: "profile"; profile: string; signature: string }
  | { kind: "code"; payload: string; signature: string };

export type InstallIdentity = {
  customerId: string;
  installId: string;
  proof: InstallProof;
};

export async function installIdentity(
  database: Database,
): Promise<InstallIdentity | null> {
  const [activation] = await database.select().from(activationState).limit(1);
  const fromCode = activation
    ? {
        customerId: activation.customerId,
        installId: activation.installId,
        proof: {
          kind: "code" as const,
          payload: activation.payload,
          signature: activation.signature,
        },
      }
    : null;
  if (activation?.kind === "license") return fromCode;
  const [trial] = await database.select().from(trialState).limit(1);
  if (trial) {
    return {
      customerId: trial.customerId,
      installId: trial.installId,
      proof: {
        kind: "profile",
        profile: trial.profile,
        signature: trial.signature,
      },
    };
  }
  return fromCode;
}
