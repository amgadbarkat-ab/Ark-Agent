# Running in Ark's cloud: where a coworker runs, and what it costs

Written 2026-10-08. This is Phase 4 of the build plan and decision **D5**: a digital employee runs
either on the person's own computer (included, costs Ark nothing) or in Ark's cloud (an optional
add-on, **priced so the charge covers 100% of what it costs Ark**: compute, storage, network, the
payment fee and tax handling).

**Status: built and tested; not yet run against real infrastructure or a real Paddle.** Section 9
lists, plainly, what has not been checked. **No price has been set, because no cost has been
measured.** Section 5 is the procedure for doing that; until staff have done it, nothing can be
switched on or charged.

## 1. What a customer sees

- **Settings → Plan → Cloud running** (only on a hosted service where it is an add-on). The prices in
  plain words, the month so far against their limit, the months already charged, and one dialog to
  switch it on, change the limit or switch it off.
- **Switching it on is an agreement to numbers.** The dialog lists the exact prices, asks for the most
  they will spend in a month (default €20, between €1 and €10,000), and needs a tick on "I have read
  these prices and agree to be charged them". The prices on the screen are sent with the request; if
  staff changed them in between, the request is refused, the new prices are shown, and the tick has to
  be given again. What was agreed to, and when, is stored with the account.
- **If staff change the prices later, the customer is asked again.** Cloud running stays "on", but new
  runs are declined with a message and a link until the customer agrees to the new prices (the Plan
  section says "The prices changed. Cloud runs are paused until you agree to the new ones."). What
  they used before that is still priced at what they agreed to for it. A customer is never charged a
  price they were not shown and did not accept.
- **Each coworker has "Where it runs"** (coworker dialog → General): *Ark's cloud* or *My computer*. It
  appears only on a hosted service and only while cloud running is not switched off. A coworker set to
  *My computer* is **never run in the cloud behind the person's back**: a run that arrives for it is
  declined with a message in the conversation that says why and links to Plan.
- **Refusals are in the conversation, with a link**, never a silent failure: cloud running not
  switched on, the monthly limit reached, set to run on their own computer, not yet priced, or switched
  off. Each is also recorded as an `ark.cloud_refused` event.

## 2. What a deployment chooses: `ARK_CLOUD_MODE`

| Mode | Meaning | Who it is for |
| --- | --- | --- |
| `included` (default) | Nothing is asked, nothing is charged, every coworker runs as it always has. Usage is still **recorded**. | A company's own deployment. Also the right mode while cost is being measured. |
| `metered` | An add-on. Customers switch it on, see the prices, set a limit, and are charged monthly. | The hosted service, once rates are set. |
| `off` | Nobody runs in the cloud. | A deployment that must not. |

Because the default changes nothing, merging this phase cannot change the behaviour of a deployment
that does not opt in. Other settings: `ARK_CLOUD_VOLUME_GB` (storage each coworker's computer holds;
0 means storage is not metered) and `ARK_CLOUD_DEFAULT_CAP_EUR` (the limit offered, default 20). In
the chart these are `cloud.mode`, `cloud.volumeGb` and `cloud.defaultCapEur`.

## 3. What is measured

Everything is an **interval**: a start, the last time anything saw it alive, and an end that may be
missing (`server/src/db/schema/cloud.ts`, `server/src/cloud/meter.ts`).

| Interval | Opened and closed by |
| --- | --- |
| A **run** | The run gate (`accounts/run-gate.ts`): opened when a run starts, refreshed while it works, closed when it finishes or fails. |
| A coworker's **computer being up** | The computer provider wrapper (`cloud/provider.ts`), and the reconcile pass of the sweep that suspends idle computers. |
| A coworker's **storage existing** | The reconcile pass, for every coworker that has a computer, up or suspended (a suspended computer still holds its disks). |

How an hour is counted:

- **Compute is the union of a coworker's runs and its computer being up**, merged per coworker, so an
  hour in which a run happened on a computer that was up is **one** hour, not two.
- **A crash is a short charge, not an endless one.** An interval that was never closed is worth only
  up to the last time anything saw it. The reconcile pass closes the ones nobody has seen for 15
  minutes at the moment they were last seen.
