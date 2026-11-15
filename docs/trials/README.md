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
     - `video: true` gives it video editing on that computer (v0.1.40), for example Wine24's
       SM Media Creator.
2. `bun scripts/ark-trial.ts sign-profile wine24.json` writes `wine24.arktrial`.
3. `bun scripts/ark-trial.ts show wine24.arktrial --public-key <public key>` prints what it says and
   whether the key signed it.
4. On the customer's computer: setup window → **Import trial profile**, or after setup
   **Settings → Plan → Trial → Import trial profile → Choose file**.

Official role slugs for `basedOn` (the tool refuses any other): `sales`, `front-desk`, `marketing`,
`accounting`, `support-agent` (Customer Support), `inventory-logistics`, `executive-assistant`
(Personal Secretary), `operations-coordinator` (Chief of Operations), `sales-engineer`,
`finance-assistant` (Finance), `programmer`, `chief-of-staff`, `designer`, `coding-engineer`,
`code-reviewer`, `research-analyst`, `writing-editor`. An employee with no `basedOn` is a custom one:
its standing instruction is all it has.

## Afterwards: unlock codes

```
bun scripts/ark-trial.ts sign-code --customer wine24 --action extend --until 2027-01-15T23:59:59+02:00
bun scripts/ark-trial.ts sign-code --customer wine24 --action end
bun scripts/ark-trial.ts sign-code --customer wine24 --action paid
```

The customer pastes the printed `ARK1-…` line into **Settings → Plan → Trial → Unlock code**. Each
code works once, and only for its customer.

## Check-ins

BlackArk's own ArkAgent server, with `ARK_TRIAL_RECEIVER=true`, receives check-ins at
`/api/trial-checkins` and lists them in **Admin → Trials**. Each one carries the customer id, a
random install id, the version, the status, the days left, the end and the number of trial
employees. Nothing else is sent.
