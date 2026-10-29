# Stripe: the other way customers can pay

Written 2026-10-28 (desk #20). Paddle stays Ark's payment provider (12-paddle.md, decision
2026-10-08). This adds Stripe beside it, for a deployment that already sells through Stripe and
handles its own tax, and says what is built, how to set it up, what is proven and what is not.

**Test mode only.** The server refuses to start with a live Stripe key. Taking real money through
Stripe is a decision for after the live run at the end of this page, not a key pasted into the wrong
box.

## When to choose it

Choose Paddle unless there is a reason not to: Paddle is the merchant of record and files the VAT.
With Stripe, the deployment's owner is the seller, so tax registration, Stripe Tax (or not) and
invoices are theirs. Nothing changes for a deployment that does not set `ARK_BILLING_PROVIDER=stripe`.

## Settings

All in `.env.example`, commented.

| Variable | Meaning |
| --- | --- |
| `ARK_BILLING_MODE=subscriptions` | Plans are sold at all (09-accounts-plans-quotas.md). |
| `ARK_BILLING_PROVIDER=stripe` | Use Stripe. The default (`manual`) is unchanged. |
| `STRIPE_SECRET_KEY` | `sk_test_...`, or a restricted `rk_test_...` key. Secret. A live key is refused at start-up. |
| `STRIPE_WEBHOOK_SECRET` | The webhook endpoint's signing secret, `whsec_...`. Secret. |
| `STRIPE_PRICE_AGENT`, `STRIPE_PRICE_TEAM`, `STRIPE_PRICE_ENTERPRISE` | The Stripe price (`price_...`) for each plan. A plan without one cannot be bought online. |
| `STRIPE_WEBHOOK_TOLERANCE_SECONDS` | How far a notification's timestamp may be from now. Default 300. |

The server refuses to start if a setting is missing or of the wrong kind (a publishable key, a secret
that is not `whsec_`, a price that is not `price_`, two plans on one price) and says which.

A restricted key needs: Checkout Sessions write, Subscriptions write, Customer portal write. Nothing
else.

## Setting up a Stripe test account

1. **Products and prices.** `STRIPE_SECRET_KEY=sk_test_... APP_URL=https://<your address> bun
   server/scripts/stripe-setup.ts` makes one product (`ark_plans`) and one monthly EUR price per plan
   from `shared/plans.ts`, and prints the three `STRIPE_PRICE_*` settings. It is safe to run again (it
   finds what it made by lookup key), it never changes a price, and it reports one whose amount differs
   from the plan table as drift. `--try-checkout` also opens one test checkout session, the same
   request the server makes, and prints its address.
2. **Webhook endpoint**, in the dashboard (Developers, Webhooks, test mode): address
   `https://<your address>/api/billing/webhook/stripe`, events `checkout.session.completed`,
   `checkout.session.async_payment_succeeded` and `customer.subscription.created`, `.updated`,
   `.deleted`, `.paused`, `.resumed`. Its signing secret goes in `STRIPE_WEBHOOK_SECRET`, in the
   secret store, never in the repository. For a server on a laptop, `stripe listen --forward-to
   localhost:3010/api/billing/webhook/stripe` prints a `whsec_` to use instead.
3. **Customer portal.** Save its settings once (Settings, Billing, Customer portal), allowing card
   updates, invoices and cancellation. Until it is saved, Stripe refuses to open it and Manage billing
   says so.

## How it works

1. A customer chooses a plan. The server makes a **Checkout Session** in subscription mode for that
   plan's price, with the account id as `client_reference_id` and in the subscription's `metadata`,
   and sends the customer to Stripe's hosted page. The address that comes back must be on
   `checkout.stripe.com` or the purchase is refused. Paying sends the customer back to
   `/settings/plan?paid=1`, where the page waits for confirmation exactly as it does for Paddle.
2. **Paying changes nothing until Stripe tells the server.** A signed `checkout.session.completed`
   (and `customer.subscription.created`) arrives; the server verifies it, finds the account, and only
   then activates the plan.
3. **Renewals, failed payments and cancellations** arrive as `customer.subscription.updated` and
   `.deleted` and move the period end, the status (`past_due` keeps running; `unpaid`, `paused`,
   `incomplete_expired` and `canceled` stop it) and the scheduled end.
4. A customer who **already has a subscription** and chooses another plan has its one item moved to
   the new price, never a second subscription. An upgrade is invoiced at once, prorated, and left
   pending if the card is refused (`payment_behavior=pending_if_incomplete`); a downgrade is a
   prorated credit on the next invoice.