- **Months are calendar months in UTC**, and an interval that straddles midnight is clipped to each
  month it touches.
- **Only what happened after the customer agreed is chargeable** (and counts toward their limit). Usage
  before the date they switched it on is recorded and never billed.
- **Each stretch is priced at the prices agreed for it.** Agreeing again to the *same* prices keeps the
  first date and changes nothing. Agreeing to *different* prices closes the old agreement at that
  moment, keeps it (`cloud_accounts.agreement_history`), and starts a new one. A month in which that
  happened is two parts, each at its own rates, with one payment fee on the total (the newest
  agreement's), and the parts are stored on the charge so it can be explained line by line.
  The prices staff have set *today* are what a person is offered, never what they owe.
- **Network is not measured.** `egressBytes` is always zero today. Set the egress rate to zero (the
  screen says so); when egress is metered it will be added to the same formula.

A shared deployment with **one browser for everybody** (`computers.mode: shared`) has no computer or
disk per coworker. There the record is the runs, plus the moments a coworker used the shared browser
(each use refreshes it, so it is bounded by the last use), and no storage. The reconcile pass belongs to
the sweep that suspends idle computers, which exists only with a computer each
(`computers.mode: sandbox`), and that needs the agent-sandbox controller on the cluster
(docs/ark/13-azure-hosting.md). Measure cost in the mode you will sell.

## 4. What is charged

`shared/cloud-pricing.ts` is the only place the arithmetic lives; the server charges with it and the
app shows people the same numbers.

```
cost    = hours × computeCentsPerHour
        + GB-months × storageCentsPerGbMonth            (a month is 730 hours)
        + GB sent out × egressCentsPerGb                (always 0 until egress is measured)
charge  = ceil( (cost × (1 + margin%) + fixed fee) / (1 − fee%) )     whole cents, before tax
```

The division is the point. If the payment service keeps 5% of every charge, charging
`cost + 5%` leaves Ark short; charging `cost / (1 − 0.05)` leaves Ark whole. The fixed fee is added
once per charge, an empty month is not charged at all (no usage means no fixed fee), and a month whose
charge is under the minimum is **carried into the next month** (its cost rides along and one fee is
paid) rather than sent as an amount too small to be worth a payment.

**Margin is a setting that starts at zero.** Whether Ark adds anything on top of cost is a business
decision, not an engineering one (D5).

**Tax.** Paddle is the merchant of record and handles tax. The charge is sent with
`tax_mode: external`, meaning the amount is what Ark must receive and tax is added on top for the
customer; left to the account's own setting it might be "tax included", and the tax would come out of an
amount that was worked out to cover cost.

Worked example, with made-up numbers (these are **not** prices): 10 hours at 60 cents is 600 cents of
cost; with a 5% fee and 50 cents fixed, the charge is `ceil((600 + 50) / 0.95)` = 685 cents, €6.85,
of which the payment service keeps 34 cents + 50 = 84 cents and Ark receives 601, the cost.

## 5. Setting the prices from measured cost

**Do this before `metered` is switched on.** The recipe:

1. **Record usage.** Leave `ARK_CLOUD_MODE=included` (the default). Run real coworkers, on the real
   cluster, for at least a representative week. Hours are recorded per account and visible in
   **Admin → Cloud costs → Usage**.
2. **Read what it cost.** In Azure Cost Management, for the same days, take what the bot-computer node
   pool cost (virtual machines, plus the managed disks and any public IP or egress it generated). Use a
   dedicated node pool for coworker computers, so this is one line and not an estimate of a share.
3. **Divide.** `computeCentsPerHour` = (node pool cost for the period, in cents) ÷ (total hours in the
   Usage screen). That includes the cost of nodes sitting idle between runs, which is correct: it is
   part of what Ark pays to be able to run a coworker when asked. If utilisation is low the rate will
   look high. That is the real number, and the lever to lower it is packing more computers per node
   (the culler suspends idle ones), not hiding it.
4. **Storage.** `storageCentsPerGbMonth` = the managed disk's price per GB-month in the region. Set
   `ARK_CLOUD_VOLUME_GB` to the size each computer's disk is.
5. **Payment fee.** `paymentFeePercent` and `paymentFeeFixedCents` are **Paddle's published fee at the
   time you set them**; read their pricing page. The figures in this repository's tests are examples,
   not Paddle's price.
6. **Smallest charge.** Check Paddle's minimum for a transaction before choosing
   `minimumChargeCents`; below it, a charge would be refused.
7. **Margin.** Leave at zero until the business decides otherwise.
8. **Set them** in **Admin → Cloud costs → Prices**. Limits catch a decimal point in the wrong place
   (an hour of cloud for a hundred euro is a typo, not a price). Every change writes the old and new
   rates to the audit trail (`cloud.rates_set`).

Re-measure when the node size, region or utilisation changes. A change of prices applies to **new
agreements**: every customer who has it on is asked to agree to the new prices before another cloud run
starts (section 1), and what they used under the old ones is charged at the old ones. So raising a
price costs a little friction, by design, and cannot cause a charge nobody agreed to. A customer who
never comes back simply has cloud runs paused.

## 6. Turning it on

1. Run `server/scripts/paddle-setup.ts` (docs/ark/12-paddle.md). It also creates the **"Ark cloud
   running"** product (no price: each month's amount is sent with the charge) and prints
   `PADDLE_PRODUCT_CLOUD=pro_…`.
2. Put `PADDLE_PRODUCT_CLOUD` in `config.extraEnv` (a commented example is in
   `infra/azure/values-azure.yaml`).
3. Set the prices (section 5).
4. In the Helm values: `cloud.mode: metered` and `cloud.charging.enabled: true`. The chart refuses
   `charging.enabled` unless the mode is `metered`, and refuses an unknown mode.
5. **Run the Paddle sandbox check, including the cloud step** (docs/ark/12-paddle.md, step 10), before
   any live key is used.

## 7. How a month is charged, and why it cannot be charged twice

`server/scripts/charge-cloud-usage.ts`, run by the `cloud-charge` CronJob at 03:30 UTC on the second of
the month (`cloud.charging.schedule`), looks back over the last three months that have ended. A month
is worked out from the record and the rates **written down with it**, so what was charged can always be
explained.

The row for (account, month) is **written before the payment service is asked**, and is unique:

| Status | Meaning | What happens next |
| --- | --- | --- |
| *(no row)* | Not tried | Tried at the next run |
| `charging` | Written, then the request was sent | **Never sent again by a machine.** If the process died here, a person looks. |
| `charged` | The provider took it | Final |
| `carried` | Under the minimum | Added to the next month that is charged |
| `pending` | The provider **definitely** said no (a refused card, a 4xx) | Tried again at the next run |
| `uncertain` | The request went out and the answer was lost (timeout, 5xx, dropped connection) | **Never sent again by a machine.** A person looks. |
| `waived` | Staff decided not to charge it | Final |

An unanswered request may have taken the money, and asking again would take it twice; that is the one
failure this design exists to prevent, so every ambiguity is resolved toward *not* charging again.
**Admin → Cloud costs → Needs a decision** lists the `pending`, `charging` and `uncertain` months. For
the last two, open the payment service's own record, then choose **It was charged** (with where you saw
it) or **Waive** (with why). Both are final, need a note, and are written to the audit trail
(`cloud.charge_settled`). The CronJob exits non-zero when a month became `uncertain`, so the failed Job
is the alert.

