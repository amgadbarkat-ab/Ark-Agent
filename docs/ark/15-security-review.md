# Security review

Written 2026-10-08, by the engineer who built the hosted version, after reading the code paths that
decide who a person is, what they may reach, and where secrets go. **This is a self-review. It is not
a penetration test and does not replace one.** Its job is to record what was found, what was fixed,
what is still open and what an outside tester should be pointed at.

Severity is by what an attacker gains on the hosted service, assuming the attacker has an ordinary
customer account unless stated.

## Fixed

| # | Finding | Severity | Fix |
| --- | --- | --- | --- |
| F1 | **Administrator takeover through a multi-tenant Microsoft sign-in** (the "nOAuth" family). The role is granted to the address named in `INITIAL_ADMIN_EMAILS`. With Microsoft's `common`, `organizations` or `consumers` endpoints, the address comes from a claim the *signing-in directory's own administrator* writes. Anyone can create a directory, set `ceo@ark.example` in it, sign in, and receive the administrator role. | **Critical** | The role is granted only to a person who has signed in through something that can vouch for the address: Google with a verified address, Okta, a single-directory Microsoft application (a GUID, not `common`), or a registered company provider. Anybody else still signs in, as an ordinary customer. A person refused the role is recorded (`person.admin_withheld`). `server/src/auth/provider-trust.ts`, tested. |
| F2 | **Account takeover by address match.** Linking two ways of signing in because the addresses match lets someone who controls one provider's claim take over an account made through another. | High | Implicit account linking is off. |
| F3 | **Shared coworkers could have been a way to run someone else's code on a customer's account.** | High (by design risk) | Shared listings are *inert snapshots*: there is no install, clone or export route for them (a test lists every marketplace route and fails if one is added), they never run on another account, secrets are stripped, a scanner refuses secrets and private data before publishing, there is a review step and report/takedown. Ark's official coworkers are the only installable ones and are curated in code. |
| F4 | **Forged or replayed payment events.** | High | Paddle webhooks: HMAC-SHA256 over `timestamp:body`, timing-safe comparison, 300-second tolerance, several signatures accepted for rotation, each event processed once, and an older event never overwrites a newer state. |
| F5 | **Erasure or export by the wrong person, or by accident.** | High | Self-serve erasure needs the person's own address typed; staff erasure needs the *target's* address typed. Both are rate-limited (5 an hour), audited, and refuse to remove an administrator from the self-serve path or the last administrator at all. The export never contains a key, token or file contents. |
| F6 | **Half-erased people.** Deleting in the wrong order leaves a subscription still charging, or conversations behind. | Medium | Order is fixed: stop billing, remove conversations, revoke vendors, then one database transaction. A failure before the transaction leaves the person untouched and the request can be repeated. |
| F7 | **No browser protections on any response.** | Medium | Every response now carries `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Content-Security-Policy: frame-ancestors 'self'` (no clickjacking), a `Permissions-Policy` (microphone only for ourselves) and, on an `https://` deployment, HSTS for a year. A page that sets its own policy keeps it. `server/src/security-headers.ts`, tested. |
| F8 | **Known-vulnerable dependencies.** `bun audit` reported 67 (1 critical, 21 high). | Medium | Raised to patched versions of `hono`, `qs`, `axios`, `proxy-addr`, `fast-uri`, `ip-address`, `source-map-js`, `lodash-es`, `dompurify`, `katex`, `@modelcontextprotocol/sdk` and `@graphql-tools/utils` through `overrides` in the root `package.json`. Now **32 (0 critical, 8 high)**; what remains is in O4. All tests, type checks and the app build pass on the new set. |
| F9 | **Secrets in the pipeline.** | Medium | The deploy workflow has no stored secret. It proves who it is with a short-lived token GitHub issues and Azure exchanges for access; actions are pinned to a commit; images are built in Azure's registry; the pipeline cannot read the vault. |
| F10 | **The database reachable from the internet.** | Medium | It has no public address and sits in a subnet only the cluster can reach; network policy is enforced in the cluster. |
| F11 | **No way to rotate the data encryption key.** One key sealed every credential, model key and directory secret, with nothing recording which key sealed what, so a leaked key had no clean recovery and scheduled rotation was impossible. | High | Every sealed value now names the key that sealed it (a short fingerprint). The server holds a current key and any retired ones, writes only with the current, and reads with either; `server/scripts/rotate-encryption-key.ts` re-seals everything under the current key while the service runs, and its exit code says whether the old key can be removed. Procedure: docs/ark/13-azure-hosting.md. Tested with a real database, including a value changed mid-run and a value no held key opens. |
| F12 | **Seven weaknesses found by attacking the running application**: no origin check on the application's own writes and socket handshakes, no cap on request bodies, names resolving to internal addresses, carrier-grade NAT treated as public, server errors on hostile ids, token-printing sign-in routes, the hub's API published to the internet. | Low to Medium | All fixed, each held by a check that fails if it reopens. Details: [16-penetration-test.md](16-penetration-test.md). |

