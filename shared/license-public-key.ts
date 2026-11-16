/**
 * The BlackArk public keys every ArkAgent build trusts for paid licence keys (#109, v0.1.42).
 *
 * Public by design: they can only CHECK a signature. For now this is the same key as the trial key
 * (`trial-public-key.ts`), so BlackArk can sign licence keys by hand on the signing computer today.
 * When the payment server signs licence keys on its own, it gets a key of its own: made with
 * `bun scripts/ark-trial.ts keygen --dir ~/.arklicense`, its public half added here, and the trial
 * key removed from this list in a later release. Every key signed with a removed key stops working.
 */
import { TRIAL_PUBLIC_KEYS } from "./trial-public-key";

export const LICENSE_PUBLIC_KEYS: readonly string[] = [...TRIAL_PUBLIC_KEYS];