Customers see a month in `charging` or `uncertain` as "Being confirmed with the payment service", never
the provider's reference or our notes.

## 8. Data

Three tables, all deleted with the account (`ON DELETE CASCADE` from the tenant): `cloud_accounts` (the
agreement: on or off, the limit, when and to which prices), `cloud_charges` (the ledger) and
`cloud_intervals` (the time record). `cloud_rates` is staff's one row of prices. The customer's data
export includes their agreement, the months charged and the intervals (never the payment service's
reference or our notes); see docs/ark/14-data-protection.md. Paddle keeps its own invoice and tax
records as the seller.

## 9. Verified, and not

**Verified**

- The arithmetic, including rounding, the fee gross-up, the minimum and the carry
  (`shared/cloud-pricing.test.ts`).
- Metering against a real database: merging, clipping to months, crash bounds, concurrent writers, the
  one-open-interval rule (`cloud-intervals`, `cloud-meter` tests).
- The gate through the real run gate: every refusal and its message, the limit, the agreement date,
  `included` behaving exactly as before, and a change of prices pausing new runs until the new ones are
  agreed to while the old usage stays at the old prices (`cloud-gate`, `cloud-provider` tests).
- Charging against a provider that can be told to refuse, lose its answer or be slow: once per month
  under concurrency and repeats, the carry, `pending` retried, `uncertain` and a crash-left `charging`
  row never resent, manual settlement final, a month across a change of prices priced in parts, a
  customer who never agreed to new prices charged the old ones (`cloud-charging` test, 16 cases).