## Already sound in the base code (read, not changed)

- Model-provider and tool endpoints go through an address check that refuses internal addresses on a
  hosted deployment (the cloud metadata address is the classic target), with the allow-list consulted
  *before* the private-address opt-in so the opt-in cannot widen it.
- Keys, tokens and SSO configuration are encrypted before they reach the database, are write-only in
  the product and never reach the browser (`hasAuth: boolean`, never the value).
- The admin and settings screens are authorised by the server on every request, not by what the
  browser chooses to show.
- Sign-in has no passwords: email-and-password is not enabled, only OAuth/OIDC, so there is nothing
  to guess or stuff.
- There is no cross-origin access: the app and API share one origin.

## Open

Ordered by what to do first. **O1's remaining part (the bots' computers, a live run, real sign-in) should be closed before the first paying customer, by whoever the owner chooses.**

### O1. Penetration test: done internally, not independently — Medium

An internal test was carried out and is written up in [16-penetration-test.md](16-penetration-test.md):
66 attacks on the running server and the conversation hub (56 when it was written; ten more were added with the cloud-running routes), kept as a suite that runs in CI. It found
seven things (P1 to P7), all fixed. It is the same team testing its own work, so it is not independent,
and it could not reach the bots' computers, a live run with a model attached, real sign-in providers or the
deployed Azure estate (the report lists these). The owner asked engineering to do all the testing; whether
an outside tester is also commissioned is the owner's decision, and the surfaces worth giving one are the
ones the report says it did not reach.

*The original plan, for whoever tests next:*
1. Sign-in and the administrator rule (F1, F2) with a Microsoft multi-tenant tenant, a Google account
   with an unverified address, and two providers sharing an address.
2. Cross-customer reads: every list/detail endpoint that takes an id, with an id belonging to
   another account (agents, channels, files, routines, skills, model connections, marketplace).
   Isolation is enforced in the application (see O2); this is where a mistake would be.
3. The marketplace: a shared listing used to read or run anything outside its own page; publisher
   names; report/takedown abuse.
4. The bot computers: escape from the browser container, reach to the cluster network or the metadata
   address, file access across bots.
5. Billing: webhook forgery, replay, plan change races, getting a higher quota without paying.
6. Erasure and export: reaching someone else's, replaying a request after it succeeded.
7. Rate limits and resource use: uploads, long conversations, concurrent runs, WebSocket floods.

Of these, 1 (against real providers), 4, 5 (plan-change races) and 7 (floods) are what is left.

### O2. Isolation between customers is in the application, not the database — Medium

One rule, shared by the roster, the profile store and the runtime, tested across two customers. A
missed check on a new endpoint is a cross-customer read. Postgres row-level security keyed by account
would make that a database error instead of a data leak. It is a substantial change (every query runs
as a role with the account set) and is worth doing before the product grows more endpoints; the
penetration test (O1.2) tells how urgent it is.

### O3. Content-Security-Policy — Low (watched, not yet enforced)

