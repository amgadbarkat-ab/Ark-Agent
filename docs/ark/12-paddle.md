# Paddle: how customers pay

Written 2026-10-08. Paddle Billing is the payment provider (decision 2026-10-08, open question 2 in
01-product-decisions.md). This says why, what the owner sets up in Paddle, how it works in the code,
what is proven and, plainly, what is not.

## Why Paddle

Paddle is the **merchant of record**: it sells to our customers in its own name, collects and pays the
VAT and sales tax in each country, sends the invoices and handles chargebacks. A processor such as
Stripe would leave us to register for tax in every country we sell in. For a small team selling EUR
50, 100 and 250 plans across borders, that is the deciding difference. The price is a larger cut per
sale than a processor takes, which the owner has accepted by choosing it.

## What the owner sets up in Paddle

Do it in Paddle's **sandbox** first (a separate account at sandbox-vendors.paddle.com), run the checks
at the end of this page, and only then repeat it in the live account.

1. **Products and prices.** One product, three recurring monthly prices in EUR: Ark Agent 50, Ark Team
   100, Ark Team Enterprise 250. Choose whether the displayed price includes tax; Paddle then adds or
   includes VAT per country. Each price has an id like `pri_01...`. The code never writes an amount: the
   prices live in Paddle, and the plan screen's wording comes from `shared/plans.ts`, so the two must be
   kept equal by hand.
2. **An API key** with these permissions only: `transaction.write`, `subscription.write`,
   `customer_portal_session.write`. It starts `pdl_sdbx_apikey_` (sandbox) or `pdl_live_apikey_`.
3. **A client-side token** (Authentication page). It starts `test_` or `live_`. It is public: it goes
   to the browser on the checkout page.
4. **A notification destination** pointing at `https://<your address>/api/billing/webhook/paddle`,
   subscribed to the `subscription.*` events (`created`, `activated`, `updated`, `past_due`,
   `canceled`, `paused`, `resumed`, `trialing`, `imported`). Copy its secret (`pdl_ntfset_...`).
5. **Checkout settings.** Set the default payment link to `https://<your address>/api/billing/checkout`
   and get the domain approved. This is the page that opens Paddle's checkout.
6. **Settings on our side** (`.env.example` has them all, commented): `ARK_BILLING_MODE=subscriptions`,
   `ARK_BILLING_PROVIDER=paddle`, `APP_URL`, `PADDLE_ENVIRONMENT`, `PADDLE_API_KEY`,
   `PADDLE_WEBHOOK_SECRET`, `PADDLE_CLIENT_TOKEN` and the three `PADDLE_PRICE_*`. Keep the three secrets
   in the secret store (Azure Key Vault on the planned hosting), never in the repository.

The server **refuses to start** if any of this is missing or inconsistent, and says which: a sandbox
key with `PADDLE_ENVIRONMENT=production`, a live token with a sandbox key, a price that is not a
`pri_` id, an address that is not https.

## How it works

1. A customer chooses a plan. The server creates a **transaction** in Paddle for that plan's price,
   with the customer's account id in `custom_data`, and sends the customer to our own checkout page
   (`/api/billing/checkout?_ptxn=txn_...`).
2. That page loads Paddle.js from Paddle's own address and opens the checkout for the transaction.
   Paying sends the customer back to `/settings/plan?paid=1`, where the page says the payment is being
   confirmed and asks again every two seconds. Closing the checkout sends them back to the plan page.
3. **Paying changes nothing until Paddle tells the server.** Paddle posts a signed `subscription.created`
   notice; the server verifies it, finds the account from `custom_data`, and only then activates the plan.
4. Someone who **already has a subscription** and chooses another plan has the existing subscription
   moved (one call to Paddle), never a second one sold: an upgrade is charged at once, prorated; a
   downgrade is settled at the next renewal. The account shows the new plan when Paddle confirms.
5. **Cancel** stops renewal at the end of the paid period. **Manage billing** opens Paddle's own
   customer page for cards and invoices.

## What the code keeps to

