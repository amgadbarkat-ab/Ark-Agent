# Ark Agent: product docs

Ark is our company-owned AI agent platform ("digital employees"), sold as monthly subscriptions
(Ark Agent, Ark Team, Ark Team Enterprise) and also used internally. These docs record decisions,
research and plans. Each file says when it was written.

| File | What it covers |
| --- | --- |
| [01-product-decisions.md](01-product-decisions.md) | Decisions: platforms, three plans, bot definition, where bots run, marketplace. Open questions. |
| [02-competitor-comparison.md](02-competitor-comparison.md) | openbot.run, Bops, Hark, James AI compared against our requirements. |
| [03-licensing.md](03-licensing.md) | What code we may reuse (MIT OpenBot) and what we may not. |
| [04-llm-providers.md](04-llm-providers.md) | Provider strategy, and the legal check of ChatGPT/Claude/Gemini/Grok plan sign-in. |
| [05-build-plan.md](05-build-plan.md) | What the code gives us, and the phased plan to turn it into Ark. |
| [06-dev-notes.md](06-dev-notes.md) | How to run and test it, and the quirks of the web sandbox. |
| [07-model-connections.md](07-model-connections.md) | How people connect their own models, how keys stay safe, what is verified and what is left. |
| [08-openai-application.md](08-openai-application.md) | Draft application to OpenAI for ChatGPT plan sign-in, ready for the owner to submit. |
| [09-accounts-plans-quotas.md](09-accounts-plans-quotas.md) | Accounts, the three plans, the run quota with queue-and-upgrade, isolation between customers, billing. |
| [10-desktop-replatform.md](10-desktop-replatform.md) | What still ties the desktop app to CopilotKit and the order to remove it. |
| [11-marketplace.md](11-marketplace.md) | The marketplace: Ark's installable digital employees, view-only shared coworkers, what is kept out, review and reports. |
| [12-paddle.md](12-paddle.md) | How customers pay: why Paddle, what to set up, how it works, what is verified and the sandbox run to do before going live. |
| [13-azure-hosting.md](13-azure-hosting.md) | Hosting on Azure: why this shape, the day-to-day runbook, backups and the restore drill, secret rotation, the "before customers" checklist, and what has and has not been checked. |
| [14-data-protection.md](14-data-protection.md) | GDPR: what is held and where, who else sees it, people's rights and how each is met, what is kept after erasure, the breach procedure. |
| [15-security-review.md](15-security-review.md) | Security self-review: what was found and fixed (including the administrator-takeover flaw), what is open, and what a penetration tester should target. |

Codebase status: the repo contains CopilotKit's OpenBot (MIT) as the base we are modifying.
It no longer needs CopilotKit's hosted Intelligence service: Ark Hub (`hub/`) replaces it.
