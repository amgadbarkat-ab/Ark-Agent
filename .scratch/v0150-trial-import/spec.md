# v0.1.50: no trial-specific UI; staff load a signed profile from a folder

Status: claimed (sub-agent J, for PE). Toolkit: Matt Pocock's skills (`/tdd`).
Ordered by Amgad, 19 Nov 2026 12:57 Athens. Rule of 16 Nov: one general release; nothing trial- or
customer-specific visible in the app; customer specifics loaded only in the on-site setup session.

## Inventory: what a customer could see (origin/main, 07a55d2)

| Where | What | Decision |
| --- | --- | --- |
| Setup window (`desktop/src/TrialImport.tsx`, `main.tsx`) | "Import trial profile" beside EN / ΕΛ | Removed |
| Activate screen (`ActivationForm`, default `showFileImport`) | "Trial setup file (.arktrial)" + Choose file | Removed (code box stays) |
| Settings → Plan → Trial (`trial-section.tsx`) | "Import trial profile" row (admin), empty-state "If BlackArk sent you a trial profile (.arktrial)..." | Removed |
| Settings → Plan → Trial | "Trial for {customer}, set by BlackArk." | Customer name dropped |
| Settings → Plan → Activation | "...or the trial setup file." | Reworded to code / key only |
| Agent dialog, locked instructions (#116) | "Set by BlackArk in the signed trial profile..." | Left: generic, same for everyone; borderline |
| Settings → Help, support payload preview | `Customer: <customerId>` row | Left: borderline |
| `/admin/trials` | install list | BlackArk receiver only (ARK_TRIAL_RECEIVER); not on a customer install |

## Seams under test

1. Desktop `SetupWindow` (the setup window's chrome): no import button, no file picker, EN and EL.
2. Rust `trial_profile::pick_up_with(config, post)`: the drop folder. Valid file moved to
   `imported/`, refused file moved to `refused/` with the reason in `import.log` and nothing for the
   window to show, unreachable left in place, every attempt appended to the log.
   Misses: the signature itself (the server's job).
3. Server `POST /api/trial/profile` exactly as the folder sends it: signed taken and audited,
   unsigned and altered refused. Regression guard: verification unchanged.
4. App screens (Settings → Plan, Activate): never show the trial's customer name, never offer a
   profile import.

## Hidden route: (a) drop folder

`<app config dir>/import/*.arktrial`, picked up when ArkAgent opens its app (after the server is up).
Paths per OS in docs/trials/README.md.
