# The free starter model

Written 2026-10-15. The decision, how it works in the code, how to run the server it talks to, and what
has not been done. Decided by the owner on 2026-10-15; the model was chosen by engineering.

## Why

A new person who has not added an API key gets "open Settings, then Models" on their first message. For
most people that is where the first five minutes end. The starter model is a small model we host
ourselves on hardware that costs nothing per request, so the first answer needs nothing from them. It
also makes the 30-day free trial cost us nothing.

## What it is, and is not

- A deployment-level model, **not** a person's connection. Nobody adds it and nobody can remove it. It
  answers for a person who has added no model of their own, **before** the deployment's own model.
- **Not a plan, a quota or a bill.** No usage count, no daily allowance, no price: there is no per-request
  cost to recover (owner decision, 2026-10-15).
- It has one limit that cannot be argued with: a small server answers one or two people at a time. So
  requests **queue in order**, and a request that would wait longer than the configured maximum (120 seconds by
  default) is turned away with a sentence and `Retry-After`, instead of hanging until some other timeout
  gives a worse message. That is a capacity rule, not a usage rule. It applies to everybody equally.
- A person who **has** added a model of their own never gets the starter model in its place. If theirs
  cannot be opened that is an error with a sentence, as before.

## The model, and the machine

**Gemma 4 E4B**, Q4_K_M (about 5 GB), served by llama.cpp. Chosen on 2026-10-15 over Gemma 4 E2B (faster,
weaker; the fallback), Qwen3.5 4B (the alternate if Gemma's tool calls prove unreliable), Qwen3.5 9B (too
slow) and gpt-oss-20b (needs about 14 GB and does not fit). The comparison is on the **Starter model**
sheet of the competitor workbook.

**Check before downloading:** the model card says Apache 2.0 (decision D6 requires a permissive licence;
Google's developer page says Apache 2.0 for Gemma 4) and that function calling is supported. The model
card has not been read yet. Weights only from Google's or the model owner's own Hugging Face page.

**The machine** is Oracle Cloud's Always Free Ampere A1 allowance: **2 OCPU and 12 GB** in total
(Oracle cut it from 4 OCPU and 24 GB in mid 2026), no GPU, in the account's **home region**, which is
chosen at sign-up and cannot be changed. Pick an EU region. Expectations, which are estimates and not
measurements: roughly 4 to 8 tokens a second for one answer, so a 150-word reply takes 30 to 60
seconds, and two people at once roughly halve it. It is for a first message and simple chat, not for
browser work or long multi-step jobs. The app must say so.

Oracle may reclaim an Always Free instance that is idle for 7 days (CPU p95, network and, on A1,
memory all under 20%). A resident model uses roughly 40 to 60% of 12 GB, which should keep it from
counting as idle; that is a reading of the rule, not a promise. Oracle has already cut this allowance
once, so the server is kept portable: a plain container or a handful of commands that run on any Arm or
x86 host, and the app says "the starter model is unavailable" instead of failing when it is down.

## How a message reaches it

```
person -> Ark server (needs sign-in) -> starter queue -> Oracle VM (llama.cpp) 
                ^                          one answer at a time, token added here
 bot ---- grant --+--> /api/model-gateway/openai/v1/* (grant names "ark-starter")
```

- `server/src/models/starter.ts`: the queue, the token, the health check. One instance per process,
  shared by everything below, so a single small machine is never asked for more than it can answer.
- `server/src/models/for-actor.ts`: a person with no connection gets the starter model, for the server's
  own agents (`createModelForActor`) and for the deployment's bot (`createModelHeaderForActor`: a grant
  that names the reserved connection id `ark-starter`; the bot never holds the operator's token).
- `server/src/models/gateway.ts`: a grant naming `ark-starter` is forwarded to the operator's address
  through the starter queue. Only the OpenAI dialect, and only the paths a model run needs.
- `GET /api/models/starter` (signed-in people only): `{ configured, state, model, active, waiting,
  concurrency, maxWaitSeconds }`. Says nothing of the address or the token.
- The operator's address is **not** put through the guard on addresses people type (private networks,
  redirects, odd ports): that guard exists for addresses somebody typed, and this one nobody typed.

## Settings