- **Nothing unsigned is believed.** `Paddle-Signature` is `ts=<unix>;h1=<hex>`, the HMAC-SHA256 of
  `<ts>:<raw body>` under the destination secret, compared in constant time. Several `h1` values are
  accepted, which is how Paddle rotates a secret. A timestamp more than five minutes from now is
  refused (adjustable); replays are also stopped by the event id.
- **Out of order is safe.** Paddle may deliver an old notice after a newer one. Every account records
  when the last change it heard about happened (to the microsecond) and ignores anything older, so a
  subscription that was cancelled and renewed is never left cancelled.
- **Once is enough.** A repeated notice is recorded and does nothing.
- **No double billing.** A subscribed customer's plan change goes to the existing subscription. An id
  stored by another provider (say, after switching from the sandbox) is never sent to Paddle.
- **The customer only ever goes to our page.** The checkout address Paddle returns must be on our own
  origin or the purchase is refused.
- **Nothing Paddle says reaches the customer.** A refusal becomes a sentence; the detail is kept on the
  error for the operator.
- Paddle ids are matched against a pattern before they go into a request path.
- A paused subscription may not run (it reads as ended).

## One thing to know about trust

Paddle's checkout is a script that must run on a page of ours. The script is loaded from Paddle's
address on a minimal page that holds only the public client token and the way back, and the session
cookie is not readable by script. It is still third-party code running on our origin, which is how
Paddle.js is meant to be used and the same trust any seller using it extends. Serving the page from a
separate address later would remove the question.

## Verified, and not

- **Verified:** the adapter, the notices and the routes against a **fake Paddle that follows the
  published documentation** (29 unit and 15 integration tests, including signature tampering, replay,
  rotation, out-of-order delivery to the microsecond, double-billing, foreign ids, hostile text on the
  page); the plan screen waiting for confirmation and changing plan in place; and a real server
  starting with the settings and serving the checkout page, rejecting a bad signature.
- **Not verified: Paddle itself.** No Paddle account was available when this was written, so no real
  transaction, notice or checkout has happened. The request shapes and notice fields come from
  Paddle's documentation as read on 2026-10-08 and may differ in a detail (for instance a field name
  on an event). **Do the sandbox run below before any live key is configured.**

## The sandbox run (about an hour)

**This is the last check before launch**, done by the owner after the rest of the deployment is in
place (docs/ark/13-azure-hosting.md). The catalogue in step 1 is made by `server/scripts/paddle-setup.ts`;
the rest of the setup above is by hand.

1. Configure the sandbox as above. Start the server; it must start without complaint.
2. Sign up as a new customer; choose Ark Team; the Paddle checkout opens over our page. Pay with
   Paddle's test card.
3. Back on the plan page: "confirming your payment", then Ark Team with 0 of 15 working. In Paddle's
   dashboard the notification shows as delivered (200). If it shows 400, the signature or the secret is
   wrong.
4. Choose Ark Team Enterprise. The plan moves and there is **one** subscription in Paddle, not two.
5. Choose Ark Agent (a downgrade); check it is billed at the next renewal.
6. Cancel; the page says when it ends; Paddle shows the scheduled cancellation.
7. Manage billing opens Paddle's customer page.
8. In Paddle, replay an old notification (Notifications > Replay); the account does not change.
9. Make a payment fail (Paddle's failing test card); the account shows "payment did not go through" and
   keeps running; fix the card and it returns to normal.

Anything that differs from this list is a bug in the adapter, to be fixed in `server/src/billing/paddle.ts`
with a test that reproduces the real notice.

## Not done yet

- Discount codes, trials, pausing, and removing a scheduled cancellation ("keep my plan") are not
  offered. The last needs one more call (`scheduled_change: null`) and a button.
- Chargebacks, refunds and invoices are Paddle's to handle, and are not shown inside Ark. A refund or a
  dispute does not change an account until Paddle sends a subscription notice that says so; staff can
  suspend an account by hand in the meantime.
- Prices exist in two places (Paddle, and `shared/plans.ts`). A check that compares them through
  Paddle's price API would stop them drifting apart.
- The cloud add-on (Phase 4) is a usage charge on top of the plan. How to bill it through Paddle
  (a one-off charge each period, or usage reporting) is decided when Phase 4 has cost data.
- Prefilling the customer's email in Paddle's checkout (it asks for it instead).
