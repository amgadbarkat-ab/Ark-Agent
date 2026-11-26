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

/**
 * The public keys of blackark.uk's self-serve trial signer (v0.1.58; Amgad, 26 Nov 2026), made with
 * `bun scripts/ark-trial.ts selfserve-keygen`. Trusted for ONE thing only: an Ark Team trial
 * activation code of at most SELF_SERVE_TRIAL_DAYS, without add-ons (`selfServeTrialShapeOk`). Never
 * for trial setup files, unlock codes or licence keys, so a leak of that key can start short trials
 * and nothing more. Empty until BlackArk posts the key; then no self-serve code is accepted.
 */
export const SELF_SERVE_TRIAL_PUBLIC_KEYS: readonly string[] = [];

export const SELF_SERVE_TRIAL_DAYS = 7;

/** Whether a trial code is one a self-serve key may sign: team, no add-ons, at most 7 days (+1). */
export function selfServeTrialShapeOk(code: {
  action: string;
  plan: string;
  issuedAt: string;
  until?: string;
  addons?: readonly string[];
}): boolean {
  if (code.action !== "trial" || code.plan !== "team") return false;
  if (code.addons && code.addons.length > 0) return false;
  const issued = Date.parse(code.issuedAt);
  const until = Date.parse(code.until ?? "");
  return (
    Number.isFinite(issued) &&
    Number.isFinite(until) &&
    until > issued &&
    until - issued <= (SELF_SERVE_TRIAL_DAYS + 1) * 86_400_000
  );
}
