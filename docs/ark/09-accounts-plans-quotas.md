# Accounts, plans and the run quota (Phase 3)

Written 2026-10-08. How a customer's account, plan and limit work in the code, what is proven, and
what is still open. The decisions behind it are D3 to D5 in 01-product-decisions.md.

## Words

- **Account** (in the code: `tenant`) is the customer boundary: who pays, what they bought, and what
  they own. The table is `tenants` because the sign-in library already uses `accounts` for one
  person's login method.
- **Tenant package** (older, from OpenBot) is only a configuration bundle that ships coworkers. It is
  not a customer. The "platform's own coworkers" are the ones it ships.
- **Plan** is in `shared/plans.ts`: ArkAgent EUR 50 / 1 bot, Ark Team EUR 100 / 15, Ark Team
  Enterprise EUR 250 / 500, and an `internal` plan (unlimited, never sold) for our own staff.

## The data

Migrations 0048 to 0050.

| Table | What it holds |
| --- | --- |
| `tenants` | The account: name, active or suspended, and the suspension reason the customer is shown. |
| `tenant_memberships` | Which people belong to which account, with a role. One row per account today; shared seats later add rows, not a rewrite. |
| `subscriptions` | One per account: plan, status, payment provider and its ids, period end, cancel-at-period-end. |
| `run_slots` | One row per run that is working: which account, which bot, which run, until when. |
| `billing_events` | What the payment provider told us, unique per provider event, so a repeat does nothing. |
| `agent_profiles.tenant_id` | Whose account a coworker belongs to. Null for the platform's own. |

## The two modes (`ARK_BILLING_MODE`)

- **internal** (default): a company running Ark for itself. One account for everybody, unlimited,
  nobody pays. Staff share public coworkers exactly as they did before accounts existed. The
  migration puts everyone who already exists into that one account.
- **subscriptions**: a hosted service with customers. Each customer gets an account of their own on
  first sign-in, with no paid plan, and cannot run coworkers until they have one. Nothing is shared
  between accounts.

## The quota (D4)

What counts is **how many different coworkers are working at the same moment**. Installed, idle, and
waiting-for-a-schedule coworkers never count. A second conversation with a coworker that is already
working takes no further place.

- A run takes a place in `run_slots` when it starts and gives it back when it ends or is stopped.
- A place is a lease (two minutes) renewed every 30 seconds while the run works, so a crashed process
  cannot hold one: it simply stops counting. A renewal never refuses, so lowering a plan does not
  throw out a coworker that is already working.
- It is counted in the database under a per-account lock, so two runs starting together cannot both
  take the last place, and it is correct across several server processes.
