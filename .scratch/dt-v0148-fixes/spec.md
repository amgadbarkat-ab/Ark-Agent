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

(appended as the work goes)
