/**
 * The BlackArk public key every ArkAgent build trusts for trial profiles and unlock codes (#109).
 *
 * Public by design: it can only CHECK a signature. The matching private key is kept by BlackArk on
 * the signing computer and is never in this repository, a build, or the app.
 *
 * Empty until BlackArk posts the key made with `bun scripts/ark-trial.ts keygen`. While it is empty,
 * a desktop build accepts no profile at all: it says so, and nothing about the trial changes.
 */
export const TRIAL_PUBLIC_KEYS: readonly string[] = [];
