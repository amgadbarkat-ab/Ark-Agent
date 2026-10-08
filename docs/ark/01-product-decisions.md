# Product decisions

Updated 2026-10-08 from the owner's instructions. Section "Open questions" is not decided.

## Decisions

**D1. Independent product, built on MIT code.** Ark is built by taking CopilotKit's OpenBot (MIT)
directly and modifying it. Ark must not depend on CopilotKit's hosted services or any other
third-party control plane. Conversations, memory and accounts live in storage we operate (cloud) or
on the user's own device (desktop). See 03-licensing.md and 05-build-plan.md.

**D2. Both desktop and cloud, plus mobile.**
- Desktop app: macOS and Windows.
- Mobile apps: Android and iOS.
- A cloud service behind all of them (accounts, billing, marketplace, hosted bots).

**D3. Three subscription plans.** The user chooses one at sign-up. A tenant layer enforces limits.

| Plan | Price | Bots included |
| --- | --- | --- |
| Ark Agent | EUR 50 / month | 1 |
| Ark Team | EUR 100 / month | up to 15 |
| Ark Team Enterprise | EUR 250 / month | up to 500 |

- Ark Team is a separate product from Ark Agent, not a bigger version of it.
- The platform blocks activating bots beyond the plan limit.
- The price covers the Ark software. Running bots in Ark's cloud is a separate paid add-on (D5).

**D4. What counts as a bot.** An **active agent with running tasks**. Not a saved definition on
its own. (To confirm: do idle saved definitions count toward the limit? See open question 1.)

**D5. Where bots run: the user's choice, per bot.**
- On the user's own device (included in the plan; costs Ark nothing).
- In Ark's cloud (optional add-on). It is metered and priced so the extra charge covers **100% of
  Ark's cost** for that usage (compute, storage, network, payment fees and tax handling). Any margin
  on top is a separate business decision. We need real cost data before setting prices.

**D6. LLM providers.** Local and free providers are the default, so a user pays Ark and nothing
else. Users may connect their own provider by signing in or with their own key, and switch at any
time. The technical design and the legal check of plan sign-in are in 04-llm-providers.md.

**D7. Marketplace.**
- Ark publishes its own digital employees. Users can install these.
- Users can share their own bots, but a shared bot is **view-only**: other users can read all its
  details (instructions, tools, skills, setup) as a guide to build their own, but **cannot import,
  install, clone or export it**. Nothing from a user-shared listing ever runs on another user's
  account. This also removes most of the security risk of shared bots.
- Secrets and private data must be stripped from a bot before it can be listed.

**D8. Brand assets** (name, logo, colours, domain): later.

## Open questions

1. **Active vs saved.** Does a saved but idle bot definition count toward the plan limit, or only
   active ones? And is a bot "active" while it has a schedule, or only while a task is running?
2. **Seats.** Is each plan per single user account, or per organisation with several users sharing
   the bot allowance? How many users does Ark Team and Ark Team Enterprise include?
3. **Enterprise economics.** EUR 250 for 500 bots is EUR 0.50 per bot. That only works if those
   bots run on the customer's own machines or on cloud add-on charges. Confirm this is intended.
4. **Cloud add-on price list.** Needs measured cost per bot-hour before prices are set.
5. **Payments and tax.** Prices are in EUR: choose the payment provider and VAT handling.
6. **Mobile store rules.** Apple and Google take a cut of in-app subscriptions and restrict how paid
   digital goods are sold. Check current terms before choosing how mobile users pay.
7. **OpenAI approval.** OpenAI's official plan sign-in path for paid or hosted apps requires
   contacting OpenAI (see 04-llm-providers.md).
