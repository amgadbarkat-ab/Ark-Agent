# Application to OpenAI: ChatGPT plan sign-in

Written 2026-10-08. **This is a draft for the owner to submit.** It cannot be submitted from this
environment: the form needs the company's details and OpenAI's page refuses automated access, so
its exact fields were not visible. Where the form asks something not covered below, answer from the
facts in this file and do not claim more than it says.

## Where to apply

- Form: https://openai.com/form/sign-in-with-chatgpt-interest/
- Why this one: OpenAI's documentation says ChatGPT plan usage is available to open-source and
  locally hosted apps, and that "if you're interested in offering it in a paid or remotely hosted
  app, complete the interest form." Ark is both paid and hosted. The client ID page says Sign in
  with ChatGPT "is currently offered to a select group of commercial partners" and points to the
  same form as the waitlist.
  (https://developers.openai.com/siwc/token-sharing-open-source,
  https://developers.openai.com/siwc/request-client-id)
- Expect a wait and possibly a no. Ark does not depend on it: an API key, a local model and any
  compatible server all work today.

## Text to paste

**Company:** [COMPANY NAME], [COUNTRY]. Contact: [NAME, ROLE, EMAIL].

**Product:** Ark Agent, a hosted service where each customer runs "digital employees": AI agents
that work on their behalf (research, drafting, scheduled and long-running tasks, using tools the
customer connects). Customers use Ark in a browser and in desktop and mobile apps. Plans are
EUR 50, 100 and 250 a month per user, priced for the software and not for model usage.

**What we want to offer:** a "Sign in with ChatGPT" option so a customer who already pays for
ChatGPT can let their own agents use their own plan, instead of pasting an API key. Their usage
would count against their own plan and limits. Ark would not pay for, resell, pool or share model
usage.

**Why it matters to our customers:** Ark's promise is that people pay Ark and nothing else for
the model. Customers can already bring an API key, a free key or a local model. Many have a ChatGPT
plan and no API account, and for them this is the difference between starting in a minute and not
starting.

**How we would integrate it:**
- OpenAI's own OAuth flow only, with a client ID issued to us. We do not read, copy or reuse the
  Codex CLI's tokens or any other app's tokens.
- Per customer: each customer authorises for themselves. One customer's authorisation is never used
  for another customer, for a team, or for Ark's own work.
- Tokens are stored encrypted at rest (AES-GCM, key held outside the database), are never sent to a
  browser or to a running agent (agents call a gateway on our server that adds the credential
  server-side), and are deleted on sign-out, on removing the connection, and on account closure.
- Refresh and revocation handled as the documentation describes; a revoked or expired connection
  stops that customer's agents with a message, and never falls back to another credential.
- Requests identify the agent host as the documentation requires.
- We follow the UI/UX and branding guidelines for the sign-in button.

**Volume:** [EXPECTED CUSTOMERS AT LAUNCH AND AFTER 12 MONTHS]. Each customer runs between 1 and
500 agents at once depending on plan; most requests are interactive or scheduled tasks, not bulk
batch.

**Safeguards on our side:** per-account limits on how many agents work at once; run-level audit
trail; per-customer isolation (one customer cannot see or run another's agents or credentials);
administrative suspension of an account.

**Open to:** a review of the integration, a pilot with a small number of customers first, and any
usage reporting OpenAI requires.

## Facts to have ready

- Legal entity and VAT/registration number.
- Production domain and the redirect URI(s) the OAuth client will use.
- Privacy policy and terms of service URLs (not yet written: Phase 7).
- A named security contact.

## What must NOT happen while waiting

Nothing in Ark may use ChatGPT plan credentials until OpenAI issues a client ID. The earlier code
that reused the Codex CLI's login has been removed (see 04-llm-providers.md, Part 3).

## When approved

Add it as its own provider row in `shared/model-providers.ts` (tier "plan") with OpenAI's flow,
store tokens through the same encrypted connection store, and route calls through the model gateway
so bots never hold the credential.