- The Paddle request as built (`paddle.test.ts`): path, body, amount rules, 4xx versus 5xx versus a
  dropped connection.
- Routes against a real database, including one customer never reaching another's account or bill, and
  only staff setting prices or settling (`cloud-routes` test, and the **security suite**: the routes are
  in the unauthenticated sweep, the admin sweep, and have their own isolation checks).
- The screens against a fake server (`cloud-screens`, `agent-dialog-run-location` tests).
- The chart renders with the new values, refuses the bad combinations, and renders the same without the
  new keys (the shape of an upgrade that reuses values).

**Not verified, and what to do about it**

- **Paddle's charge endpoint.** The request (`POST /subscriptions/{id}/charge`, with a price made on the
  fly under a product, `effective_from: immediately`, `on_payment_failure: prevent_change`,
  `tax_mode: external`) follows Paddle's documentation as read on 2026-10-08. It has never met Paddle.
  Whether Paddle accepts a non-catalogue price here, and how it treats the minimum amount and the tax
  mode, is what the sandbox step is for. **Until then a 4xx from Paddle is treated as "refused, try
  again" and an unexpected 2xx body as success.**
- **The per-coworker computer on AKS.** `computers.mode: sandbox` needs the agent-sandbox controller and
  has not been run on the Azure cluster. Neither has the reconcile pass against it.
- **A real month.** The rates cannot be set until cost has been measured, and it has not.
- **Network egress is not metered** (always zero), so a coworker that moves a great deal of data costs
  Ark something it does not charge for. Revisit when there is data on how much that is.
- **Several API replicas** writing the record at once are covered by the database rule and a test, but
  not by a multi-replica run.
- **Clock skew** between replicas shifts an interval by the skew; it is not corrected.

**Not built**

- Reporting usage to Paddle as it happens (usage-based billing). The monthly one-time charge was chosen
  because it needs no catalogue price per rate and can be explained to the customer line by line.
- Refunds or credits for cloud running. A mistaken charge is refunded in Paddle and recorded as `waived`.
- Egress metering, and per-coworker cost shown to the customer (they see the account's month; staff see
  it per account).
- Moving a running coworker between the cloud and a device mid-run: the setting applies to the next run.

## 10. Where the code is

| Concern | File |
| --- | --- |
| Arithmetic and rate limits | `shared/cloud-pricing.ts` |
| Tables | `server/src/db/schema/cloud.ts`, migrations `0053`, `0054`, `0055` |
| Intervals, months | `server/src/cloud/intervals.ts` |
| Recording and totals | `server/src/cloud/meter.ts`, `server/src/cloud/provider.ts` |
| Rates and agreements | `server/src/cloud/store.ts` |
| What an account owes for a month, by agreement | `server/src/cloud/billable.ts` |
| The gate | `server/src/cloud/gate.ts`, `server/src/accounts/run-gate.ts` |
| Charging | `server/src/cloud/charging.ts`, `server/scripts/charge-cloud-usage.ts` |
| Paddle | `server/src/billing/paddle.ts` (`charge`), `server/src/billing/paddle-setup.ts` |
| Routes | `server/src/cloud/routes.ts` (`/api/account/cloud`, `/api/admin/cloud`) |
| Screens | `app/src/components/settings/cloud-running.tsx`, `app/src/routes/_authed/admin/cloud.tsx`, the coworker dialog |
| Chart | `charts/openbot/templates/cloud/charge-cronjob.yaml`, `cloud:` in `values.yaml` |
