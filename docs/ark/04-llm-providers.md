# LLM providers: strategy and plan sign-in check

Written 2026-10-08. Not legal advice: a lawyer should confirm before launch. Terms change often;
re-check each source before shipping. **Verified** means I read the provider's own page on this
date. **Unverified** means it comes from search results or third-party pages only.

## Part 1. Can Ark let users sign in with their ChatGPT / Claude / Gemini / Grok plan?

| Provider | Verdict | What the provider says (verified unless marked) |
| --- | --- | --- |
| **Anthropic (Claude)** | **Not as a general provider.** Allowed only as an unmodified Claude Code harness. | Anthropic's Claude Code legal page says OAuth is "intended exclusively" for Claude plan holders using Claude Code and Anthropic's own apps. Developers building products, including with the Agent SDK, "should use API key authentication". Anthropic "does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users", and developers "may not collect, store, or intermediate Claude.ai credentials or session tokens". The one allowed pattern: an end user signs in to the **unmodified Claude Code binary** with their own plan, including where a platform hosts it, and the platform must not pay for or resell usage. |
| **OpenAI (ChatGPT / Codex)** | **Allowed through OpenAI's official "Sign in with ChatGPT" program, with conditions.** | OpenAI documents ChatGPT plan usage "for open-source and locally hosted apps", available to all open-source partners. For a "paid or remotely hosted app" the docs say to complete an interest form first, so approval is needed. Eligible users are ChatGPT Plus and Pro. Ark must use OpenAI's own OAuth flow, not copy the Codex CLI's token. |
| **Google (Gemini)** | **No for consumer plans.** API key only. | Gemini CLI terms: using the services through third-party software, "for example, using OpenClaw with Gemini CLI OAuth", violates the terms and may lead to account suspension. Subscription plan access is not offered to outside apps. Separately, Gemini API terms say to use "only Paid Services when making API Clients available to users in the European Economic Area, Switzerland, or the United Kingdom", so the Gemini **free** tier is out for EEA/UK/CH. |
| **xAI (Grok)** | **Unclear. Do not promise it.** (Unverified) | Press and tool docs show SuperGrok sign-in working in named tools (for example Hermes Agent and OpenCode), but I found no developer documentation for building our own app on it. The route can reject standard subscribers. Ark would need xAI's written permission or its own registered client. |

### What this means

1. **Safe for every user:** their own API key (paid), local models, free API keys.
2. **Offer plan sign-in only where it is official:** OpenAI via its program (apply first), and
   Claude only by launching the user's own unmodified Claude Code.
3. **Do not ship** any code that stores a Claude plan token, or reuses the Codex CLI token, or
   routes Gemini plan traffic. The OpenBot code we started from does some of these (see Part 3) and
   must be changed.

## Part 2. Provider strategy (technical decision)

One internal interface speaking the OpenAI-compatible chat/tool-calling API, with these tiers:

| Tier | What | Default? | Notes |
| --- | --- | --- | --- |
| T0 Local | Models run on the user's machine through Ollama or llama.cpp, managed by the Ark desktop app | **Yes** | Free and private. Catalogue limited to models with permissive licences (Apache-2.0 or MIT), checked at release time. Auto-pick a model that fits the machine's RAM and GPU. Small models are much weaker at agent work (tool use, browsing): the app must say so. |
| T1 Free hosted, user's own key | OpenRouter `:free` models, Groq, Cerebras | **Yes** | Limits are per account or organisation, so one shared Ark key cannot serve many users. Each user creates their own free key. Ark never pays. (Unverified: exact current limits and commercial terms for each; read each provider's agreement before listing.) |
| T2 Paid, user's own key | Anthropic, OpenAI, Google (paid), xAI, Azure, Bedrock | No | Clean everywhere. Billed to the user by the provider. |
| T3 Plan sign-in | OpenAI program; Claude via unmodified Claude Code | No | Only as described in Part 1. |
| T4 Ark-hosted open models | Ark runs open-weight models on its own GPUs | No | Optional paid add-on, priced at cost plus (like the cloud-runtime add-on). The practical option for phones and weak PCs. **First step, decided 2026-10-15:** a free starter model on Oracle Cloud's free tier, no usage cap, no charge, for people with no model of their own (22-starter-model.md). It is not this paid add-on. |

Decisions:
- **Local first, then free keys.** Defaults are T0 and T1, as requested.
- **Gemini free tier is excluded** from the free list because of the EEA/UK/CH rule above.
- **Phones are clients, not engines.** Phones cannot run strong local models. A phone talks to bots
  running on the user's desktop (through a secure relay) or in Ark's cloud. Small on-device models
  are for simple chat only.
- Never log or store plan tokens in Ark's cloud. Keys and tokens stay on the user's device, or in an
  encrypted vault for cloud bots.

## Part 3. What the inherited code did that conflicted, and what was done

Found in `desktop/src-tauri/src/`, `server/src/agents/plan-model.ts` and the two harnesses. Status as
of 2026-10-08:

- **Claude plan: removed.** The desktop ran Anthropic's CLI in a container to obtain a plan token,
  stored it as `CLAUDE_CODE_OAUTH_TOKEN`, and passed it to a Claude Agent SDK bot, which the server
  then called as a model. All of it is deleted (sign-in driver, storage, the server's plan model, the
  harness's model-only endpoint). The Claude Agent SDK harness now requires an API key and drops a
  plan token from its environment. A person who wants their plan uses it in their own, unmodified
  Claude Code (a later, separate feature: Ark launches it, never touches its credentials).
- **ChatGPT plan (Codex login reuse): removed.** The desktop used `codex login` and reused its token
  store in the LangGraph harness. Deleted, including the store file and its mount. It comes back only
  through OpenAI's "Sign in with ChatGPT" programme, as its own row, once OpenAI approves Ark. The
  application to OpenAI is not made yet.
- **Leftovers on existing machines:** the desktop removes a retired plan token from the protected
  store, `.env` and the token-store file at Start and when its setup screen opens, and the server and
  both harnesses drop the variables from their environment at start.
- **Google:** Gemini Developer API with a Cloud project's quota, not a Gemini subscription, which is
  acceptable. Needs Ark's own verified OAuth client, and paid-only for EEA/UK/CH users. Still to do.
- **xAI: still open.** The desktop signs in with a hard-coded OAuth client id taken from "xAI's
  endorsed OpenCode integration" (`XAI_CLIENT` in `desktop/src-tauri/src/provider_oauth.rs`,
  `desktop/PROVIDER_OAUTH.md`). That client belongs to someone else's integration. Unless xAI confirms
  in writing that Ark may use it, replace it with an API key only or with Ark's own registered
  client. Not yet changed.

## Sources

- Anthropic: https://code.claude.com/docs/en/legal-and-compliance (verified)
- OpenAI: https://developers.openai.com/siwc/quickstart and
  https://developers.openai.com/siwc/token-sharing-open-source (verified)
- Google Gemini CLI terms: https://geminicli.com/docs/resources/tos-privacy (verified)
- Google Gemini API additional terms: https://ai.google.dev/gemini-api/terms (verified)
- xAI: search results and https://x.ai/news/grok-hermes (unverified)
- Free tiers: OpenRouter, Groq and Cerebras documentation as reported by search results
  (unverified; limits changed in late 2025 and may have changed again)
