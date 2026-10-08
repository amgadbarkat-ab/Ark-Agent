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

### Phase 1. Independence from CopilotKit (L)
- Implement our own thread and memory store behind the same interface the server already uses:
  Postgres for the cloud, SQLite for the local desktop stack.
- Remove the `INTELLIGENCE_*` requirements, the licence verifier, and the sign-in step.
- Remove CopilotKit and OpenBot names, logos and links from user-facing text.
- Add our NOTICE file and run the dependency licence scan.
- Exit test: the whole app starts and works with no network access to any CopilotKit host.

### Phase 2. Provider layer (M)
- One OpenAI-compatible provider interface (04-llm-providers.md, tiers T0-T4).
- Local models: managed Ollama or llama.cpp on desktop, hardware-based model choice.
- Free and paid bring-your-own-key providers, with switching that keeps the bot's workspace.
- Remove the stored Claude plan token and the `codex login` reuse. Add Claude through the user's
  unmodified Claude Code, and apply to OpenAI for its official plan sign-in.

### Phase 3. Accounts, plans, quotas (L)
- One paying user per account, each on one plan. Build the tenant boundary so that one account's
  data is fully isolated from every other. The current "tenant package" is only a configuration
  bundle, not a customer boundary.
- Keep the data model able to hold several users under one account later (for example a
  `memberships` table with one row per account today). Adding shared seats afterwards would
  otherwise mean rewriting every table that points to a user. This costs little now.
- Plans: Ark Agent (1 bot), Ark Team (15), Ark Team Enterprise (500).
- Quota (D4): counts only bots that are hired and active. Installing a bot never counts. Enforced on
  the server when a bot is hired or a run starts, with clear messages in the app, and a queue plus
  upgrade offer when at the limit (open question 2).
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

1. Settle the remaining open questions in 01-product-decisions.md (meaning of "active", behaviour at
   the limit). Neither blocks Phase 1.
2. Anthropic API key, then Phase 0 baseline run.
3. Start Phase 1.
