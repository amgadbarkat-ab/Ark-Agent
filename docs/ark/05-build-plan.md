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
- [ ] Drop the licence-token and "Intelligence is required" wording from config and docs; rename
      the settings to hub names.
- [ ] Automated test that the whole stack runs with `*.copilotkit.ai` unreachable.
- [ ] Compact long conversations on replay; Postgres `LISTEN/NOTIFY` bus for several hub processes.
- [x] Desktop usage telemetry to CopilotKit removed (frontend, native emitter, server relay), with a
      test that the window reports nothing.
- [ ] **Desktop app still depends on CopilotKit** for its Intelligence sign-in, organisation sign-in,
      release source and image registry. Not fixable until Ark has a release pipeline, brand assets
      and signing certificates; the full list and order are in 10-desktop-replatform.md (Phase 6).
- [ ] Remove CopilotKit and OpenBot names and links from user-facing text (with the brand work).
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
- [ ] Usage metering in the gateway; audit events for connection changes.

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
- [ ] Per-owner skill names (known cross-customer name clash, 09).
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

### Phase 6. Mobile apps (L)
- Android and iOS apps as clients of the cloud API plus a secure relay to the user's desktop.
- Evaluate Tauri 2's mobile support against a native or React Native client before committing.
- Mobile store subscription rules to be settled first (open question 6).

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
- [ ] A content-security-policy, image scanning, scheduled dependency audit (15, O3–O5).
- [ ] Legal items only the owner can supply: privacy notice, data processing agreement, the
      sub-processors' agreements (14, "Before the first customer").

## Order and dependencies

1 comes first because everything else would be built on a service we do not control. 2 and 3 can
run in parallel after that. 4 needs 3 (billing) and cost data. 5 needs 3. 6 needs 3 and 4.
Brand work (rename, logo, colours) can happen any time after 1 and is only a few days.

## Immediate next steps

1. **Owner:** run the identity script and create the Google client (infra/azure/README.md); give a
   domain name; review and sign off the legal drafts (docs/legal). **Last of all, the Paddle sandbox
   run** (12-paddle.md), which the owner will do after everything else is in place.
2. **Next to build, needs nothing from the owner:** a report-only content-security-policy (15, O3), a
   scheduled dependency audit (15, O4). A first deployment to `dev` needs an Azure subscription to
   deploy into.
3. **Then:** measure the cloud's real cost and set its prices (Phase 4's open items), and Phase 6
   (desktop re-platform and mobile, needs brand assets and signing certificates).
