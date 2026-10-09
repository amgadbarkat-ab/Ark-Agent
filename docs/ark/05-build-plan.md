# Build plan

Written 2026-10-08. Based on a survey of the imported OpenBot code. Sizes are rough: S = days,
M = 1-3 weeks, L = a month or more, for one engineer.

## What the OpenBot code already gives us

| Area | Where | State |
| --- | --- | --- |
| Web app (React) | `app/` | Chat, channels, admin screens, agents, skills, components |
| API server | `server/` | Auth (sign-in with Google/Microsoft/Okta/SAML/OIDC), agents, channels, policy gateway, audit log, credentials vault, routines, Postgres migrations (Drizzle) |
| Bot computers | `agent-computer/`, `supervisor/` | One container per bot with browser and files; policy-gated actions; works in a cloud runtime |
| Agent harnesses | `agent-*` | Many frameworks over the AG-UI protocol |
| Desktop app | `desktop/` (Tauri) | Installer, local stack manager, provider picker. Targets macOS, Windows and Linux. |
| Deploy | `Dockerfile`, `charts/` | One-container image and Helm charts |
| Missing | | Mobile apps, real multi-tenancy, plans and billing, marketplace, local-model provider, own conversation store |

Coupling to CopilotKit Intelligence: about 52 source files mention it, but it enters through one
SDK client (`server/src/intelligence-client.ts`, `server/src/copilot.ts`), so replacing it is
contained.

## Phases

### Phase 0. Baseline (S)
Run the unmodified stack once to confirm it works and to have something to compare against. Needs
the Anthropic key. Uses the temporary Intelligence key, then we drop it in Phase 1.

### Phase 1. Independence from CopilotKit (L) — in progress
Approach, decided after reading the SDK: build **Ark Hub** (`hub/`), a self-hosted service that
speaks the protocol the SDK already uses, so the app and server run unchanged and only point at the
hub. The protocol is defined by the MIT SDK's own client code, so no proprietary code is copied.

Done:
- [x] Hub: threads, event log, run locks, join tokens, REST API, Phoenix gateway (`hub/`, 32 tests,
      including the real SDK client, runner and browser client driving it).
- [x] Whole app verified end to end against the hub with no CopilotKit service: send a message in
      the UI, the answer streams back, reload in a fresh browser and the conversation is restored.

Still to do in this phase:
- [x] Hub started, stopped and configured by the stack's scripts (`scripts/hub.sh`, called from
      `start.sh` and `stop.sh`), default in `.env.example`, creates its own database.
- [x] Phone-home removed: SDK telemetry is forced off in code, the SDK inspector widget (which
      called `cdn.copilotkit.ai` and loaded Google Fonts) is off. A browser audit now shows no
      outside hosts.
- [x] The hub is packaged for hosting: its own image (`hub/Dockerfile`), a Helm chart section that
      runs it with its own ingress, network policy and secrets (`hub.enabled`), and the application
      image's workspace copy fixed so the lockfile still installs. **Not built into an image here**
      (Docker Hub's rate limit blocks builds in the sandbox); the first `az acr build` is the first
      real build (13-azure-hosting.md). Still not done: the one-container image (`docker/s6`) and the
      compose file do not run the hub; hosting does not need them.
- [x] The licence-token and "Intelligence is required" wording is gone from the configuration docs,
      the chart values, the start-up error and the architecture diagram. The `INTELLIGENCE_*`
      setting names stay, because the SDK the server is built on reads them (said where they are
      documented). Remaining upstream wording is in OpenBot's own docs that Ark does not use (the
      README and `docs/` pages that describe the original product), left for the brand work.