- It is enforced by `RunGateAgent`, wrapped around every coworker on **both** construction paths
  (a person's chat, and routines and hand-offs). A run at three in the morning is held to the same
  limit as a person typing.

**At the limit, a run waits** (decision: queue, and offer an upgrade). The conversation says, in
the coworker's voice, how many are working and what the plan allows, links the next plan up with its
price, and starts as soon as a place frees. It also sends an `ark.queued` event for a richer display
later. After ten minutes it ends cleanly and says so. Stopping a waiting run takes nothing.

**An account that may not run at all** is refused with the reason in words: no plan chosen, ended
subscription, or suspended (with the staff member's reason). A card that failed once (`past_due`)
still runs.

Fails closed: if the plan cannot be checked, the run is refused with a sentence, not allowed.

## Isolation

`accounts/visibility.ts` is the one rule for who can see which coworkers, used by the roster, the
profile store and the runtime. A person sees: their own; the platform's own that are public; and a
public coworker belonging to an account they are a member of. So **"public" on a customer's coworker
means public to that customer's account, never to the deployment**, and a coworker a person cannot
see is also one they cannot run, change, duplicate, hide, delete or issue a callback token for. A
coworker with an owner but no account is its owner's alone (a missing collaborator fails closed).
Staff (the `admin` role) see everything.

Every signed-in person is given an account on the way in, once per process.

Already scoped by person and unchanged: conversations and channels (membership), model connections,
per-person connected accounts, routines, voice sessions. The admin screens are for staff.

**Skill names are per owner** (built 2026-10-09). Two customers can each have a `/standup`; neither is
told the other does, and neither can reach the other's. A skill is identified by an id, not its name:
grants, declared tools and edits refer to the id, and a request that gives only a name means the
person's own skill, then the deployment's. The rules:

- A person may not take a name the deployment's own skills answer to (every signed-in person can see
  those, so the refusal reveals nothing). They are told the name is provided by the deployment.
- An administrator may write a deployment skill under a name a person already uses; no customer can
  stop that. The two cannot be on the same Bot (the grant is refused with the reason), because a Bot's
  `/` menu is the one place a name has to mean one thing.
- Another person's skill is answered as "no such skill", the same as an id nobody has, whether the
  request reads, grants, edits or removes it. Staff (`admin`) still see and edit every skill, by id.
- Skills written before this keep their name as their id, so every grant made earlier still holds.
  New skills get an opaque id (`sk_…`). The package's skills keep their name as their id when nothing
  holds it, so the same package seeds the same ids everywhere.
- The database holds it too: one owner cannot have a name twice, and nor can the deployment (two
  partial unique indexes), so two saves of one new name at once make one skill.

## Billing

Everything is behind one interface (`BillingProvider`), so choosing a payment provider is writing one
adapter. Shipped: **manual** (no online payment; staff set plans; the app says to contact us) and
**sandbox** (real signature checks, no money; refuses production and a missing secret), and **paddle**
(the real one, see 12-paddle.md), and **stripe** (an alternative for a deployment that sells through
Stripe, test mode only for now, see 26-stripe.md). Set with `ARK_BILLING_PROVIDER`.

The webhook (`POST /api/billing/webhook/:provider`) believes nothing unsigned (signature over the raw
bytes, constant-time), does nothing on a repeat or out-of-order delivery (the provider's event id is
recorded first), records and ignores what it cannot act on instead of being retried forever, and
leaves a failed application unrecorded so the provider's retry works.

### Choosing the provider (open question 2, needs the owner)

Recommendation: **a merchant of record such as Paddle**. It sells to the customer in its own name,
collects and files EU VAT and other sales taxes, and issues the invoices, which is what a small team
selling EUR 50 to 250 a month across many countries would otherwise have to register for and file
country by country. The alternative is Stripe with Stripe Tax: better developer tooling and lower
cost at scale, but you stay the seller of record and must register for and file VAT yourself. Check
both providers' current terms and fees before choosing. Mobile apps are separate: Apple and Google
have their own rules for selling subscriptions inside an app (open question 3).

## What staff and customers can do

- Customer: Settings > Plan shows the plan, renewal, how many are working of how many allowed, the
  plans with prices, choose (goes to pay), manage billing, cancel at period end.
- Staff: Admin > Accounts lists every account with owner, plan, status and usage; set a plan by hand;
  suspend with a reason the customer is shown; restore. Each is on the audit trail.
- Someone with no plan is taken to the plan page before the chat. A lapsed or suspended account is
  told why where it lands. Staff are never gated.

## Verified

- Database tests for provisioning (racing requests make one account), entitlements, the slot counting
  and expiry, the gate's queueing, timeout, stop and heartbeat, isolation between customers and
  inside one, the webhook (signature, tampering, repeats, unknown plan or account, retry after
  failure) and the account and staff APIs.
- In a real browser against the real stack: a one-coworker plan, two coworkers and a model that takes
  seven seconds. The second coworker waited, said so with the upgrade link, and answered when the
  first finished. And: no plan, choose Ark Team, pay (sandbox), back on the plan page on Ark Team
  with 0 of 15 working.

## Not done yet

- The Paddle adapter is written and tested against a fake; it has not met Paddle yet (the sandbox run in
  12-paddle.md comes first). Invoices and VAT are Paddle's.
- Queue order is "whoever polls first", not first come first served, and the queue is not durable
  across a server restart (a queued run is a live request). Fine at this scale; revisit with load.
- The cloud add-on (Phase 4) is built (17-cloud-runtime.md); what is left is measuring cost, setting
  the prices, and running it against a real Paddle and cluster.
- "Hired" versus "installed": settled in Phase 5 without a separate step. Installing a coworker from
  the marketplace costs nothing against the limit (it is just a coworker in the account); a coworker
  counts only while it has a run in progress, which is what "hired" was meant to say (D4).
- Shared seats (the model allows them; nothing sells or manages them).
- Mobile subscription rules.
