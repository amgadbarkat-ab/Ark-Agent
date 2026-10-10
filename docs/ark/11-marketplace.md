# Marketplace (Phase 5)

Written 2026-10-08. How the marketplace works in the code, what is proven, and what is still open.
The decision behind it is D7 in 01-product-decisions.md.

## The one rule

There are two kinds of listing, and everything else follows from the difference.

- **Official**: one of Ark's own digital employees. Anyone can install it. Installing puts a coworker
  in the person's own account, private to them, with the role described on the page and **no tools,
  no skills and no access to anything**. They grant those afterwards, one at a time, like any
  coworker they made themselves.
- **Shared**: somebody's own coworker, published as a guide. It is **for reading only**. It cannot be
  installed, copied, imported, cloned or exported, and it never runs on another account.

This is true by construction and not by a check that could be forgotten. A shared listing is inert
text copied out of a coworker at the moment it was shared: its role, its instruction (when it has
one) and the *names* of its tools. The copy never contains the coworker's address, its key, a token,
the vault reference of its key, or the server a tool belongs to, so there is nothing in it a coworker
could be rebuilt from. The marketplace has no function that turns a listing into a coworker except
`install`, and `install` refuses anything that is not official. No route exists for copy, clone,
import or export; a test lists every route and fails if one is added.

## What a person sees

- **Marketplace** (sidebar, beside Agents). Two tabs, *Ark's digital employees* and *Shared by
  people*, a search box and a category list. Results page without repeating or skipping.
- **A listing page.** An official one shows the name, title and starting role it will install and
  has an **Install** button. A shared one says in words that it is for reading only, shows how it is
  set up, and has a **Report** button instead.
- **Share.** On a coworker's own dialog (Manage > Share), or from *Marketplace > Yours*. The person
  names themselves once (not an email address), writes a title, a line, a category, tags and a
  description. The dialog says what readers will and will not get.
- **Shared by you.** Each of the person's listings and where it stands: waiting for review,
  published, not approved (with the reason), or taken down (with the reason). They can change or
  withdraw a listing.
- **Admin > Marketplace** (staff). A review queue, oldest first, showing exactly what a stranger
  would read, with Approve and Reject (a reason is required, and the publisher is shown it). Below it,
  open reports, each with Dismiss and Take down.

## What is kept out of a listing

Before anything is saved, everything a stranger would read is scanned (`marketplace/sanitize.ts`):
title, summary, description, tags, role, instruction and tool names.

- **Secrets are always refused**: API keys (common provider shapes), private keys, access tokens,
  passwords in assignments, passwords inside web addresses. Confirming does not help; a credential has
  no safe form in a public listing.
- **Private details need the person to say they checked**: email addresses, phone numbers, payment
  card numbers (Luhn-checked), bank account numbers (IBAN, checksum-checked), and internal addresses.
  The dialog lists each one and asks for a tick before it will send.
- The refusal names the kind and the place ("Role description, line 2, looks like an API key") and
  **never repeats the text it found**.
- Refused, never quietly altered: a person told "line 2 looks like an API key" fixes it and learns
  something; a masked key would publish a coworker that no longer works without saying why.
- Checked again when staff approve. A secret is a secret whoever approves, and the scanner improves.

The scanner is pattern-based and will miss things. It is the first check; the staff reading is the
second.

## The life of a shared listing

1. The person shares a coworker they own. It is saved as **waiting for review** and is visible only to
   them and to staff.
2. Staff **approve** it (it becomes readable by everybody) or **reject** it with a reason.
3. **Any edit sends it back for review**, so an approved listing cannot be swapped for a different one.
   The copy of the coworker is retaken only when the person says so; changing the coworker does not
   change what is listed.
4. Anyone can **report** a published shared listing, once each, with a reason from a fixed list.
   Staff dismiss the report or **take the listing down** with a reason, which settles every open
   report about it. A listing taken down stays on record and cannot be edited back to life.
5. The person can **withdraw** a listing of theirs at any time (it is deleted).

