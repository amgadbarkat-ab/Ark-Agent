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
- [ ] Package the hub into the one-container image (`Dockerfile`, `docker/s6`), the compose file
      and the Helm chart. Not started: image builds cannot run in the current sandbox (its proxy
      breaks TLS inside containers), and the hosting target is not chosen yet.
- [ ] Drop the licence-token and "Intelligence is required" wording from config and docs; rename
      the settings to hub names.
- [ ] Automated test that the whole stack runs with `*.copilotkit.ai` unreachable.
- [ ] Compact long conversations on replay; Postgres `LISTEN/NOTIFY` bus for several hub processes.
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
- [ ] Decide the xAI sign-in (written permission, own client, or API key only).
- [ ] Local models: hardware detection, suggested model, managed download (Ollama / llama.cpp).
- [ ] Usage metering in the gateway; audit events for connection changes.

### Phase 3. Accounts, plans, quotas (L)
- One paying user per account, each on one plan. Build the tenant boundary so that one account's
  data is fully isolated from every other. The current "tenant package" is only a configuration
  bundle, not a customer boundary.
- Keep the data model able to hold several users under one account later (for example a
  `memberships` table with one row per account today). Adding shared seats afterwards would
  otherwise mean rewriting every table that points to a user. This costs little now.
- Plans: Ark Agent (1 bot), Ark Team (15), Ark Team Enterprise (500).
- Quota (D4): counts only bots that are hired and have a run in progress. Installing a bot, idle
  bots and bots waiting for a scheduled run never count. Enforced on the server when a run starts.
  At the limit the run is queued and the user is offered an upgrade.
- Sign-up flow where the user picks the plan; payments, invoices and VAT through a payment provider
  (to choose); plan changes and cancellation.
- Admin console for us: accounts, plans, usage, suspensions.

### Phase 4. Bot runtime: device or Ark cloud (L)
- Local: the existing desktop stack runs the bot on the user's machine.
- Cloud: reuse the supervisor and bot-computer containers on our infrastructure, one per active
  bot, with usage metering (compute hours, storage, network).
- Add-on billing priced at 100% of measured cost (D5). Needs real cost data first.
- Per-bot choice of where it runs, and moving a bot between the two.

### Phase 5. Marketplace (M)
- Ark official digital employees: installable, versioned, reviewed by us.
- User-shared bots: **view-only** pages (D7). No import, install, clone or export endpoints for these.
  Strip secrets and private data before publishing, with a review step and report/takedown.
- Search, categories, publisher profiles.

### Phase 6. Mobile apps (L)
- Android and iOS apps as clients of the cloud API plus a secure relay to the user's desktop.
- Evaluate Tauri 2's mobile support against a native or React Native client before committing.
- Mobile store subscription rules to be settled first (open question 6).

### Phase 7. Production hosting and hardening (M)
- Pick the hosting target and deploy with the Helm charts; backups, monitoring, secrets.
- Replace single-user mode with real sign-in (Microsoft Entra ID for staff), real encryption keys.
- Security review, penetration test, data-protection documents (GDPR).

## Order and dependencies

1 comes first because everything else would be built on a service we do not control. 2 and 3 can
run in parallel after that. 4 needs 3 (billing) and cost data. 5 needs 3. 6 needs 3 and 4.
Brand work (rename, logo, colours) can happen any time after 1 and is only a few days.

## Immediate next steps

1. The remaining open questions in 01-product-decisions.md (cloud price list, payments and tax,
   mobile store rules, OpenAI approval) do not block Phase 1.
2. Anthropic API key, then Phase 0 baseline run.
3. Start Phase 1.
