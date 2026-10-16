# The free starter model

Written 2026-10-15. The decision, how it works in the code, how to run the server it talks to, and what
has not been done. Decided by the owner on 2026-10-15; the model was chosen by engineering.

> **Update 2026-10-16.** The owner dropped Oracle Cloud's free tier (Oracle halved it to 2 OCPU and 12 GB in
> mid 2026, which made the model slow and left no room for more than one user at a time). The server code
> below does not depend on Oracle: it speaks to any OpenAI-compatible address. What changes is where the
> model runs. See "Where it runs, now" for the options and the direction chosen.

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

## The model

**Gemma 4 E4B**, Q4_K_M (about 5 GB), with **Gemma 4 E2B** (about 3 GB, faster and weaker) for computers
with less memory and as the fallback. Alternate if Gemma's tool calls prove unreliable: Qwen3.5 4B.
Too slow or too big for a small machine: Qwen3.5 9B and gpt-oss-20b (about 14 GB). The comparison is in the
competitor workbook of 2026-10-15.

**Check before downloading:** the model card says Apache 2.0 (decision D6 requires a permissive licence;
Google's developer page says Apache 2.0 for Gemma 4) and that function calling is supported. The model card
has not been read yet. Weights only from Google's or the model owner's own Hugging Face page.

## Where it runs, now

There is no free hosted model that has no ceiling and no catch. What was found on 2026-10-16:

| Option | Cost | The catch |
| --- | --- | --- |
| **On the customer's own computer** (llama.cpp, managed by the desktop app) | Nothing, for ever | Speed depends on the computer; needs about 8 GB of memory for E2B and about 12 GB for E4B. Private, works offline, no token to leak, no queue. |
| Oracle Always Free (the original plan) | Nothing | 2 OCPU and 12 GB since mid 2026, no GPU: roughly 4 to 8 tokens a second, one person at a time. Dropped by the owner. |
| Free hosted APIs: Groq, Cerebras, Cloudflare Workers AI | Nothing | One key means one shared allowance for all our customers (Groq about 200,000 tokens a day, Cloudflare 10,000 "neurons" a day); limits change; commercial terms vary. 04-llm-providers.md already ruled out a shared key. |
| Mistral's free tier (an EU provider) | Nothing | Reported to require opting in to training on prompts: not acceptable for customer data. |
| Hugging Face Spaces, free CPU | Nothing | Sleeps when idle, and Hugging Face points always-on use at paid hardware. Not for production. |
| Azure credits through Microsoft for Startups Founders Hub | Credits, not free for ever: reported as USD 1,000 for 90 days, up to about 5,000 within 180 days | Runs in West Europe beside everything else, but ends when the credits do. An application, with review time. |
| A machine the company already owns, behind a tunnel | Electricity | Uptime is a home or office connection. |

**Direction chosen (2026-10-16, engineering's recommendation, awaiting the owner's word on the hosted part):**

1. **Desktop: a managed local model.** This is the starter model for the main product. It matches decision D6
   (local and free by default, so a person pays Ark and nothing else) and removes the three problems of a
   hosted model for the desktop: no queue, no token on customers' computers, no per-request cost to anybody.
   The desktop app detects memory, suggests E2B or E4B, downloads a pinned llama.cpp and the weights with a
   checksum, runs it on the loopback address and registers it as the person's default connection.
2. **Web, phone and cloud: no hosted starter at launch.** A person there adds their own key, or uses the cloud
   add-on. A hosted starter can be added later from Azure credits if the owner applies to Founders Hub; the
   queue, gateway and status route built for it work unchanged against any OpenAI-compatible address.

## If a hosted starter is built later

Run llama.cpp's server on a machine we pay for or have credits on: `llama-server -m <file>.gguf --alias
gemma-4-e4b --host 127.0.0.1 --port 8080 --jinja --ctx-size 8192 --parallel 1 --threads <cores> --api-key <token>`
(flag names as of llama.cpp when this was written; check `--help`), behind a TLS reverse proxy open only to
Ark's servers, since the model has no cap and a public endpoint would be free compute for anybody. Set the five
variables above. Measure with `scripts/starter-model-benchmark.ts` before choosing E4B or E2B: below about 3
tokens a second for one person is too slow. Before it serves customers, add the host as a sub-processor in the
DPA and in 14-data-protection.md, and say so in the privacy notice.

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

- **No model server exists**, and nothing here has run against Gemma 4 E4B. Speeds are estimates. Tool calling on
  this model through llama.cpp is unproven.
- **The desktop's managed local model** (memory detection, pinned download with checksum, running and registering
  it) is the next piece for the starter model and is not started. It is the "local models with detection" item in
  05-build-plan.md, moved up to launch scope.
- **The screen.** Settings > Models does not yet show the starter model or its queue (the endpoint is there).
- **The desktop and a hosted starter.** A desktop must not be given a hosted model's token: with no cap, anyone who
  read it from an installed app would have free compute. A desktop reaches a hosted model only through Ark's own cloud,
  signed in (decided 2026-10-16: the desktop asks for an Ark account), after the first Azure deployment.
- **Per-bot choice of the starter model** (`bot_model_choices` holds connection rows only).
- **Usage metering** of it, which is deliberately absent.
