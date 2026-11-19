# DT Lab findings on v0.1.48 (BAT-0007, issue #109)

Ordered by Amgad, 18 Nov 2026 21:23 Athens. Worked by sub-agent F for PE on `claude/dt-v0148-fixes`,
with Matt Pocock's skills (`/tdd`, `/diagnosing-bugs`). Every fix starts with a failing test.

| # | Finding | Status |
|---|---------|--------|
| E1 | Legal Helper disclaimer paraphrased; no-hire rated Yellow; no overall rating | see below |
| F1 | Download in the desktop window saves silently into the working folder | see below |
| W2 | First start after update pulls images for ~25 min with no progress | see below |
| M1 | "Legal Helper at Internal" when no company name is set | see below |
| W1 | Activation gate after update (report only, no change) | see below |

## Seams under test

Taken from the brief (PE could not be asked separately from inside this run):

- E1: the AG-UI event stream of one Legal Helper run, at the agent wrapper. A stand-in model feeds
  events in; the test reads what the person would see. Catches a missing, paraphrased or doubled
  disclaimer, the wrong language, a missing or ambiguous overall rating, a no-hire row not Red.
  Misses what a real model writes.
- E1: which digital employee is a Legal Helper, read from the install record (integration test).
- M1: `composeInstruction`, the account name an install uses, and the read-time standing role.
- F1, W2: the desktop's own pure helpers and Tauri-side functions.

## Notes

- E1, resolved. `server/src/marketplace/legal-answer.ts` (`LegalHelperAgent`, inside the run gate in
  `server/src/index.ts`) adds the fixed line at both ends, strips paraphrases from the first and last
  sentences, forces a no-hire row Red and appends one overall rating to an NDA triage (triage = the
  person's last message names an NDA or `/legal-nda-triage`). Which employee is a Legal Helper:
  `MarketplaceStore.installedRole`. Skill text strengthened; role version 1 -> 2. Trade-off: a Legal
  Helper's messages arrive whole, not word by word. The Greek line is a draft for Amgad's yes.
- M1, resolved. `companyFromAccountName` ignores the placeholder "Internal"; `withoutPlaceholderCompany`
  reads old instructions without it.
- F1, resolved with Downloads + a box with the path and "Show in folder". A Save As dialog would need a
  custom command reachable from the remote page (an app ACL manifest), which changes the permission
  model for every command: left for PE/Amgad.
- W2, resolved (diagnosis: the count was only sent inside the byte callback). `pull_metrics::pull_all`.
- W1, report only: the activation gate is by design (v0.1.42, `server/src/trial/activation.ts`,
  `ARK_ACTIVATION_REQUIRED=true` from `desktop/src-tauri/src/env.rs`, redirect in
  `app/src/routes/_authed.tsx`).
- Container: 8 desktop lib tests fail here for the container's own reasons (no IPv6, running as root),
  in files this branch does not touch. Disk was full during the work.
