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

**D3. Three subscription plans, each for one user.** The user chooses one at sign-up. A tenant
layer enforces the limits. Every plan is **per single user account**: there are no shared seats.

| Plan | Price | Bots included (per user) |
| --- | --- | --- |
| Ark Agent | EUR 50 / month | 1 |
| Ark Team | EUR 100 / month | up to 15 |
| Ark Team Enterprise | EUR 250 / month | up to 500 |

- Ark Team is a separate product from Ark Agent, not a bigger version of it.
- A person who needs more than their plan allows moves to a bigger plan. A company that wants
  several people on Ark buys one plan per person.
- The platform blocks hiring or starting bots beyond the plan limit.
- The price covers the Ark software. Running bots in Ark's cloud is a separate paid add-on (D5).
- Enterprise works out at EUR 0.50 per bot. This is intended: those bots are expected to run mostly
  on the customer's own machines, and cloud running is paid for separately (D5).

**D4. What counts toward the limit.** A bot counts only while it is **hired and active** (an agent
with running tasks). These do **not** count:
- idle bots, and
- bots that are installed but not hired.

Installing a bot from the marketplace is free of limits; hiring and running it is what uses the
allowance.

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

1. **Exact meaning of "active".** A bot counts while it has a running task. Does a bot with only a
   future schedule (a routine waiting for its next run) count in between? Suggested: it counts only
   while a run is in progress, but the plan should say how many may run at the same time.
2. **At the limit.** When a user is at their limit, what happens to a task that wants to start:
   refuse, queue, or offer an upgrade? Suggested: queue it and offer the upgrade.
3. **Cloud add-on price list.** Needs measured cost per bot-hour before prices are set.
4. **Payments and tax.** Prices are in EUR: choose the payment provider and VAT handling.
5. **Mobile store rules.** Apple and Google take a cut of in-app subscriptions and restrict how paid
   digital goods are sold. Check current terms before choosing how mobile users pay.
6. **OpenAI approval.** OpenAI's official plan sign-in path for paid or hosted apps requires
   contacting OpenAI (see 04-llm-providers.md).

## Answered

- Idle bots and bots installed but not hired do not count toward the limit. (2026-10-08)
- Every plan is per single user, no shared seats, including Ark Team. (2026-10-08)
- Enterprise at EUR 250 for 500 bots is intended, with bots mostly on customers' machines. (2026-10-08)