A full policy exists (`server/src/csp.ts`) and is **sent in report-only mode by default**: the browser
reports what it would have blocked to `POST /api/csp-report` (public, small, limited per address,
one clean log line per distinct violation) and blocks nothing. `frame-ancestors 'self'` is still
enforced as before (F7). The policy allows only the app's own script (no inline script, no `eval`),
inline style, images from anywhere over https (a coworker's answer may show one), the app's own
address and the conversation hub for connections, and closes `object-src`, `base-uri` and
`form-action`. The payment page has its own, watched policy in every mode (below).

**It was walked in a real browser** (headless Chromium, 35 screens as a customer and as staff, sign-in,
dialogs opened): with the policy **enforced**, every customer screen and every admin screen drew and
worked, with **no violation on any customer screen**. The only violations were in two places that
run a *generated interface*, which is a sandboxed frame built from inline script:
the component previews and playground under Admin.

That is the decision to understand. Generated interfaces (a Bot drawing an interface it wrote itself,
and the components an administrator writes) run in a frame the SDK builds from inline script, and such
a frame **inherits the page's policy**, so an enforced policy that forbids inline script stops every one
of them drawing. So:
- **`CSP_MODE=report-only` (default):** safe with generated interfaces on. Nothing is blocked; what
  the policy would block is reported and logged, which is the evidence for the next step.
- **`CSP_MODE=enforce`:** the server **refuses to start** unless `OPENBOT_GENERATIVE_UI=false` too, so
  nobody enforces by accident and finds out from a customer. Those interfaces then do not draw. The
  frames have no same-origin access to the app (checked: `sandbox="allow-scripts"` without
  `allow-same-origin`), so leaving the policy report-only does not give a generated page the app.
- **`CSP_MODE=off`:** only `frame-ancestors`.

Not yet exercised, so not yet guaranteed: the payment page (its script and frame come from Paddle; the
allowances are from Paddle's documentation and the page's policy is report-only whatever the mode, so a
wrong guess cannot stop a customer paying), a live conversation through the hub (the walk had no
model or hub attached; the hub's address is in `connect-src`), voice and the live screen of a bot's
browser. **Before enforcing:** run `node scripts/csp-walk.mjs` against `dev` (it lists what the policy objects to, screen by screen), run in report-only for a while with real use, read the log lines
(`{"type":"csp-violation",...}`), and add what is legitimate. A better answer than turning generated
interfaces off is to give them a policy of their own, by serving their frame from a separate address
(or patching the SDK's renderer to); that is not done.

### O4. Dependencies still reported — Low

`bun audit` now lists **5** (1 high, 3 moderate, 1 low), down from 32. The drop is from forcing the
patched releases of `undici` (7.29.1, which also took the 5.x and 6.x users to 7) and
`@fastify/busboy` (3.2.2), and `fast-copy` (3.1), through `overrides` in the root `package.json`;
type checks and the whole test suite pass on the new set. What is left:
- **`braces` ≤ 3.0.3** (high): stack exhaustion on deeply nested brace patterns, reached only through
  `fast-glob`/`micromatch` in the app's build-time tooling (shadcn, ts-morph) with our own patterns.
  No fixed release exists. It is the one entry in `security/audit-allowlist.json`, with a reason and
  an expiry date.
- **`esbuild` ≤ 0.24** (the Vite *development* server only; not shipped), **`sprintf-js`** (no fix
  published) and **`@ai-sdk/provider-utils`** (low): moderate or low, in libraries that handle our own
  data, not attacker input.

**A scheduled check now exists** (`.github/workflows/dependency-audit.yml`, weekly and on any change to
a dependency file): `scripts/audit-check.ts` fails on any HIGH or CRITICAL advisory that is not in the
allow-list, or whose allow-list entry has passed its expiry date (at most 200 days out), so a decision
has to be made again rather than being made once and forgotten. Tested (`scripts/audit-check.test.ts`).
It reads the public advisory database, so a new advisory fails the next run with no change of ours.

### O5. Image and cluster scanning — Low (partly done)

- **In CI:** the `image` job now scans the built image with Trivy and **fails on a fixable CRITICAL
  vulnerability** (HIGH and CRITICAL are printed). Accepted findings go in `security/trivyignore`
  with a reason and an expiry. **Not yet run**: the first run on `main` is the first scan, and
  whatever it finds is decided then. The Trivy version is pinned in the workflow and is bumped on
  purpose.
- **On the cluster:** the AKS template turns on the Defender sensor (`securityProfile.defender`). It
  only reports once the **subscription** has the Defender for Containers plan on
  (`az security pricing create -n Containers --tier standard`), which is a subscription-wide setting
  and so is a step in `infra/azure/README.md`, not part of a resource-group template. With the plan
  on, Defender also scans the images in the registry and flags vulnerable ones that are running.
- **Still not done:** failing the *deploy* on a finding in the registry's own scan (the CI scan
  stands in for it), and admission policy beyond network policy.

### O6. Account squatting by an unverified address — Low

Anyone may sign in with a provider that does not verify addresses and create the account for
`victim@example.com` first. The real owner then signing in with Google finds that address taken (no
implicit linking, F2) and is locked out until staff intervene. It is a denial, not a takeover, and
requires the customer-facing providers to include one that does not verify addresses. **Today the
customer-facing provider is Google, which verifies**, so this stays low; do not enable such a provider
for customers without revisiting it.

### O7. Rate limiting is per endpoint, not global — Low (partly done)

The marketplace, model-connection tests and the privacy endpoints have limits. Sign-in relies on the
authentication library's default limiter, which is only on when `NODE_ENV=production` and keeps its
counts in each replica's memory, so with two replicas the effective limit is double and a restart
resets it (it has not been configured or tested here).

**Now:** the Azure ingress carries a per-address limit in front of every route
(`infra/azure/values-azure.yaml`: 100 requests a second sustained, a burst five times that, 60
connections; refused with 429). It is deliberately generous, because an office shares one address and
loading the app is dozens of requests. It stops a script hammering one route; it does not stop a
distributed flood, and **it has not been exercised** (it needs the running ingress). Azure Front Door
with its WAF would add bot and DDoS protection; that is a cost decision and is not made here.
Remaining: a distributed-flood answer, and sign-in limits that are shared across replicas.

### O8. Audit trail is in the product database — Low

Anyone with database administrator rights can edit it. The tamper-evident answer is shipping the events
to Log Analytics as they are written (immutable retention there). Key Vault's and the cluster's logs
already go to Log Analytics.

### O9. Staff multi-factor and conditional access — Low (configuration)

Staff sign in through Entra, so MFA, device compliance and location rules are one conditional-access
policy away. Create it before launch: require MFA for the Ark staff application and for the Azure
portal/CLI.

## What a customer's security questionnaire will ask, and the answer today

| Question | Answer |
| --- | --- |
| Where is data stored? | West Europe, Microsoft Azure, one PostgreSQL server (docs/ark/14). |
| Encryption in transit / at rest? | TLS to the browser and the database; Azure encrypts storage at rest; keys and tokens additionally encrypted by the application. |
| Key management / rotation? | Secrets in Key Vault. Data key rotation is supported without downtime (F11); procedure in docs/ark/13. |
| SSO / MFA for our staff? | Entra ID; MFA by conditional access (O9). |
| Penetration test? | Internal test done and repeatable in CI (16); **independent test not yet (O1)**. |
| Backups and recovery? | 35 days point-in-time, geo-copy; restore drill documented (13); **not yet performed**. |
| Breach notification? | 72-hour procedure (14). |
| Data deletion and export on request? | Self-serve, audited (14). |
| Sub-processors? | Listed (14). |
| Vulnerability management? | Weekly dependency audit that fails on an unreviewed high or critical advisory (O4); image scan in CI (O5); CI workflow scan by zizmor. |
| Tenant separation? | Application level, tested (O2). |
