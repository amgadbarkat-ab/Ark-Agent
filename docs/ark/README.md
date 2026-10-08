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

Codebase status: the repo contains CopilotKit's OpenBot (MIT) as the base we are modifying.
Right now it still needs CopilotKit's hosted Intelligence service to start. Removing that is
Phase 1.
