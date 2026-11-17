# Customer trials (#109)

How BlackArk sets up, changes and ends a customer trial of the ArkAgent desktop app (v0.1.37 on).

## Once: the signing key

On the signing computer (Bun needed), from a checkout of this repository:

```
bun scripts/ark-trial.ts keygen
```

The private key goes to `~/.arktrial/ark-trial-private.pem`, readable by you only, and is never
printed. Keep it and one offline backup. Only the printed PUBLIC key is shared: it goes into
`shared/trial-public-key.ts`, and every build from then on trusts it. Running keygen again does not
replace an existing key.

## Per customer: the profile

1. Write the draft, as in `profile-draft-example.json`:
   - `customer.id`: lower-case letters, digits and hyphens. Unlock codes name this.
   - `startsAt` / `endsAt`: fixed instants, with the Athens offset.
   - `plan`: `team`.
   - `createBlocked`: `true`.
   - `addons`: paid add-ons the customer has paid for, for example `["phone"]` (answering the
     business's phone line). Leave it out until the customer has paid: without it the add-on is
     off on that install, its settings are hidden and nothing connects.
   - `checkInUrl`: `https://<BlackArk server>/api/trial-checkins`, or leave it out.
   - `roster`: per employee, `key`, `name`, `title`, `roleDescription` (600 characters at most),
     `instructions`, and optionally `basedOn` (an official role's slug, which brings its skills) and
     `lead: true`. Also optionally, per employee:
     - `mail`: `{ "folders": [...], "from": "..." }` gives it the business's mailbox (v0.1.38);
     - `priceList: true` gives it `find_price`, the business's uploaded price list (v0.1.40). Its
       instruction should say: prices only from `find_price`; if it says the prices are not loaded,
       say so and give none;
     - `video: true` gives it video editing on that computer (v0.1.40), for example a social-media
       content employee.
2. `bun scripts/ark-trial.ts sign-profile demo-shop.json` writes `demo-shop.arktrial`.
3. `bun scripts/ark-trial.ts show demo-shop.arktrial --public-key <public key>` prints what it says and
   whether the key signed it.
4. On the customer's computer: setup window → **Import trial profile**, or after setup
   **Settings → Plan → Trial → Import trial profile → Choose file**.

Official role slugs for `basedOn` (the tool refuses any other): `sales`, `front-desk`, `marketing`,
`accounting`, `support-agent` (Customer Support), `inventory-logistics`, `executive-assistant`
(Personal Secretary), `operations-coordinator` (Chief of Operations), `sales-engineer`,
`finance-assistant` (Finance), `programmer`, `chief-of-staff`, `designer`, `coding-engineer`,
`code-reviewer`, `research-analyst`, `writing-editor`, `legal-helper`. An employee with no `basedOn` is a custom one:
its standing instruction is all it has.

## Afterwards: unlock codes

```
bun scripts/ark-trial.ts sign-code --customer demo-shop --action extend --until 2027-01-15T23:59:59+02:00
bun scripts/ark-trial.ts sign-code --customer demo-shop --action end
bun scripts/ark-trial.ts sign-code --customer demo-shop --action paid
```

The customer pastes the printed `ARK1-…` line into **Settings → Plan → Trial → Unlock code**. Each
code works once, and only for its customer.

## Check-ins

BlackArk's own ArkAgent server, with `ARK_TRIAL_RECEIVER=true`, receives check-ins at
`/api/trial-checkins` and lists them in **Admin → Trials**. Each one carries the customer id, a
random install id, the version, the status, the days left, the end and the number of trial
employees. Nothing else is sent.

## Activation (from v0.1.42)

The desktop app opens only with one of three things:

- the trial setup file above;
- a **trial activation code**;
- a **paid licence key**.

Without one of them, the **Activate ArkAgent** screen is the only screen.

```
# A trial without a setup session: opens ArkAgent until that moment, on any computer.
bun scripts/ark-trial.ts sign-trial-code --customer demo-shop --until 2026-12-17T23:59:59+02:00 [--plan team] [--addons phone]

# Paid: valid until the period end plus 7 days' grace. --renew-url is where the app asks daily.
bun scripts/ark-trial.ts sign-license --customer demo-shop --period-end 2026-12-17 --seats 1 [--plan team] [--addons phone] [--renew-url https://…]

bun scripts/ark-trial.ts show ARK1-… --public-key <base64>
```

**Where to enter them:** the person types the printed `ARK1-…` line on the Activate screen, or later
in **Settings → Plan → Activation**. The same box also takes the unlock codes above.

**Which key signs what:**

- **Trial activation codes:** the trial key.
- **Licence keys:** the keys in `shared/license-public-key.ts`. Today that is the trial key. A
  separate licence key for the payment server is a later step:
  1. Make it with `keygen --dir ~/.arklicense`.
  2. Add its public half to that file.
  3. Remove the trial key from that file in a later release.

**What the server refuses:**

- a code or key that BlackArk did not sign;
- a code or key for another customer than the one the computer is set up for;
- a code or key whose end has already passed;
- a trial code on a computer that has a paid licence;
- a licence key that ends sooner than the one already entered.

**Typing a key twice:** entering the same licence key again changes nothing.

**Renewal:** the app POSTs `{customerId, installId, version, nonce, validUntil}` to the key's
`renewUrl` once a day. If the answer is `{"key": "ARK1-…"}` with a newer signed licence key for the
same customer, the app takes it. If the answer is `{}`, nothing changes.

## Shop and delivery connectors (from v0.1.43)

Every install has them, under **Settings → Connect your Data → Shop and delivery**. At the setup
session, type in the customer's own details:

| Connector | What to type | Where the customer gets it |
|---|---|---|
| Skroutz | API token | Skroutz merchant panel → Merchants → Services → Skroutz Marketplace. New orders: give the same employee the Mailbox too; it finds them in Skroutz's emails |
| WooCommerce | shop address, consumer key and secret | WordPress → WooCommerce → Settings → Advanced → REST API |
| BOX NOW | API address (API_URL), client id, client secret | BOX NOW, after partner registration; stage first |
| Business data files | upload each export under a short name (`stock`, `items`, `customers`) | Pylon's own export to Excel/CSV |

**Which employee gets which connector** goes in the setup file, per employee:

```json
"connectors": ["skroutz", "boxnow", "business-files"]
```

## ELTA Courier and competitor prices (from v0.1.44)

**ELTA Courier:** in **Settings → Connect your Data → Shop and delivery**, type in the customer code,
user code and password that ELTA Courier gives a contract customer for its web service. Leave the
service address empty unless ELTA gives another one.

**Competitor prices:**
1. **Upload the watch list** as a business data file named `price-watch`, for example:
   ```
   Προϊόν;SKU;Our price;Skroutz;BestPrice
   Λευκό κρασί 750ml;W-101;15,90 €;https://www.skroutz.gr/s/…;https://www.bestprice.gr/item/…
   ```
2. **Give the employee** the tools "Competitor prices", "Business data files" and, for price
   changes, WooCommerce. In the setup file: `"connectors": ["price-watch", "business-files", "woocommerce"]`.
3. **Add a Routine** for that employee, daily or hourly as the customer chooses, for example:
   «Κάθε πρωί: διάβασε τη λίστα παρακολούθησης, άνοιξε μία μία τις σελίδες, κατέγραψε τις τιμές
   και στείλε μου την αναφορά. Αν μια τιμή μας είναι ακριβότερη, πρότεινε νέα τιμή για έγκριση.»
   ("Every morning: read the watch list, open the pages one by one, record the prices and send me
   the report. If one of our prices is higher, propose a new price for approval.")

**The rules for the employee:**
- one page at a time;
- it stops at any CAPTCHA or block;
- every price change waits on an approval card.

**Skroutz's terms:** they forbid monitoring the site without written permission. BlackArk asks
Skroutz first (Amgad, 16 Nov).

## Pylon exports without uploading (from v0.1.45)

**Where:** on the desktop app, save Pylon's exports (CSV or XLSX) into `ArkAgent\data\in` in the user's
home folder. Settings → Connect your Data → Business data files shows the exact path.

**What happens:**
- Within a minute each file is loaded under its file name: `stock.xlsx` becomes `stock`, and
  `Pylon Items.csv` becomes `pylon-items`.
- A newer export with the same file name replaces the older one.
- A file whose name is only Greek letters is skipped. Name exports in Latin letters.

## Test cases and scoring an instruction change (#116)

Runs on Amgad's computer only, with BlackArk's free key.
- **Provider:** **OpenRouter**'s free tier by default (the key "ArkAgent-116", 17 Nov). **Groq** and **Cerebras** are alternatives.
- **Never used:** the local model, an Anthropic key or model, DeepSeek. `ark-eval` also refuses Anthropic and DeepSeek model names, which OpenRouter could otherwise route to.
- **What is sent:** only the made-up test questions and our own instruction text. OpenRouter's free models may be served by providers that keep prompts, so nothing else may go there.

**Getting the key onto Amgad's PC:**
- **Never** on GitHub, in a chat, in a script or on a trial PC.
- **Copying it:** COO copies it from the COO box into BlackArk's password manager, or hands it over in person. Amgad copies it from there.
- **Using it, Windows PowerShell:** the key lives only for that window, and is not stored or shown:

  ```
  $env:ARK_EVAL_API_KEY = Read-Host -MaskInput "OpenRouter key"
  bun scripts/ark-eval.ts run --profile customer.json --proposed change.json
  ```

- **The simplest way:** leave `ARK_EVAL_API_KEY` unset. `ark-eval` then asks for the key at a hidden prompt each time.
- **Don't use `setx`:** it would store the key permanently in the user's settings.

### The test cases, in the profile

Each roster employee may have `tests`: **5 to 8 cases**, or none. See `eval-cases-example.json` for
three general employees (front desk, results admin, B2B orders). Each case:

| Field | What it is |
|---|---|
| `id` | lower-case letters, numbers and hyphens; once per employee |
| `ask` | a made-up customer-style question, Greek first. Never copied from real mail or calls |
| `must` | 1 to 10 things a good answer does, e.g. "asks for the order number" |
| `mustNot` | up to 10 things it never does, e.g. "gives medical advice" |
| `rules` | optional plain-code checks, below |
| `toolAnswers` | optional: what a tool "answers" in this test, by tool name |

**Rules**, checked by code; one hit fails the case:
- `prices`: the only prices the answer may give, as the price list writes them (`["6,40 €"]`). Any other
  amount in euros fails. `[]` means no price at all.
- `noAmka`: no AMKA-shaped (11-digit) number. Always on when the profile has `mailBlockAmka`.
- `noAiWords`: it does not call itself an AI, a bot, a chatbot or a language model, in Greek or English.
- `toolsShould` / `toolsNever`: tools it should call, or must never call, for this question.

The rules also read what the employee wrote through a tool, such as a draft's text. **Tools never run in
a test.** Each call is recorded and answered with the case's `toolAnswers` text, or with a fixed "this
is a test" line. Tool notes for an employee live in its standing instruction; the profile has no
separate field for them.

`sign-profile` checks the cases like the rest of the profile and refuses a malformed one with a sentence
that names the employee and the case.

### Scoring a change

A proposed change is a small JSON file, as in `eval-change-example.json`:
`{"format": "arkchange/1", "customer": "<customer id>", "employee": "<key>", "instructions": "<the whole new text>"}`,
optionally with `summary` and `source` (`person` or `tune`).
The file an administrator makes on a trial PC with **Propose a change** (`{"v": 1, "employee": {"id": "<key>", "name": …}, "current": …, "proposed": …, "reason": …}`)
is read the same way: score it against the profile of the customer who sent it, and its reason becomes the summary.

```
export ARK_EVAL_API_KEY=…            # or leave it unset and type it at the hidden prompt
bun scripts/ark-eval.ts run --profile example-customer.json
bun scripts/ark-eval.ts run --profile example-customer.json --proposed change.json
bun scripts/ark-eval.ts run --profile example-customer.json --proposed change.json --reason "Why it goes on anyway"
```

- **Profile:** the draft JSON or the signed `.arktrial` file.
- **Key:** only from `ARK_EVAL_API_KEY` or the hidden prompt. It is refused on the command line, never
  printed and never written to a file.
- **Options:** `--provider openrouter|groq|cerebras` (OpenRouter by default), `--model <id>` (or `ARK_EVAL_MODEL`), `--judge-model <id>`,
  `--employee <key>`, `--report <file.md>`, `--out <draft.json>`. Model names change on the free tiers:
  check the provider's list if the default is refused.

**What it does:**
1. It runs every case for the employee, once with the current instruction and once with the proposed
   one.
2. A judge call on the same key decides, item by item, whether each answer does what it must and avoids
   what it must not. Then the rules are checked.
3. A case passes only if all of that holds. The score is the share of cases passed.

**The report** is Markdown, printed and written next to the profile. It shows the score before and
after, case by case, the text diff, and every answer.

**Blocked:** a change that scores lower, or adds a rule failure, is **blocked** (exit code 2), and no
draft is written. `--reason "<text>"` lets it through. The reason is printed in the report and recorded
in the new draft's `notes`.

**Not blocked:** a new **unsigned** draft profile is written next to the profile, with the new
instruction and a line in `notes`. It has no `issuedAt`, so signing stamps it now and the signed file
replaces the older one on import. A person reads the report, then BlackArk signs the draft with
`sign-profile` as today.

**One honest limit:** the scores come from the free-key model, not from the model on the customer's PC.
They say whether an instruction got better or worse, not exactly how the PC will answer. DT
spot-checks two or three cases on a trial PC after each signed change.

### Tuning (needs Amgad's yes for the proposer)

```
bun scripts/ark-eval.ts tune --profile example-customer.json --employee b2b-orders [--rounds 3] [--out-dir <folder>]
```

- **Proposing:** a proposer model on the same free key (`--proposer-model <id>`, default the same
  model) proposes a new standing instruction. Each proposal is scored like `run`.
- **What you see:** only a proposal that scores higher, with no new rule failure, is shown: the scores,
  the diff and the cases.
- **Your approval:** a proposal is written as a proposed-change file only after you answer `y`. It asks
  first whether Amgad has said yes, and runs only in a terminal.
- **What it never does:** edit or sign a profile. Score each written file with `run --proposed`, then
  sign as above.
