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
| ArkAgent | EUR 50 / month | 1 |
| Ark Team | EUR 100 / month | up to 15 |
| Ark Team Enterprise | EUR 250 / month | up to 500 |

- Ark Team is a separate product from ArkAgent, not a bigger version of it.
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
  *Built (Phase 4, 17-cloud-runtime.md): metered, opt-in with the prices shown and a monthly limit,
  charged monthly through Paddle. No prices are set yet; they come from measured cost.*

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

**D8. Brand assets** (name, logo, colours, domain): **decided 2026-10-09.** The identity is the company's own:
BlackArk Visual Identity v3 (Ember, issued 2026-10-04), taken from the company's OneDrive and its website.
The product is named **ArkAgent**; the company domain is **blackark.uk**. `brand/README.md` says what was
taken, where each icon lands and what is not done (the web app's screens keep their inherited design until a
decision is made on moving them to the v3 tokens; the wordmark and fonts are not imported). The name
"BlackArk" is cleared as a trademark in the UK only; "ArkAgent" has not been checked. The
accounts and keys the brand and the domain unlock are in 20-accounts-and-keys.md.

**D9. Hosting: Microsoft Azure, sign-in with Microsoft Entra ID.** The owner asked for "the
suitable MS 365 tool". Microsoft 365 itself is office software and does not host applications;
the Microsoft product that does is Azure, and Entra ID is the sign-in service shared by both. This
was the working assumption and is now **confirmed by the owner (2026-10-08)**; Phase 7 builds for it.

## Open questions

1. **Cloud add-on price list.** Needs measured cost per bot-hour before prices are set. The mechanism
   is built; the procedure for setting the prices from cost is in 17-cloud-runtime.md.

## Answered

- **Several people on one account: no change.** Plans stay one user per account (D3). (2026-10-15)
- **Shared marketplace bots stay view-only, not installable** (D7). (2026-10-15)
- **Free trial: 30 days.** The terms were settled on 2026-10-16 (below). (2026-10-15)
- **A free starter model, no usage cap, no charge.** The model was chosen by engineering (Gemma 4 E4B); see
  22-starter-model.md. **Oracle Cloud's free tier was dropped on 2026-10-16** (it is now 2 OCPU and 12 GB); the
  direction is a managed local model on the customer's own computer, with a hosted starter left for later. (2026-10-15, amended 2026-10-16)
- **Free trial: 30 days, no card, on the ArkAgent plan, the cloud add-on off, and on day 31 the account pauses
  read-only (data kept 30 days) until a plan is chosen.** The owner accepted the defaults. (2026-10-16)
- **v0.1.5 runs on the owner's Windows PC.** The owner will list the issues found. (2026-10-16)
- **Azure region: Europe for now** (West Europe). Microsoft lists no Greece region today; revisit when it
  does. (2026-10-15)
- **SOC 2: dropped.** ISO 27001 is left as a low-priority item, undecided. (2026-10-15)
- **The desktop app asks for an Ark account at first run.** The account carries the 30-day trial and the free starter
  model, and keeps the model server's token off customers' computers. It needs the cloud account service to be
  live, so it follows the first Azure deployment. (2026-10-16)
- **The app's look follows openbot.run:** layout, spacing, component shapes and a dark default. BlackArk's own
  colours and the ArkAgent character stay (D8); none of OpenBot's logo, images or code is copied. (2026-10-15)
- **Identifiers: `blackark.arkagent`** for the Android package, the iOS bundle identifier and the desktop
  app. Permanent once published (20-accounts-and-keys.md). (2026-10-09)
- **Customers download the app from the company's own website only**, not from GitHub (21-desktop-demo.md,
  "Where the downloads live"). (2026-10-09)
- **The first installers are issued unsigned** and the signing certificates come later; customers see the
  system warnings until then (21-desktop-demo.md). (2026-10-09)
- **The pull request into `main` is approved** so the release workflows can run. (2026-10-09)
- **The product is spelled ArkAgent**, one word (the owner's character poster and the company website); the three-bar mark and the ember palette are the company's v3 identity, and the character below is its face. (2026-10-09)
- **The legal entity is Value Data IKE** (a Greek ΙΚΕ); **BlackArk is its trade name.** Stores and
  Microsoft enrol the legal entity, so the seller and the publisher are named "Value Data IKE".
  (2026-10-09)
- **The product runs on `app.blackark.uk`;** the marketing site stays on `www.blackark.uk`. (2026-10-09)
- **Mobile store rules: customers always pay on the website, through Paddle only.** The store apps are free
  companion apps that sell nothing and point nowhere to buy (19-mobile.md). Confirmed by the owner. (2026-10-09)
- **Domain and brand:** the company domain `blackark.uk`; the identity is the company's own v3 (Ember),
  taken from its OneDrive (D8). (2026-10-09)
- **Option 2, "ArkAgent's server": an online inference service, not a machine the company runs** (2026-10-16, owner).
  The company-hardware plan is dropped. Recommended service: Scaleway Generative APIs (Paris, Gemma 4 31B with tool
  calling, OpenAI-compatible); Amazon Bedrock Frankfurt as the fallback. It costs per token, so it needs a daily
  allowance per person: **owner to confirm the number** (proposed 200,000 tokens a day). Details in 22-starter-model.md.
- **Payments and tax: Paddle**, a merchant of record that collects and files VAT and sends invoices.
  Adapter written; sandbox run still to do (12-paddle.md). (2026-10-08) **The Paddle account was created by
  the owner on 2026-10-16** (sign-in `general@blackark.uk`; no keys have been shared and none belong in the
  repository). Next in Paddle: the sandbox, then Paddle's checks of the business and of the website before the
  live account takes payments (12-paddle.md).
- **Hosting: Microsoft Azure with Microsoft Entra ID** for sign-in, confirmed by the owner. (2026-10-08)
- **OpenAI approval:** the application was submitted by the owner (08-openai-application.md); waiting
  for OpenAI's answer. (2026-10-08)
- **Keys:** the CopilotKit and Anthropic keys already shared stay in use; no rotation needed, by the
  owner's decision. (2026-10-08)
- A bot with only a future schedule does not count between runs; it counts only while a run is in
  progress. (2026-10-08)
- At the limit, a task that wants to start is queued and the user is offered an upgrade. (2026-10-08)
- Build the accounts so shared seats can be added later. (2026-10-08)
- Idle bots and bots installed but not hired do not count toward the limit. (2026-10-08)
- "Hired" is not a separate step: a bot counts while it has a run in progress, and installing one from
  the marketplace costs nothing against the limit. Built in Phase 5. (2026-10-08)
- Every plan is per single user, no shared seats, including Ark Team. (2026-10-08)
- Enterprise at EUR 250 for 500 bots is intended, with bots mostly on customers' machines. (2026-10-08)

- **Dark is the default, light is a setting (2026-10-18).** The look follows Grok and openbot.run with BlackArk's Ember as
  a light accent. The ArkAgent character's face is the application icon, the top-left logo and every coworker's
  default picture; a coworker's owner can replace its picture.