| Variable | Meaning | Default |
| --- | --- | --- |
| `ARK_STARTER_MODEL_URL` | OpenAI-compatible base address, ending in `/v1`. Unset: no starter model, nothing changes. Must be `https` in production. | unset |
| `ARK_STARTER_MODEL_TOKEN` | Bearer token the starter server expects. Secret. Never sent to a browser or a bot. | none |
| `ARK_STARTER_MODEL_NAME` | The model name the server serves. | `gemma-4-e4b` |
| `ARK_STARTER_MODEL_CONCURRENCY` | Answers at the same moment (1 to 16). One for the two-core machine. | `1` |
| `ARK_STARTER_MODEL_MAX_WAIT_SECONDS` | Longest a request waits for its turn (5 to 900). | `120` |

A token or a limit with no address stops the server at start, so a deployment cannot quietly offer a
model its operator believes it offers.

## Setting up the Oracle server

**Owner:** create the Oracle Cloud account in the company's name (Value Data IKE) and pick an EU home
region. Oracle's sign-up page could not be read when this was written, so whether a card or an
identity check is needed is unconfirmed.

**Engineering**, once there is an account:

1. Create an Always Free Ampere A1 instance, **2 OCPU and 12 GB**, Ubuntu aarch64. If Oracle answers
   "out of host capacity", retry or try another availability domain.
2. Build llama.cpp for Arm and download the Q4_K_M file of Gemma 4 E4B from the model owner's page.
3. Run its server on the loopback address only, with tool calls on and one slot:
   `llama-server -m <file>.gguf --alias gemma-4-e4b --host 127.0.0.1 --port 8080 --jinja --ctx-size 8192 --parallel 1 --threads 2 --api-key <token>`
   (flag names as of llama.cpp when this was written; check `--help` on the build you made).
4. Put a TLS reverse proxy in front (Caddy) and open **only** the proxy's port, **only** to the
   addresses Ark's servers call from. There is no cap on this model, so a public endpoint would be free
   compute for anybody on the internet.
5. Run it under systemd so it comes back after a reboot, and keep the model loaded.
6. Set the five variables above on the deployment and restart it.
7. **Measure** with `scripts/starter-model-benchmark.ts` (one, two and three people at once; Greek and
   English prompts; our bot prompt with tools) and write the numbers into the workbook's Starter model
   sheet. Choose E4B or the smaller E2B from the numbers: below about 3 tokens a second for one person
   is too slow.

**Before it is switched on for customers:** add Oracle Cloud as a sub-processor in the DPA and in
14-data-protection.md, say in the privacy notice that starter-model prompts are processed on Oracle in
the EU, and have the lawyer look at the DPA with that row in it.

## What has been verified

- The queue: one at a time, in order, held through the whole stream, given back on cancel, error, a
  failed connection and a body-less answer; a person who walks away leaves the line; a request that waits
  too long gets a sentence and `Retry-After`; two answers at once when the operator allows it. Mutating
  the code (releasing at the first byte; letting a caller's `Authorization` through) makes tests fail.
- Through a real HTTP server: the operator's token reaches it and the bot's grant never does; the person's
  own connection still goes to their own address; a model run on the starter really reaches the server;
  a down server and a busy server each produce their own sentence, and the sentence does not name the address.
- Settings: absent, defaults, every limit, a stray token, a password in the address, plain http in production.

## What has not been done

- **The Oracle server does not exist yet.** Nothing here has run against Gemma 4 E4B, and the speeds
  above are estimates. Tool calling on this model through llama.cpp is unproven.
- **The screen.** Settings > Models does not yet show the starter model or its queue (the endpoint is there),
  and the chat does not say "waiting, two ahead of you".
- **The desktop app.** A desktop install runs its own server and has no Ark account to sign in with, so
  it cannot be given the operator's token: that token would then sit on every customer's machine and,
  with no cap, be free compute for anyone who read it. A desktop needs the starter model through Ark's
  own cloud, with a sign-in (design open). For the Windows demo, the demo machine's own settings can
  carry the variables, because we are the operator there.
- **Per-bot choice of the starter model** (`bot_model_choices` holds connection rows only).
- **Usage metering** of it, which is deliberately absent.
