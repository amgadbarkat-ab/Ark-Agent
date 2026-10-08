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

### O3. No Content-Security-Policy for the app — Medium

Only `frame-ancestors` is set (F7). A full policy would limit what an injected script could do. It was
not guessed at: the app draws bot output, markdown, a Paddle checkout and live frames, and a policy not
tried against each screen breaks one silently. Build it report-only first (`Content-Security-Policy-
Report-Only`), walk every screen with the browser console open, then enforce.

### O4. Dependencies still reported — Medium/Low

`bun audit` after the fixes lists 32. The ones that matter:
- **`undici` 5.29 (8 advisories, 6 high)** and its `@fastify/busboy` 2.x: pulled in by `@composio/core`,
  `@ai-sdk/*`, `@mastra/core` and `@copilotkit/runtime`. The advisories are in undici's own WebSocket
  client and `BalancedPool`; the server runs on Bun, whose own `fetch` and `WebSocket` are used, and no
  code of ours calls those parts of undici. Not exploitable through our code that was found, but not
  proven; watch for upstream updates and re-run the audit with each dependency bump.
- **`braces` ≤ 3.0.3** (build-time glob matching; no fixed release at the time of writing).
- **`esbuild` ≤ 0.24** (the Vite *development* server only; not shipped).
- **`@ai-sdk/provider-utils`, `fast-copy`, `sprintf-js`**: low/moderate, in libraries that handle our
  own data, not attacker input.

Make `bun audit --audit-level=high` a scheduled check with an explicit allow-list for the above, so a
*new* high finding fails visibly.

### O5. Image and cluster scanning not set up — Medium

No container image scan (Microsoft Defender for Containers or Trivy in the pipeline) and no policy
enforcement beyond network policy. Turn on Defender for Containers on the cluster and registry, and
fail the deploy on a critical finding in the images.

### O6. Account squatting by an unverified address — Low

Anyone may sign in with a provider that does not verify addresses and create the account for
`victim@example.com` first. The real owner then signing in with Google finds that address taken (no
implicit linking, F2) and is locked out until staff intervene. It is a denial, not a takeover, and
requires the customer-facing providers to include one that does not verify addresses. **Today the
customer-facing provider is Google, which verifies**, so this stays low; do not enable such a provider
for customers without revisiting it.

### O7. Rate limiting is per endpoint, not global — Low

The marketplace, model-connection tests and the privacy endpoints have limits. Sign-in relies on the
authentication library's default limiter, which is only on when `NODE_ENV=production` and keeps its
counts in each replica's memory, so with two replicas the effective limit is double and a restart
resets it (it has not been configured or tested here). There is no general limit in front of the API. The ingress can carry one
(`nginx.ingress.kubernetes.io/limit-rps`), and Azure Front Door/WAF would add bot and DDoS
protection. Decide with the penetration test (O1.7).

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
| Vulnerability management? | Dependency audit now run by hand (O4); CI workflow scan by zizmor. |
| Tenant separation? | Application level, tested (O2). |
