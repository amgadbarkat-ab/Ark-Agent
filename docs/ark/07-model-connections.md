# Model connections (Phase 2)

Written 2026-10-08. How a person chooses what their digital employees think with, and how the keys
stay safe. The research behind the provider list is in 04-llm-providers.md.

## What a person sees

**Settings > Models.** A list of the person's own model connections and an **Add model** button.

- The provider picker is grouped by cost: *On this computer* (Ollama, LM Studio, llama.cpp), *Free,
  hosted (with your own free key)* (OpenRouter free models, Groq, Cerebras), *Your own paid key*
  (Anthropic, OpenAI, Google Gemini, xAI) and *Another server* (any OpenAI-compatible address).
- **Test connection** asks the provider which models it offers. It proves the address answers and
  the key is accepted, and fills the model suggestions. A refused key is reported in words, never by
  echoing what the provider said.
- The first connection becomes the default. Removing the default hands the role to the oldest
  remaining one. A person can keep up to 20.
- Subscription sign-ins (ChatGPT plan, Claude plan) are listed under *Not available* with the reason,
  until each is allowed (see 04-llm-providers.md).

Ark never bills for the model. Local and free models cost nothing; a paid key is billed to the
person by their own provider.

## Where the code is

| Piece | File |
| --- | --- |
| Provider catalogue, address and key rules (shared by app and server) | `shared/model-providers.ts` |
| Per-person connections, keys encrypted at rest | `server/src/models/connections.ts`, `server/src/db/schema/models.ts`, migration `0046` |
| HTTP routes `/api/models/*` | `server/src/models/routes.ts` |
| Connection test | `server/src/models/probe.ts` |
| AI SDK model object from a connection | `server/src/models/language-model.ts` |
| Which connection a run uses | `server/src/models/for-actor.ts` |
| Model gateway for bots | `server/src/models/grant.ts`, `server/src/models/gateway.ts`, `shared/model-header.ts` |
| Bot side | `agent-langgraph/src/model-override.ts`, `agent-langgraph/src/index.ts` |
| Screen | `app/src/routes/_authed/settings/models.tsx`, `app/src/components/settings/model-dialog.tsx`, `app/src/lib/models/` |

## Choosing a model per coworker

By default every coworker uses the person's default connection. Once a person has two or more, Settings
> Models shows a **Coworkers** section where each coworker can be pointed at a different one.

- Stored per person **and** per coworker (`bot_model_choices`, migration 0047), never per coworker
  alone: a coworker someone else built still runs on the key of whoever is talking to it.
- A choice disappears with the connection it names (the coworker falls back to the default), with the
  coworker, or with the person.
- Applies to the server's own agents (`RuntimeModel.connectionFor`) and to the managed bot (the
  `x-ark-model` header is minted per bot). A choice that cannot be opened is an error with a sentence,
  never a quiet fallback to the deployment's model.
- API: `GET /api/models/bots`, `PUT /api/models/bots/:botId` with `{ "connectionId": "<id>" | null }`.
  The coworker must be one the person can see, and the connection one of their own.

## Rules the code keeps

1. **A key is never sent to a browser.** The API returns `hasKey: true/false` and nothing else.
   Keys are encrypted with the deployment's `KEY_ENCRYPTION_KEY` and opened only where they are spent.
2. **Every model request goes through the guarded fetch** (`createAgentFetch`): private networks,
   redirects and odd ports are refused unless the deployment allows them. The check is repeated on
   every use, because a stored address can start to redirect.
3. **A hosted deployment cannot reach "this computer".** Local providers are marked unavailable
   there, with a sentence saying why, instead of failing as an unreachable address. The switch for
   running on a person's own machine is `AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS=true`; it will be
   renamed when the desktop packaging is done.
4. **Bots never hold keys.** A bot managed by the server (the default `agent-langgraph` bot) is
   given a short-lived, signed *grant* in the `x-ark-model` header. It sends its model requests to
   the server's model gateway (`/api/model-gateway`) with that grant; the gateway opens the person's
   key, calls the provider and streams the answer back. A bot that is started with
   `BOT_PROVIDER=none` has no model of its own and works only through a grant.
5. **Server-side built-in agents** use the person's connection directly (through the guarded fetch),
   falling back to the deployment's own model, then to the old error telling the person to open
   Settings > Models.
6. **Rate limit.** Tests are limited to 30 a minute per person, so the test button is no scanner.

## Verified

- Unit and integration tests for the catalogue, the store, the routes, the probe, the model object,
  the grant, the gateway and the run path (`server/tests/model-*.test.ts`,
  `managed-bot-model.integration.test.ts`), the bot (`agent-langgraph`), and the Models screen
  (`app/tests/models-screen.test.tsx`).
- A real built-in agent ran with tools on an OpenAI-compatible and on an Anthropic connection, and a
  real bot process with `BOT_PROVIDER=none` answered through the gateway.
- In a browser: add a model, test it (real Anthropic model list, 14 models found; a wrong key was
  refused with the sentence above and not echoed), save, reopen (key shown as saved, never the
  value), remove.
- Total spend: nothing. The runs used a fake local model; the only real call was the free model-list
  request.

## Not done yet

- **Usage metering** in the gateway (needed for the cloud add-on, Phase 4).
- **Plan sign-ins.** The old Claude and ChatGPT plan code is removed (see 04-llm-providers.md,
  Part 3). Still to do: Claude through the person's own Claude Code, ChatGPT through OpenAI's
  programme once approved, and a decision on xAI sign-in.
- **Local model helper.** Detect memory, suggest a model from `LOCAL_MODELS`, offer to download it.
- **Audit events** for adding, changing and removing a connection.
- **Google and xAI sign-in** needs Ark's own OAuth clients.