5. **Cancel** sets `cancel_at_period_end`. **Manage billing** opens Stripe's customer portal and
   returns to the plan page.

Everything past the adapter (the webhook handler, the account store, the plan page) is the same code
Paddle uses; `server/src/billing/stripe.ts` is the whole difference.

## What the code keeps to

- **Nothing unsigned is believed.** `Stripe-Signature` is `t=<unix>,v1=<hex>`, the HMAC-SHA256 of
  `<t>.<raw body>` under the signing secret, compared in constant time over the exact bytes. Several
  `v1` values are accepted (a secret being rolled); `v0` never is. A timestamp more than five minutes
  from now is refused.
- **Once is enough.** The event id is recorded before anything is applied; a repeat does nothing.
- **Out of order is safe, by asking.** Stripe's timestamps are whole seconds and its deliveries come
  in any order, so a `created` that says `incomplete` and an `updated` that says `active` from the
  same second cannot be ordered from the events. So a notice is taken as "something changed": the
  server asks Stripe for the subscription as it is now and applies that, stamped with the moment it
  asked. The newest answer wins, and an old notice arriving late can only repeat the present.
- **A notice that cannot be checked is retried.** If Stripe cannot be asked, the delivery is answered
  with an error and not recorded, so Stripe sends it again (for up to three days).
- **A replaced subscription cannot end its replacement.** A customer who cancels and buys again has
  two subscriptions; a late notice that the first one ended is ignored once the account holds the
  second (`server/src/billing/webhook.ts`, for every provider).
- **No double billing.** A plan change replaces the subscription's own item; a subscription without
  an item of ours is not touched. An id stored by another provider is never sent to Stripe.
- **Ids are checked** against Stripe's patterns before they go into a request path.
- **Nothing Stripe says reaches the customer**; the detail is kept on the error for the operator.
- A test-mode event at a live deployment (or the reverse) is ignored.
- Every request names the API version (`2025-03-31.basil`), so a change to the account's default
  version in the dashboard does not change what the server reads. The reader also copes with the
  period end in either place Stripe has kept it.

## Verified, and not

- **Verified:** the adapter, the notices and the routes against a **fake Stripe that follows the
  published API** (36 unit and 16 integration tests in `server/tests/stripe*.test.ts`, the
  integration ones on a real database through the real routes and webhook handler): notices signed
  with a test signing secret the way Stripe signs them, tampering, a wrong secret, `v0`, timestamps out
  of tolerance, secret rolling, repeats, a late notice, Stripe unreachable during a notice and the
  retry that follows, a late notice about a replaced subscription, plan changes in place, cancel, the portal, foreign ids.
- **Not verified: Stripe itself.** No Stripe test key was available in the session that wrote this,
  so no real checkout session, notice or portal has been made against Stripe. The request shapes come
  from Stripe's API reference. **Do the test-mode run below first.**

## The test-mode run (about half an hour)

1. Set up the test account as above; start the server with the settings; it must start quietly.
2. Sign up as a new customer, choose Ark Team, pay on Stripe's page with `4242 4242 4242 4242`.
3. Back on the plan page: "confirming your payment", then Ark Team. In the dashboard the webhook
   deliveries show 200. A 400 means the signing secret is wrong.
4. Choose Ark Team Enterprise: one subscription in Stripe, its item moved, a prorated invoice paid.
5. Choose ArkAgent (a downgrade): a proration credit waits on the next invoice.
6. Cancel: the page says when it ends; Stripe shows "cancels on ...".
7. Manage billing opens the portal; "keep subscription" there is reflected on the plan page.
8. Resend an old event from the dashboard: the account does not change.
9. Use the declining card `4000 0000 0000 0341` and advance a test clock past the renewal: the account
   shows "payment did not go through" and keeps running.

Anything that differs is a bug in `server/src/billing/stripe.ts`, to be fixed with a test that
reproduces the real event.

## Not done yet

- **Live mode.** Refused at start-up (`server/src/billing/select.ts`) until the run above has passed
  and somebody decides to take money through Stripe.
- **Charging for cloud running** (`charge`, 17-cloud-runtime.md) is Paddle's only. On Stripe a month is
  left pending with "There is no subscription at the payment service to charge it to."
- A returning customer gets a new Stripe customer at checkout rather than their old one.
- Tax: nothing is set (no `automatic_tax`); that is the seller's decision in their Stripe account.
- A custom checkout domain would need adding to the allowed checkout address in `stripe.ts`.
