/**
 * Who this install is, and BlackArk's own proof of it (#149 Help & support; v0.1.49, the licence
 * key fetched after payment): the licence key first, then the signed trial setup file, then the
 * trial activation code. Exactly as BlackArk issued them; blackark.uk checks each signature
 * (`ark_install_proof_ok` in infra/blackark-checkin/checkin/lib.php). Null when there is none.
 */
import type { Database } from "../db/client";
import { activationState, supportInstall, trialState } from "../db/schema";

/**
 * This install's own random id before it is activated, made once and kept (v0.1.53 for Help &
 * support; v0.1.58 for the self-serve trial, so blackark.uk's one-trial-per-computer rule sees the
 * same computer each time). Once activated, the activation's own id is used instead.
 */
export async function preActivationInstallId(
  database: Database,
): Promise<string> {
  await database.insert(supportInstall).values({}).onConflictDoNothing();
  const [row] = await database.select().from(supportInstall).limit(1);
  if (!row) throw new Error("The install id could not be kept.");
  return row.installId;
}

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