Limits: ten listings waiting for review per account, fifty in all, a bounded title, summary,
description and tags, and a brake on how fast one person can submit, report or install.

## Names

A publisher's name is what strangers tell publishers apart by, so it is hard to fake. It is unique
whatever the capital letters, may not be an email address or other private detail, and may not pose as
us: "Ark", "A.r.k", "Ark Official", "Ark Team", "Ark Support" and the like are refused however they
are spaced or accented. A name that merely starts with the same letters ("Arkwright") is fine.
Listing addresses carry a random tail, so a title cannot be used to find out whether another account
has something of that name.

## Where the code is

| Piece | File |
| --- | --- |
| Vocabulary, limits, categories, report reasons (shared by app and server) | `shared/marketplace.ts` |
| Tables and enums, migration `0051` | `server/src/db/schema/marketplace.ts` |
| The secret and private-data scanner | `server/src/marketplace/sanitize.ts` |
| Ark's own digital employees (curated, in code, written to the database at every start) | `server/src/marketplace/official.ts` |
| The rules: install, share, review, report, browse | `server/src/marketplace/store.ts` |
| HTTP, `/api/marketplace/*` and `/api/admin/marketplace/*` | `server/src/marketplace/routes.ts` |
| Screens | `app/src/routes/_authed/_app/marketplace/`, `app/src/routes/_authed/admin/marketplace.tsx` |
| Share and report dialogs, listing page | `app/src/components/marketplace/` |
| Data access | `app/src/lib/marketplace/` |

To change what Ark offers, edit `official.ts`, raise the listing's `version`, and deploy. An entry
removed from the file is taken down at the next start (not deleted: installs point at it).

## Audit

`marketplace.listing_submitted`, `listing_withdrawn`, `listing_approved`, `listing_rejected`,
`listing_removed`, `listing_installed`, `report_filed` and `report_dismissed` go in the audit trail,
with who did it and, for staff decisions, the reason.

## Verified

- 38 integration tests against a real database for the store and 15 for the routes, 34 for the
  scanner, and 8 for the screens. They hold the promises directly: a shared listing cannot be
  installed and nothing is created when it is tried; the runtime never lists it; the copy never
  contains an address, a key, a vault reference, a server name or a skill; secrets are refused even
  when confirmed, and the refusal does not repeat them; an unapproved listing is invisible to everyone
  but its owner and staff; an edit returns to review; only staff can review; one report per person;
  paging neither repeats nor drops a listing; `%` and `_` in a search mean themselves.
- In a real browser against a real server and database: browse, search and install one of Ark's
  employees (it appeared as a private coworker of the person); open another account's shared listing
  (view-only, no install button, report it); share a coworker with a key in its role (refused with
  the place, no override offered), fix it, share again, see it waiting; as staff approve it and see it
  appear in the public list; take down the reported listing and see it leave.

## Not done yet

- **Updates to an installed employee.** An install records which version of the text it got, but there
  is no "a newer version exists" prompt, and installed copies are the person's to edit.
- **No auto-hide on reports.** A listing stays up until staff act. Three reports could hide it
  pending review, but that would let a few throwaway accounts take down a rival, so it is left to
  people for now.
- **No notification** to a publisher when their listing is reviewed. They see the status under
  *Shared by you*.
- **Staff review is manual and has no appeal flow.** Fine at this scale.
- **Sign-in is required to browse.** There is no public storefront page.
- **One publisher face per account.** In `internal` mode that means everybody at the company shares
  one; with shared seats later, teammates can manage each other's listings. That matches how coworkers
  already work, and is deliberate.
- **The limits on submitting, reporting and installing are in memory**, per server process: a brake,
  not a ledger.
- **No ratings, reviews, avatars or screenshots**, and the catalogue has seven employees. Their
  wording is a first draft for the owner to review.
- **Desktop and mobile apps** do not show the marketplace yet. It is in the web app (Phase 6 brings
  the apps onto the same screens).
- **Selling listings** (paid employees, revenue share) is not designed; the decision is only that Ark
  publishes its own and users share theirs for reading.