- [x] Automated check that the stack runs with `*.copilotkit.ai` unreachable: the security suite
      starts the real server behind a tripwire (`server/tests/security/tripwire.ts`) that refuses and
      records any `fetch`, web socket, socket or name lookup to a CopilotKit host, drives the whole
      suite through it, and fails if anything was recorded. `scripts/csp-walk.mjs` does the same for
      the browser (21 screens: no host but the deployment's own). Not covered: the desktop app, and the
      hub process (its own code makes no outside calls; nothing checks that by machine).
- [x] Postgres `LISTEN/NOTIFY` bus for several hub processes (`hub/src/shared-bus.ts`): a runner on
      one hub and a person on another see each other live, big events go through an overflow table, a
      lost connection is answered by replaying the log, hub migrations take an advisory lock so two
      starting at once do not collide. The chart runs the hub as a rolling update with a disruption
      budget, `replicaCount: 2` on Azure. Tested with two hubs on one database. Not tested: a real
      multi-pod cluster under load.
- [x] Compact long conversations on replay: consecutive streamed pieces of one message are sent as
      one (`hub/src/coalesce.ts`), 3,000 stored pieces replay as one frame with the same text and a
      cursor that still resumes. Replay only; the log and live events are unchanged. Not done:
      a stored snapshot to replay from, which would also cut the number of messages and tool calls
      replayed (not needed until conversations of that length are seen).
- [x] Desktop usage telemetry to CopilotKit removed (frontend, native emitter, server relay), with a
      test that the window reports nothing.
- [ ] **Desktop app still depends on CopilotKit** for its Intelligence sign-in, organisation sign-in,
      release source and image registry. Not fixable until Ark has a release pipeline, brand assets
      and signing certificates; the full list and order are in 10-desktop-replatform.md (Phase 6).
- [ ] Remove CopilotKit and OpenBot names and links from user-facing text. The product name is Ark Agent
      (D8); the desktop installer, window title and Welcome screen already say so, and the wording inside the
      desktop window and the web app's own docs is the pass still to do.
- Exit test: the whole app starts and works with no network access to any CopilotKit host.

### Phase 2. Provider layer (M) — core done, details in 07-model-connections.md
Done:
- [x] Provider catalogue (tiers T0-T3) shared by app and server, with address and key rules.
- [x] Per-person model connections, keys encrypted at rest, never sent to the browser
      (`/api/models`, migration 0046).
- [x] Connection test that lists the provider's models and reports refusals in words.
- [x] Runs use the person's own connection; hosted deployments refuse "on this computer" providers.
- [x] Model gateway: managed bots get a signed grant and never hold a key.
- [x] Settings > Models screen (add, test, default, change, remove), with tests.

Still to do in this phase:
- [x] Per-coworker model choice (07-model-connections.md).
- [x] Stored Claude plan token and `codex login` reuse removed from the desktop, the server and both
      harnesses; leftovers on existing machines are purged (04-llm-providers.md, Part 3).
- [ ] Add Claude through the user's unmodified Claude Code (launch only, never touch its login), and
      apply to OpenAI for its official "Sign in with ChatGPT" programme.
- [ ] Decide the xAI sign-in: the desktop uses a hard-coded OAuth client id that belongs to another
      party's integration (`XAI_CLIENT` in `provider_oauth.rs`). Remove it, or get xAI's written
      permission, or register Ark's own client. Until then treat xAI as API-key only.
- [ ] Local models: hardware detection, suggested model, managed download (Ollama / llama.cpp).
- [x] Audit events for connection changes (9.1).
- [ ] Usage metering in the gateway.

### Phase 3. Accounts, plans, quotas (L) — core done, details in 09-accounts-plans-quotas.md
Done:
- [x] Accounts, memberships (seat-ready), subscriptions, the plan catalogue (`shared/plans.ts`),
      backfill of existing users.
- [x] Quota (D4): different coworkers working at once, counted in the database as leases, enforced
      around every coworker on every run path; at the limit a run waits, says so and offers the next
      plan; suspended, unpaid and ended accounts are refused with the reason.
- [x] Isolation between customers: a customer's public coworker is public to their account only; one
      rule shared by roster, profile store and runtime; tested across two customers.
- [x] Billing core behind one provider interface, with manual and sandbox providers and a safe,
      idempotent webhook; customer and staff account APIs, audited.
- [x] Settings > Plan, Admin > Accounts, and the sign-up gate; verified in a real browser.

Still to do in this phase:
- [x] Payment provider chosen: **Paddle**, a merchant of record that collects VAT and sends invoices.
      Adapter, webhook, plan change, cancel, billing portal and the Plan screen are built and tested
      against a fake Paddle (12-paddle.md). Catalogue setup is one command (`server/scripts/paddle-setup.ts`).
      **Still to do by the owner, deliberately the last check before launch:** the sandbox run in
      that file, before live keys go in.
- [x] Per-owner skill names: a name belongs to whoever wrote it, skills are identified by id, grants and
      edits refer to the id (09). Tested with two customers on one name, legacy skills, a Bot holding
      two of one name, and a double save.
- [ ] A fair queue order, if load ever needs one.

### Phase 4. Bot runtime: device or Ark cloud (L): built 2026-10-08, not yet run on real infrastructure
See 17-cloud-runtime.md.
- [x] Per-coworker choice of where it runs (Ark's cloud or the person's own computer); one set to its
      own computer is never run in the cloud behind the person's back.
- [x] Metering: runs, a coworker's computer being up, and its storage, as intervals; merged so an hour
      counts once; a crash is a short charge, not an endless one.
- [x] The add-on: off by default (`ARK_CLOUD_MODE=included`, behaviour unchanged), or `metered`: the
      customer sees the prices, agrees to them, sets a monthly limit; new runs stop at the limit; a
      change of prices asks again and old usage stays at the old prices.
- [x] Priced at cost: `charge = (cost × (1 + margin) + fixed fee) ÷ (1 − fee%)`, margin starting at zero.
- [x] Charged monthly through Paddle by a CronJob, with a ledger that cannot charge a month twice.
- [x] Screens: Settings → Plan → Cloud running; the coworker's "Where it runs"; Admin → Cloud costs.
- [ ] **Measure real cost and set the prices** (needs the cluster running coworkers; procedure in
      17-cloud-runtime.md section 5).
- [ ] Run the charge against Paddle's sandbox (12-paddle.md, step 10).
- [ ] The per-coworker computer on AKS (agent-sandbox controller); egress metering.

### Phase 5. Marketplace (M): done 2026-10-08
Built and verified; see 11-marketplace.md.
- Ark official digital employees: installable, versioned, curated in code.
- User-shared bots: **view-only** pages (D7). No import, install, clone or export endpoints for these.
  Secrets and private data are refused before publishing, with a review step and report/takedown.
- Search, categories, publisher profiles.

### Phase 6. Mobile apps (L): decided and partly built, see 19-mobile.md
Decision (2026-10-09): the web app first, then a Trusted Web Activity for Google Play and a thin shell
for the App Store, as a free companion app that sells nothing (the default for open question 2).
- [x] Installable web app: manifest, icons, offline page, a service worker that keeps nothing from `/api`.
- [x] Notifications (Web Push) with an opt-in per device on Settings; routine outcomes notify.
- [x] The two files that tie the site to a store app (`assetlinks.json`, `apple-app-site-association`).
- [x] Nothing to buy inside the store apps: the Plan screen is read-only there, and the server's offers
      to upgrade are left out.
- [x] Android package (Trusted Web Activity): builds a debug app and a signed bundle with the real SDK;
      its release workflow is written, never run on GitHub; never installed on a phone.
- [x] iOS shell (Capacitor), with sign-in through the system browser (Google refuses a web view): the
      project is made and configured here and its sign-in is tested; **never compiled** (no Xcode here),
      and its build workflow was never run.
- [x] Brand (D8): the company's v3 identity is applied to the web app, the Android adaptive icon, the iOS
      App Store icon and the desktop icon set (`brand/`); the companion-app default is confirmed.
- [ ] **Owner:** the product's hostname and the identifiers, a Google Play account, an Apple Developer
      account and review accounts, step by step in 20-accounts-and-keys.md.
- Not built: reaching a person's own desktop from a phone (needs a relay); notifications in the iOS
  shell (needs APNs).

### Phase 7. Production hosting and hardening (M) — built, not yet deployed
Hosting target confirmed: Microsoft Azure, with Microsoft Entra ID for staff sign-in (D9).

Done:
- [x] **Sign-in trust** (the critical finding): the administrator role only goes to a person who
      arrived through a sign-in that can vouch for the address; implicit account linking is off
      (15-security-review.md F1, F2).
- [x] **Azure infrastructure as code** (`infra/azure`): network, private PostgreSQL Flexible Server,
      AKS with Entra-only sign-in and workload identity, registry, Key Vault, monitoring and alerts,
      a monthly budget; two sizes (`dev`, `prod`); compiles with no warnings.
- [x] **Secrets** in Key Vault, read by the cluster through External Secrets; a bootstrap script that
      generates what can be generated and never prints a secret.
- [x] **Deploy pipeline** (`.github/workflows/ark-deploy.yml`): manual, no stored secret, builds in
      Azure's registry, upgrades the chart atomically, checks health.
- [x] **GDPR**: a person can download everything held about them and delete their account (Settings →
      Your data); staff can do both for somebody who wrote to us; erasure is ordered so a failure
      leaves the person untouched (14-data-protection.md).
- [x] **Browser protections** on every response; **dependency patches** (67 → 32 reported
      vulnerabilities, none critical).
- [x] **Documents**: the runbook with restore drill and rotation table (13), the data map,
      sub-processors, rights and breach procedure (14), the security review (15).

Still to do:
- [ ] **A first real deployment to `dev`**, which will find the small things a schema check cannot.
- [ ] The restore drill, and each alert fired once (13, "Before customers").
- [x] **Rotation for the data encryption key**: each sealed value names its key; a script re-seals
      everything while the service runs (13, "Rotating the data encryption key").
- [x] **Internal penetration test**: 56 attacks on the running server and the hub, seven findings fixed,
      kept as a CI job (16-penetration-test.md). An outside test of what it could not reach (bots'
      computers, a live run, real sign-in providers, the deployed estate) is the owner's call (15, O1).
- [x] A content-security-policy, image scanning, scheduled dependency audit (15, O3–O5): built in 9.2–9.4.
- [x] **Load-dependent hang fixed** (18): a burst of 20-30 concurrent requests at a freshly started
      server left some hanging for good and then wedged every later request, while `/health` still said
      fine. Bun's SQL pool loses queries when demand exceeds the pool and statements are not yet
      prepared; the client now sends them unprepared. Found by `scripts/load-profile.ts`, regression
      test `server/tests/db-burst.integration.test.ts` (fails on the old client). Per-route timings and
      what is not yet measured (the real cluster, the hub under load, the work pool) are in 18.
- [x] **Readiness is not liveness**: `/ready` (server and hub) checks the database and says `draining`
      as soon as the process is told to stop; the chart's readiness probe uses it, so a pod that cannot
      reach its database, or has a wedged pool, leaves rotation. A guard against a module-loading race
      (`require() async module`) was added to the server entry.
- [x] **A deploy no longer cuts off replies being streamed** (13): the server used to exit on the
      spot when told to stop. It now keeps serving while the platform takes it out of rotation, stops
      listening, waits for requests under way (a streaming reply counts) up to a grace, then closes the
      rest; the hub the same, shorter. The chart derives the platform's limit from the settings.
      Tested against the real process (`server/tests/security/shutdown.test.ts`, fails on the old
      behaviour). Not covered: a run that outlasts the grace is still cut (the grace is 45 s; a longer
      one needs the run to survive its pod, which it does not yet).
- [x] Observability: a log line for a failed or slow request and for anything that threw (route pattern,
      status, time, a request id the person is shown; nothing about a person), Prometheus `/metrics` on
      a port of its own for the server (traffic and latency per route, accounts by state, runs, cloud
      charges needing a person) and the hub (sockets, events, storage errors, catch-ups by reason), the
      chart and network policy, a 5xx alert on the logs. Not done: managed Prometheus is not enabled by
      the template (steps in 13, "What to watch"), no tracing, and nothing has run against a real cluster.
- [x] Terms of service: a draft for a lawyer (docs/legal/terms-of-service.md), shown at `/terms`, with
      acceptance recorded per version (`TERMS_ACCEPTANCE=required` makes a customer accept before using the
      app; off by default until the text is final). Not done: enforcement at the API for non-app clients
      (the desktop and mobile apps will need the same screen).
- [ ] Legal items only the owner can supply: privacy notice, terms of service, data processing agreement, the
      sub-processors' agreements (14, "Before the first customer").

## Order and dependencies

1 comes first because everything else would be built on a service we do not control. 2 and 3 can
run in parallel after that. 4 needs 3 (billing) and cost data. 5 needs 3. 6 needs 3 and 4.
Brand work (rename, logo, colours) can happen any time after 1 and is only a few days.

## Immediate next steps

**Owner (nothing else is blocked on engineering):**

1. Give a domain name; run the identity script and create the Google client (infra/azure/README.md);
   supply the Azure subscription and credentials through the environment's settings.
2. Review the legal drafts with a lawyer and fill their [bracketed] items (docs/legal: privacy notice,
   terms of service, data processing agreement); then set `TERMS_ACCEPTANCE=required` (14, "Before the
   first customer").
3. Measure the cloud's real cost and set the prices (17, section 5), then decide on the xAI sign-in, the
   desktop's CopilotKit dependency (brand assets, signing, release location) and the Content-Security-Policy
   question (15, O3).
4. Turn on Defender for Containers (`az security pricing create -n Containers --tier standard`), turn on
   managed Prometheus (13, "What to watch"), and create the conditional-access policy for staff (15, O9).
5. **Last of all, the Paddle sandbox run** (12-paddle.md), including the cloud charge (step 10), which
   the owner will do after everything else is in place.

**Engineering, needs nothing from the owner:** everything buildable without an Azure subscription, a
domain or a lawyer is built (phases 1–5 and 7, the hardening in 9, hub scale-out and replay compaction,
per-owner skill names, terms acceptance, observability, the administrator's overview). What is left is either on the owner's list
above or needs a running cluster: the first deployment to `dev` will find the small things a schema
check cannot, then the restore drill, each alert fired once, a load test, and the per-coworker computer
on AKS. Phase 6 (desktop re-platform and mobile) needs brand assets and signing certificates.
