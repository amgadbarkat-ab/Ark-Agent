/**
 * The BlackArk public keys every ArkAgent build trusts for paid licence keys (#109, v0.1.42).
 *
 * Public by design: they can only CHECK a signature. The private halves stay on the signing
 * computer and in the payment server's config, never in this repository or the app.
 *
 * - The licence key (v0.1.46): made with `bun scripts/ark-trial.ts license-keygen` on Amgad's PC,
 *   posted on #109 (6944133201). The Stripe pages on blackark.uk sign paid keys with its private half.
 * - The trial key, kept for now so licence keys already signed by hand keep working. It is removed
 *   from this list in a later release; every key signed with a removed key stops working.
 */
import { TRIAL_PUBLIC_KEYS } from "./trial-public-key";

export const LICENSE_SIGNING_PUBLIC_KEY =
  "QRXNjz0m4Ovz0o//7g9+ty4ss6gplI4b3Hq7/vFHoEY=";

export const LICENSE_PUBLIC_KEYS: readonly string[] = [
  LICENSE_SIGNING_PUBLIC_KEY,
  ...TRIAL_PUBLIC_KEYS,
];
