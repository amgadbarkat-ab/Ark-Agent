# ArkAgent: product docs

Ark is our company-owned AI agent platform ("digital employees"), sold as monthly subscriptions
(ArkAgent, Ark Team, Ark Team Enterprise) and also used internally. These docs record decisions,
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
| [16-penetration-test.md](16-penetration-test.md) | The internal penetration test: how it was run, the seven findings and their fixes, what held, what it could not reach, and how to re-run it. |
| [17-cloud-runtime.md](17-cloud-runtime.md) | Where a coworker runs (device or Ark's cloud), what is measured, how the price is worked out and set from cost, how a month is charged exactly once, and what has not been verified. |
| [18-capacity.md](18-capacity.md) | Load: a burst that hung the server and how it was fixed, where a page load spends its time, and what has not been measured. |
| [19-mobile.md](19-mobile.md) | Android and iOS: the web app first, a Trusted Web Activity for Google Play, a thin shell for the App Store, why nothing in either app sells, what the owner must provide, and what is not built. |
| [20-accounts-and-keys.md](20-accounts-and-keys.md) | What the company has to obtain and how, step by step: D-U-N-S, Google Play, Apple Developer and App Store Connect, the Mac Developer ID, Windows signing; the names to set in GitHub; order, cost and lead times; the branch for a company versus a sole proprietor. |
| [22-starter-model.md](22-starter-model.md) | The free starter model: why, what it is and is not, the model chosen and the Oracle free-tier machine it runs on, the queue, the settings, how to set the server up, what is verified and what is not. |
| [21-desktop-demo.md](21-desktop-demo.md) | The desktop app for a first customer demo: what the customer sees, what must exist first, making the first release, where the downloads live (the company's website), and what was and was not checked. |
| [25-device-control.md](25-device-control.md) | Device control, step 1: what an employee on the desktop can reach today, the gaps against "no submit, pay, send or delete without a person approving", 20 Greek/English test tasks, and 10 prompt-injection trap pages (`security/device-control-traps/`). |
| [../brand/README.md](../brand/README.md) | The company's v3 (Ember) identity as used in Ark: tokens, the app tile, where each icon lands, how to make them again, and what is not done. |
| [../legal/](../legal/) | Drafts for a lawyer: privacy notice (shown in the app at /privacy), terms of service (at /terms; acceptance recorded per version) and a data processing agreement template. |

Codebase status: the repo contains CopilotKit's OpenBot (MIT) as the base we are modifying.
It no longer needs CopilotKit's hosted Intelligence service: Ark Hub (`hub/`) replaces it.
