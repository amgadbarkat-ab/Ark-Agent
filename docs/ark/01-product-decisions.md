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
- When a user is at their limit, a task that wants to start is **queued** and the user is offered an
  upgrade. It is not refused outright.
- The account data model is built so that shared seats can be added later without rewriting the
  tables (decided 2026-10-08), even though v1 sells one user per account.
- The price covers the Ark software. Running bots in Ark's cloud is a separate paid add-on (D5).
- Enterprise works out at EUR 0.50 per bot. This is intended: those bots are expected to run mostly
  on the customer's own machines, and cloud running is paid for separately (D5).

**D4. What counts toward the limit.** A bot counts only while it is **hired and has a run in
progress**. These do **not** count:
- idle bots,
- bots that are installed but not hired, and
- bots that only have a future schedule, between runs.

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

**D9. Hosting: Microsoft Azure, sign-in with Microsoft Entra ID.** The owner asked for "the
suitable MS 365 tool". Microsoft 365 itself is office software and does not host applications;
the Microsoft product that does is Azure, and Entra ID is the sign-in service shared by both. This
is the working assumption and is to be confirmed with the owner before anything is deployed
(Phase 7).

## Open questions

1. **Cloud add-on price list.** Needs measured cost per bot-hour before prices are set.
2. **Payments and tax.** Prices are in EUR: choose the payment provider and VAT handling.
3. **Mobile store rules.** Apple and Google take a cut of in-app subscriptions and restrict how paid
   digital goods are sold. Check current terms before choosing how mobile users pay.
4. **OpenAI approval.** OpenAI's official plan sign-in path for paid or hosted apps requires
   contacting OpenAI (see 04-llm-providers.md).

## Answered

- A bot with only a future schedule does not count between runs; it counts only while a run is in
  progress. (2026-10-08)
- At the limit, a task that wants to start is queued and the user is offered an upgrade. (2026-10-08)
- Build the accounts so shared seats can be added later. (2026-10-08)
- Idle bots and bots installed but not hired do not count toward the limit. (2026-10-08)
- Every plan is per single user, no shared seats, including Ark Team. (2026-10-08)
- Enterprise at EUR 250 for 500 bots is intended, with bots mostly on customers' machines. (2026-10-08)
