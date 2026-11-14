/**
 * The BlackArk public key every ArkAgent build trusts for trial profiles and unlock codes (#109).
 *
 * Public by design: it can only CHECK a signature. The matching private key is kept by BlackArk on
 * the signing computer and is never in this repository, a build, or the app.
 *
 * Made by BlackArk with `bun scripts/ark-trial.ts keygen` and posted on #109 (comment 6882703403,
 * 14 Nov 2026). A second key can be added beside it to rotate; removing one makes every trial and
 * code signed with it stop working.
 */
export const TRIAL_PUBLIC_KEYS: readonly string[] = [
  "+sUZUOflN+rBn01lZ1gTFr/Q2hL/OqhJqJ1XizQ9+9o=",
];
