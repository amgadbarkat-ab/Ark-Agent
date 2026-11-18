# Proposed check-in payload change (for PE; the desktop app is not changed here)

Status: resolved (implemented, #149 milestone 3; privacy notice updated)

The board can only show what a check-in sends. Today (v0.1.38+) a check-in is:
`customerId, installId, version, status, daysLeft, endsAt, employees, proof`.

For the Customers page to answer "is this customer actually using it?", these **counts only** would
help. No names, no content, nothing a person wrote:

| Field | Type | Meaning |
|---|---|---|
| `people` | int 0–10000 | people (staff accounts) on this install |
| `activePeople7d` | int 0–10000 | of those, how many signed in in the last 7 days |
| `conversations7d` | int 0–1000000 | conversations started in the last 7 days |
| `phoneLine` | bool | whether a phone line is connected on this install |
| `os` | `"windows" \| "macos" \| "linux"` | for support only |

Receiver change (`checkin/index.php`): add the names to `$allowed`, validate each as above, store
in new nullable columns on `installs` (`ALTER TABLE … ADD COLUMN` guarded by `PRAGMA table_info`),
and add them to the export. Older installs send none, which shows as "–".

Questions for PE / Amgad:
- Is `activePeople7d` acceptable under the privacy text the customer agreed to? It is a count, but
  it is about the customer's staff.
- Should these be sent only after the customer's yes in Settings (as the trial check-in is)?
