# Product decisions

Written 2026-10-08, from the owner's instructions. Anything under "Open questions" is not decided.

## Decisions

**D1. Independent product.** Ark Agent must not depend on CopilotKit or any other third-party
hosted control plane. All conversation data, memory and accounts live in storage we operate (or, on
the desktop app, on the user's own device).

**D2. Both desktop and cloud, plus mobile.**
- Desktop app: macOS and Windows.
- Mobile apps: Android and iOS.
- Cloud service behind all of them (accounts, billing, marketplace, hosted bots).

**D3. Pricing: monthly subscription per user account, with a tenant layer.**

| Plan | Price | Bots per user account |
| --- | --- | --- |
| Solo | EUR 50 / month | 1 |
| Team | EUR 100 / month | up to 10 |

- The number of bots is controlled by the platform: creation is blocked at the plan limit.
- Billing is per user account, inside a tenant (a customer organisation). The tenant layer holds
  the organisation, its users, their plans, and admin controls.

**D4. LLM providers.**
- Default: local models and free providers, so a user pays Ark and nothing else.
- Optional: the user connects their own provider by signing in (plan sign-in) or with their own key.
- A provider can be changed at any time without losing the bot's workspace or conversation.

**D5. Marketplace.**
- Ark publishes its own digital employees (bots).
- Users can publish and share their own bots.

## Open questions

1. **What counts as a "bot"?** A saved agent definition (instructions, tools, skills), or a running
   agent with its own computer (browser, files)? Cloud computers cost real money per bot; local ones
   cost us nothing. This decides whether EUR 50 / EUR 100 is profitable.
2. **Where do bots run?** On the user's device, in our cloud, or the user's choice per bot?
3. **"Free providers" in practice.** Free hosted tiers have rate limits and can change terms. Local
   models need capable hardware, and phones are limited. Which free providers do we support first?
4. **Plan sign-in terms.** Using a user's ChatGPT/Claude/Gemini plan through a third-party app is
   governed by each provider's terms. Check before we promise it.
5. **Marketplace rules.** Revenue share on paid bots? Review and moderation before listing? A shared
   bot can run commands and use a browser, so a malicious listing is a security risk. Governed
   tool access (a policy gateway like OpenBot's) is the likely answer.
6. **Mobile store fees.** Apple and Google take a cut of in-app subscriptions and have rules on
   how paid digital goods are sold. Confirm current terms before choosing how users pay.
7. **Tax and billing.** Prices are in EUR: VAT handling and the payment provider need choosing.
8. **Name and brand assets.** Logo, colours, domain.

## What these decisions imply for the build

- Replace CopilotKit Intelligence (threads and memory) with our own store, in Postgres for the
  cloud and SQLite on devices. Needed by D1.
- A provider layer: one interface over local models (for example Ollama), free hosted providers,
  OpenAI-compatible endpoints, and user sign-in. Needed by D4.
- Accounts, tenants, plans and bot-count enforcement. Needed by D3.
- A marketplace service with listing, install, review and publisher accounts. Needed by D5.
- Desktop (macOS, Windows) and mobile (Android, iOS) clients over one shared API. Needed by D2.

A phased plan will follow once the open questions marked 1 to 3 are answered.
